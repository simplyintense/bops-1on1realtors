import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { GATE_COOKIE, gateConfig, makeSession, type GateConfig } from "../../lib/gate.ts";
import { contentHashOf, dHashOf, hammingDistance, MEDIA_CAP_BYTES, MEDIA_RETENTION_DAYS, PHOTO_MAX_DISTANCE, photoLinked, photoLinks, type PhotoPost } from "../flow/listing-photos.ts";
import type { PostRecord } from "../flow/periskope.ts";
import { backfillMedia, mediaBytes, mediaOverCap, photoIndex, saveListingPhotos, storePhoto, sweepMedia } from "../node/listing-media.ts";
import { serveMedia } from "../node/media-route.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { syncFromJsonl } from "../node/search-store.ts";

// Invented data only: made-up agents, 555-style numbers, invented listings.
const DAY = 86_400_000;
const NOW = new Date("2026-11-15T12:00:00.000Z");
const AGENT_A = "18685550201@c.us";
const AGENT_B = "18685550202@c.us";
const STAFF = "kerry@1on1.example";
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example" };
const cfg = gateConfig(GATE) as GateConfig;

const root = () => mkdtempSync(join(tmpdir(), "listing-photos-"));

/** A deterministic smooth picture: the same seed is the same picture at any size, and different seeds differ clearly. */
async function picture(seed: number, size = 640): Promise<Buffer> {
  const r = (k: number) => (((Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453) % 1) + 1) % 1;
  const px = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const val = 128 + 70 * Math.sin((1 + 3 * r(1)) * 2 * Math.PI * u + r(2) * 6) + 60 * Math.cos((1 + 3 * r(3)) * 2 * Math.PI * v + r(4) * 6) + 40 * Math.sin((2 + 4 * r(5)) * 2 * Math.PI * (u + v) + r(6) * 6);
      const i = (y * size + x) * 3;
      px[i] = px[i + 1] = px[i + 2] = Math.max(0, Math.min(255, Math.round(val)));
    }
  }
  return sharp(px, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

/** A minimal stored post; the fields the tests don't set are left as the intake leaves them. */
function listingPost(messageId: string, over: Partial<PostRecord> = {}): PostRecord {
  return {
    messageId,
    chatId: "chat-a@g.us",
    sentAt: "2026-11-10T14:00:00.000Z",
    category: "listing_for_sale",
    cobroke: false,
    senderPhone: AGENT_A,
    senderName: null,
    firm: null,
    area: "Maraval",
    development: null,
    price: 1_000_000,
    currency: "USD",
    beds: 3,
    baths: 2,
    type: "house",
    listingType: "sale",
    intent: "buy",
    propertyClass: null,
    notes: null,
    originalText: "Three bed house in Maraval",
    set: "supply",
    ...over,
  } as PostRecord;
}

const HASH = "0f0f0f0f0f0f0f0f";
const photo = (over: Partial<PhotoPost> = {}): PhotoPost => ({
  messageId: "a",
  senderPhone: AGENT_A,
  category: "listing_for_sale",
  listingType: "sale",
  area: "Maraval",
  development: null,
  price: 1_000_000,
  currency: "USD",
  mediaHashes: [HASH],
  ...over,
});

test("dHash: 64 bits from a 9x8 grid, stable under a brightness shift, and a different picture gives a different hash", () => {
  const gray = Uint8Array.from({ length: 72 }, (_, i) => (i * 37) % 200);
  const hash = dHashOf(gray);
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.equal(dHashOf(gray), hash);
  assert.equal(dHashOf(gray.map((v) => v + 20)), hash, "adding brightness keeps every neighbour comparison");
  assert.notEqual(dHashOf(Uint8Array.from({ length: 72 }, (_, i) => (i * 91) % 200)), hash);
  assert.throws(() => dHashOf(new Uint8Array(10)));
});

test("Hamming distance counts differing bits; a malformed hash never matches", () => {
  assert.equal(hammingDistance(HASH, HASH), 0);
  assert.equal(hammingDistance("0000000000000000", "ffffffffffffffff"), 64);
  assert.equal(hammingDistance("0000000000000000", "0000000000000001"), 1);
  assert.equal(hammingDistance(HASH, "nothex"), 64);
});

test("a re-encoded, resized copy of a picture stays within the link threshold; a different picture does not", async () => {
  const big = await picture(1, 1200);
  const small = await sharp(big).resize(480).webp({ quality: 70 }).toBuffer();
  const grayOf = (buf: Buffer) => sharp(buf).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  const h = dHashOf(new Uint8Array(await grayOf(big)));
  assert.ok(hammingDistance(h, dHashOf(new Uint8Array(await grayOf(small)))) <= PHOTO_MAX_DISTANCE);
  const other = dHashOf(new Uint8Array(await grayOf(await picture(51, 1200))));
  assert.ok(hammingDistance(h, other) > PHOTO_MAX_DISTANCE);
});

test("photos link only when the hash is close and the facts agree: sale or rent, area or development, price within 15% or both unpriced", () => {
  const a = photo();
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B })), true, "exact hash, same facts, another sender");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B, mediaHashes: ["0f0f0f0f0f0f0f0c"] })), true, "two bits apart");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B, mediaHashes: ["f0f0f0f0f0f0f0f0"] })), false, "hashes differ");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B, price: 1_300_000 })), false, "price 30% apart");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B, price: 1_100_000 })), true, "price 10% apart");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B, price: null })), false, "one side unpriced");
  assert.equal(photoLinked({ ...a, price: null }, photo({ messageId: "b", senderPhone: AGENT_B, price: null })), true, "both unpriced");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B, currency: "TTD", price: 1_000_000 })), false, "different currency");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B, area: "St Clair", development: null })), false, "area differs");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B, area: "St Clair", development: "Trace" })), false, "area and development differ");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B, area: null, development: "Trace" })), false, "no shared place");
  assert.equal(photoLinked({ ...a, development: "Trace" }, photo({ messageId: "b", senderPhone: AGENT_B, area: null, development: "trace" })), true, "same development, area unset");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B, listingType: "rent" })), false, "sale against rent");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_A })), false, "the same sender is never a photo link");
  assert.equal(photoLinked(a, photo({ messageId: "b", senderPhone: AGENT_B, category: "listing_for_sale", mediaHashes: [] })), false, "no photo on one side");
});

test("photoLinks lists each linked supply post both ways, and only supply with photos", () => {
  const links = photoLinks([
    photo({ messageId: "a" }),
    photo({ messageId: "b", senderPhone: AGENT_B }),
    photo({ messageId: "c", senderPhone: AGENT_B, mediaHashes: ["f0f0f0f0f0f0f0f0"] }),
    photo({ messageId: "d", senderPhone: AGENT_B, category: "buyer_request" }),
  ]);
  assert.deepEqual(links.get("a"), ["b"]);
  assert.deepEqual(links.get("b"), ["a"]);
  assert.equal(links.has("c"), false);
  assert.equal(links.has("d"), false);
});

test("the same-sender fold is unchanged, and a photo match across senders is not merged into one record", () => {
  const row = (messageId: string, senderPhone: string) => ({
    messageId,
    chatId: "chat-a@g.us",
    groupName: "Test Group A",
    sentAt: `2026-11-0${messageId.endsWith("2") ? 2 : 1}T12:00:00.000Z`,
    category: "listing_for_sale",
    cobroke: false,
    senderPhone,
    senderName: "Test Agent",
    firm: null,
    area: "Maraval",
    development: null,
    price: 2_500_000,
    currency: "TTD",
    beds: 3,
    baths: 2,
    type: "house",
    listingType: "sale",
    intent: "buy",
    propertyClass: "sale",
    notes: null,
    originalText: "Three bed house in Maraval, asking 2.5m",
    set: "supply",
  });
  const write = (rows: object[]) => {
    const dir = root();
    writeFileSync(join(dir, "supply.jsonl"), rows.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    writeFileSync(join(dir, "demand.jsonl"), "", { mode: 0o600 });
    return dir;
  };
  const sameSender = syncFromJsonl(write([row("m-1", AGENT_A), row("m-2", AGENT_A)]), { force: true });
  assert.equal(sameSender.supply, 1, "same sender, identical listing: one record");
  assert.equal(sameSender.duplicatesFolded, 1);
  const crossSender = syncFromJsonl(write([row("m-1", AGENT_A), row("m-2", AGENT_B)]), { force: true });
  assert.equal(crossSender.supply, 2, "another sender's identical listing is not folded");
  assert.equal(crossSender.duplicatesFolded, 0);
});

test("a stored photo is a compressed WebP display (max 1280px) and thumb (max 320px) at 0600, named by the hash of the display bytes", async () => {
  const dir = root();
  const out = await storePhoto(dir, await picture(3, 2000));
  assert.ok("photo" in out);
  const { file, dhash, written } = out.photo;
  assert.equal(written, 2);
  assert.match(dhash, /^[0-9a-f]{16}$/);
  const hash = contentHashOf(file);
  assert.ok(hash);
  const display = readFileSync(join(dir, file));
  assert.equal(createHash("sha256").update(display).digest("hex"), hash);
  assert.equal((await sharp(display).metadata()).width, 1280);
  const thumbPath = join(dir, `media/${hash.slice(0, 2)}/${hash}-thumb.webp`);
  assert.equal((await sharp(readFileSync(thumbPath)).metadata()).width, 320);
  assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
});

test("the same picture is stored once: a second save reuses the files and writes nothing", async () => {
  const dir = root();
  const bytes = await picture(4);
  const first = await storePhoto(dir, bytes);
  const again = await storePhoto(dir, bytes);
  assert.ok("photo" in first && "photo" in again);
  assert.equal(again.photo.file, first.photo.file);
  assert.equal(again.photo.written, 0);
  const thumb = first.photo.file.replace(".webp", "-thumb.webp");
  assert.equal(mediaBytes(dir), statSync(join(dir, first.photo.file)).size + statSync(join(dir, thumb)).size, "no third file");
});

test("a non-image is not stored, and a failed or non-image download is counted without failing", async () => {
  const dir = root();
  assert.deepEqual(await storePhoto(dir, Buffer.from("not an image")), { skip: "nonImage" });
  const fetcher = async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/missing.jpg")) return new Response("gone", { status: 404 });
    if (u.endsWith("/clip.mp4")) return new Response(new Uint8Array(Buffer.from("0000001866747970", "hex")), { headers: { "content-type": "video/mp4" } });
    return new Response(new Uint8Array(await picture(5)), { headers: { "content-type": "image/jpeg" } });
  };
  const saved = await saveListingPhotos(dir, ["https://example.com/missing.jpg", "https://example.com/clip.mp4", "ftp://example.com/x.jpg", "https://example.com/ok.jpg"], fetcher as typeof fetch);
  assert.equal(saved.files.length, 1);
  assert.equal(saved.hashes.length, 1);
  assert.deepEqual(saved.skipped, ["failed", "nonImage", "failed"]);
});

test("the 2 GB cap: at or above it, no new photo is written and the index says so", async () => {
  const dir = root();
  mkdirSync(join(dir, "media", "ff"), { recursive: true });
  writeFileSync(join(dir, "media", "ff", "full.bin"), "");
  truncateSync(join(dir, "media", "ff", "full.bin"), MEDIA_CAP_BYTES);
  assert.equal(mediaOverCap(dir), true);
  const out = await storePhoto(dir, await picture(6));
  assert.deepEqual(out, { skip: "cap" });
  assert.equal(mediaBytes(dir), MEDIA_CAP_BYTES, "nothing new on disk");
  const store = new PeriskopeStore(dir);
  assert.equal(photoIndex(store).overCap, true);
});

test("retention: files untouched for 180 days are deleted, and the posts that lost them keep no photos", async () => {
  const dir = root();
  const store = new PeriskopeStore(dir);
  const old = await storePhoto(dir, await picture(10));
  const fresh = await storePhoto(dir, await picture(11));
  assert.ok("photo" in old && "photo" in fresh);
  store.addPost(listingPost("m-old", { mediaUrls: ["https://example.com/old.jpg"], mediaFiles: [old.photo.file], mediaHashes: [old.photo.dhash] }));
  store.addPost(listingPost("m-fresh", { mediaFiles: [fresh.photo.file], mediaHashes: [fresh.photo.dhash] }));
  for (const f of [fresh.photo.file, fresh.photo.file.replace(".webp", "-thumb.webp")]) utimesSync(join(dir, f), NOW, NOW);
  const stale = new Date(NOW.getTime() - (MEDIA_RETENTION_DAYS + 1) * DAY);
  utimesSync(join(dir, old.photo.file), stale, stale);
  utimesSync(join(dir, old.photo.file.replace(".webp", "-thumb.webp")), stale, stale);

  assert.equal(sweepMedia(store, NOW), 2, "the display and thumb of the old photo");
  assert.equal(existsSync(join(dir, old.photo.file)), false);
  assert.equal(store.post("m-old")?.mediaFiles, undefined);
  assert.equal(store.post("m-old")?.mediaHashes, undefined);
  assert.equal(store.post("m-old")?.mediaUrls?.length, 1, "the URL stays");
  assert.deepEqual(store.post("m-fresh")?.mediaFiles, [fresh.photo.file]);
  assert.equal(sweepMedia(store, NOW), 0, "a second sweep changes nothing");
});

test("backfill: old originals are recompressed into the layout, their folders removed, and a non-image or missing one is counted", async () => {
  const dir = root();
  const store = new PeriskopeStore(dir);
  const legacy = createHash("sha256").update("m-legacy").digest("hex").slice(0, 24);
  mkdirSync(join(dir, "media", legacy), { recursive: true });
  writeFileSync(join(dir, "media", legacy, "01.jpg"), await picture(12));
  const clip = createHash("sha256").update("m-clip").digest("hex").slice(0, 24);
  mkdirSync(join(dir, "media", clip), { recursive: true });
  writeFileSync(join(dir, "media", clip, "01.bin"), Buffer.from("0000001866747970", "hex"));
  store.addPost(listingPost("m-legacy", { mediaUrls: ["https://example.com/legacy.jpg"], mediaFiles: [`media/${legacy}/01.jpg`] }));
  store.addPost(listingPost("m-clip", { mediaUrls: ["https://example.com/clip.mp4"], mediaFiles: [`media/${clip}/01.bin`] }));
  store.addPost(listingPost("m-url", { mediaUrls: ["https://example.com/fresh.jpg"] }));
  store.addPost(listingPost("m-chat", { category: "buyer_request", mediaUrls: ["https://example.com/chat.jpg"] }));
  const fetcher = (async () => new Response(new Uint8Array(await picture(13)), { headers: { "content-type": "image/jpeg" } })) as typeof fetch;

  const counts = await backfillMedia(store, fetcher);
  assert.deepEqual(counts, { considered: 3, filesWritten: 4, hashes: 2, skipped: { nonImage: 1, cap: 0, failed: 0 } });
  const legacyPost = store.post("m-legacy");
  assert.equal(legacyPost?.mediaFiles?.length, 1);
  assert.ok(contentHashOf(legacyPost?.mediaFiles?.[0] ?? ""), "the new content-addressed name");
  assert.equal(existsSync(join(dir, "media", legacy)), false, "the original folder is gone");
  assert.equal(existsSync(join(dir, "media", clip)), false);
  assert.equal(store.post("m-clip")?.mediaFiles, undefined);
  assert.equal(store.post("m-url")?.mediaFiles?.length, 1);
  assert.equal(store.post("m-chat")?.mediaFiles, undefined, "only supply posts are backfilled");
  const offline = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  const again = await backfillMedia(store, offline);
  assert.deepEqual(again, { considered: 1, filesWritten: 0, hashes: 0, skipped: { nonImage: 0, cap: 0, failed: 1 } }, "only the video post, with one attempt at its URL");
});

test("photoIndex: each post's stored photos, and the other supply posts it shares a photo with", async () => {
  const dir = root();
  const store = new PeriskopeStore(dir);
  const pic = await storePhoto(dir, await picture(14));
  assert.ok("photo" in pic);
  const hash = contentHashOf(pic.photo.file);
  store.addPost(listingPost("m-a", { mediaFiles: [pic.photo.file], mediaHashes: [pic.photo.dhash] }));
  store.addPost(listingPost("m-b", { senderPhone: AGENT_B, mediaFiles: [pic.photo.file], mediaHashes: [pic.photo.dhash] }));
  store.addPost(listingPost("m-c", { senderPhone: AGENT_B, area: "St Clair", mediaFiles: [pic.photo.file], mediaHashes: [pic.photo.dhash] }));
  const index = photoIndex(store);
  assert.deepEqual(index.photos.get("m-a"), [hash]);
  assert.deepEqual(index.links.get("m-a"), ["m-b"], "same area, another sender");
  assert.equal(index.links.has("m-c"), false, "a different area is not linked");
  assert.equal(index.overCap, false);
});

test("the media route: 401 without a session when the gate is on; 200 with a staff session for a real file; 404 for a missing or traversal path", async () => {
  const dir = root();
  const env = { ...GATE, PERISKOPE_ROOT: dir };
  const pic = await storePhoto(dir, await picture(15));
  assert.ok("photo" in pic);
  const hash = contentHashOf(pic.photo.file) ?? "";
  const request = async (email: string | null) =>
    new Request(`https://bops.example/api/realty/media/${hash}`, { headers: email ? { cookie: `${GATE_COOKIE}=${await makeSession(email, cfg)}` } : {} });

  const signedOut = await serveMedia(await request(null), hash, false, env);
  assert.equal(signedOut.status, 401);
  assert.deepEqual(await signedOut.json(), { error: "Sign in first." });

  const ok = await serveMedia(await request(STAFF), hash, false, env);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/webp");
  assert.match(ok.headers.get("cache-control") ?? "", /immutable/);
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), readFileSync(join(dir, pic.photo.file)));

  const thumb = await serveMedia(await request(STAFF), hash, true, env);
  assert.equal(thumb.status, 200, "the thumb is served from the same hash");

  const missing = "a".repeat(64);
  assert.equal((await serveMedia(await request(STAFF), missing, false, env)).status, 404);
  assert.equal((await serveMedia(await request(STAFF), "../../../etc/passwd", false, env)).status, 404);
  assert.equal((await serveMedia(await request(STAFF), `${hash.slice(0, 2)}/../${hash}`, false, env)).status, 404);
});
