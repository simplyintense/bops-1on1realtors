import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import sharp from "sharp";
import { DAY_MS, type PostRecord } from "../flow/periskope.ts";
import { contentHashOf, dHashOf, DISPLAY_SIDE, isContentHash, isListingCategory, MEDIA_CAP_BYTES, MEDIA_RETENTION_DAYS, PHOTO_QUALITY, photoLinks, THUMB_SIDE } from "../flow/listing-photos.ts";
import type { PeriskopeStore } from "./periskope-store.ts";

/**
 * Listing photos on disk, under <periskope root>/media, content-addressed: media/<aa>/<sha256 of the display bytes>.webp, and
 * the thumb beside it as <sha256>-thumb.webp. Only listing (supply) posts keep photos; the originals are never kept. Failures
 * never fail an ingest: a photo that doesn't save is counted and the URL stays on the post.
 */

export type PhotoSkip = "nonImage" | "cap" | "failed";
export type StoredPhoto = { file: string; dhash: string; written: number };
export type PhotoOutcome = { photo: StoredPhoto } | { skip: "nonImage" | "cap" };
export type PhotosSaved = { files: string[]; hashes: string[]; written: number; skipped: PhotoSkip[] };

const MAX_DOWNLOAD = 25 * 1024 * 1024;
const DOWNLOAD_MS = 15_000;

/** Every file under a directory, at any depth. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Bytes under the media root, all folders (originals still on disk included). */
export function mediaBytes(root: string): number {
  return filesUnder(join(root, "media")).reduce((n, f) => n + statSync(f).size, 0);
}

export const mediaOverCap = (root: string): boolean => mediaBytes(root) >= MEDIA_CAP_BYTES;

async function encode(original: Buffer, side: number): Promise<{ bytes: Buffer; ext: "webp" | "jpg" }> {
  const base = sharp(original).rotate().resize({ width: side, height: side, fit: "inside", withoutEnlargement: true });
  try {
    return { bytes: await base.clone().webp({ quality: PHOTO_QUALITY }).toBuffer(), ext: "webp" };
  } catch {
    return { bytes: await base.clone().jpeg({ quality: PHOTO_QUALITY }).toBuffer(), ext: "jpg" };
  }
}

/**
 * Stores one image: its display and thumb, unless the same display bytes are already on disk (then only their times move, so
 * retention keeps them). A new photo is refused at the cap. Throws only when the bytes encode badly; a non-image is a skip.
 */
export async function storePhoto(root: string, original: Buffer): Promise<PhotoOutcome> {
  let gray: Buffer;
  try {
    gray = await sharp(original).rotate().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  } catch {
    return { skip: "nonImage" };
  }
  const display = await encode(original, DISPLAY_SIDE);
  const thumb = await encode(original, THUMB_SIDE);
  const hash = createHash("sha256").update(display.bytes).digest("hex");
  const dir = join(root, "media", hash.slice(0, 2));
  const displayName = `${hash}.${display.ext}`;
  const thumbName = `${hash}-thumb.${thumb.ext}`;
  const file = `media/${hash.slice(0, 2)}/${displayName}`;
  const dhash = dHashOf(new Uint8Array(gray));
  if (existsSync(join(dir, displayName)) && existsSync(join(dir, thumbName))) {
    const now = new Date();
    for (const name of [displayName, thumbName]) utimesSync(join(dir, name), now, now);
    return { photo: { file, dhash, written: 0 } };
  }
  if (mediaOverCap(root)) return { skip: "cap" };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, thumbName), thumb.bytes, { mode: 0o600 });
  writeFileSync(join(dir, displayName), display.bytes, { mode: 0o600 });
  return { photo: { file, dhash, written: 2 } };
}

/** One photo URL: its bytes if it is an image of a sane size; "nonImage" for anything else. Throws on a network or HTTP failure. */
async function download(url: string, fetcher: typeof fetch): Promise<Buffer | "nonImage"> {
  const r = await fetcher(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_MS) });
  if (!r.ok) throw new Error(`http ${r.status}`);
  if (!(r.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) return "nonImage";
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > MAX_DOWNLOAD) throw new Error("size");
  return buf;
}

/** Listing photos only: each http(s) URL is downloaded once and kept if it is an image. Never throws. */
export async function saveListingPhotos(root: string, urls: string[], fetcher: typeof fetch = fetch): Promise<PhotosSaved> {
  const out: PhotosSaved = { files: [], hashes: [], written: 0, skipped: [] };
  for (const url of urls) {
    try {
      if (!/^https?:\/\//i.test(url)) throw new Error("not http");
      const got = await download(url, fetcher);
      if (got === "nonImage") {
        out.skipped.push("nonImage");
        continue;
      }
      const r = await storePhoto(root, got);
      if ("skip" in r) {
        out.skipped.push(r.skip);
        continue;
      }
      out.files.push(r.photo.file);
      out.hashes.push(r.photo.dhash);
      out.written += r.photo.written;
    } catch {
      // A failed download is not a failed ingest; the URL stays on the post.
      out.skipped.push("failed");
    }
  }
  return out;
}

/** The stored display (or thumb) file for a content hash, or null. Only hashes shaped like a sha256 are looked up. */
export function mediaFile(root: string, hash: string, thumb: boolean): string | null {
  if (!isContentHash(hash)) return null;
  const media = resolve(root, "media");
  for (const ext of ["webp", "jpg"]) {
    const path = resolve(media, hash.slice(0, 2), thumb ? `${hash}-thumb.${ext}` : `${hash}.${ext}`);
    if (!path.startsWith(`${media}${sep}`)) return null;
    if (existsSync(path)) return path;
  }
  return null;
}

/** The response for GET /api/realty/media/<hash>[/thumb]: the bytes with a long cache header, or 404. Callers gate first. */
export function mediaReply(root: string, hash: string, thumb: boolean): Response {
  const path = mediaFile(root, hash, thumb);
  if (!path) return Response.json({ error: "Not found." }, { status: 404 });
  return new Response(readFileSync(path), {
    headers: {
      "content-type": path.endsWith(".webp") ? "image/webp" : "image/jpeg",
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Retention: deletes media files not touched for MEDIA_RETENTION_DAYS, then clears the photos of any post whose files are gone.
 * Returns how many files went. Idempotent.
 */
export function sweepMedia(store: PeriskopeStore, now: Date): number {
  const cutoff = now.getTime() - MEDIA_RETENTION_DAYS * DAY_MS;
  let removed = 0;
  for (const f of filesUnder(join(store.root, "media"))) {
    if (statSync(f).mtimeMs >= cutoff) continue;
    rmSync(f, { force: true });
    removed++;
  }
  const patches = new Map<string, Partial<PostRecord>>();
  for (const p of store.posts()) {
    if (!p.mediaFiles?.length || p.mediaFiles.every((f) => existsSync(join(store.root, f)))) continue;
    patches.set(p.messageId, { mediaFiles: undefined, mediaHashes: undefined });
  }
  store.patchPosts(patches);
  return removed;
}

export type PhotoIndex = {
  /** Message id -> the content hashes of its stored display photos. */
  photos: Map<string, string[]>;
  /** Message id -> the other supply posts it shares a photo with (listing-photos.ts). */
  links: Map<string, string[]>;
  overCap: boolean;
};

/** What the desk pages show: each post's stored photos, its photo links, and whether the cap is reached. */
export function photoIndex(store: PeriskopeStore): PhotoIndex {
  const posts = store.posts();
  const photos = new Map<string, string[]>();
  for (const p of posts) {
    const hashes = (p.mediaFiles ?? []).flatMap((f) => contentHashOf(f) ?? []);
    if (hashes.length) photos.set(p.messageId, hashes);
  }
  return { photos, links: photoLinks(posts), overCap: mediaOverCap(store.root) };
}

export type BackfillCounts = {
  considered: number;
  filesWritten: number;
  hashes: number;
  skipped: Record<PhotoSkip, number>;
};

/** Original files kept by the first version: media/<24 hex of the message id>/NN.ext. */
const ORIGINAL_DIR = /^[0-9a-f]{24}$/;

/**
 * Backfill, run once after deploy. (a) Each supply post's original files are recompressed into the content-addressed layout,
 * its hashes are written, and the old folder is removed (kept, to retry later, if the cap or a read error stopped a save). (b) A supply post with
 * URLs but no photos gets one download attempt per URL. Returns counts only.
 */
export async function backfillMedia(store: PeriskopeStore, fetcher: typeof fetch = fetch): Promise<BackfillCounts> {
  const root = store.root;
  const counts: BackfillCounts = { considered: 0, filesWritten: 0, hashes: 0, skipped: { nonImage: 0, cap: 0, failed: 0 } };
  const patches = new Map<string, Partial<PostRecord>>();
  const oldDirs: string[] = [];
  for (const p of store.posts()) {
    if (!isListingCategory(p.category)) continue;
    const originals = (p.mediaFiles ?? []).filter((f) => !contentHashOf(f));
    if (originals.length) {
      counts.considered++;
      const files: string[] = [];
      const hashes: string[] = [];
      let retry = false;
      for (const f of originals) {
        const path = join(root, f);
        const dir = dirname(path);
        if (!ORIGINAL_DIR.test(dir.split(sep).pop() ?? "") || !existsSync(path)) {
          counts.skipped.failed++;
          continue;
        }
        let r: PhotoOutcome;
        try {
          r = await storePhoto(root, readFileSync(path));
        } catch {
          counts.skipped.failed++;
          retry = true;
          continue;
        }
        if ("skip" in r) {
          counts.skipped[r.skip]++;
          retry ||= r.skip === "cap";
          continue;
        }
        files.push(r.photo.file);
        hashes.push(r.photo.dhash);
        counts.filesWritten += r.photo.written;
        counts.hashes++;
      }
      if (retry) continue;
      patches.set(p.messageId, { mediaFiles: files.length ? files : undefined, mediaHashes: hashes.length ? hashes : undefined });
      oldDirs.push(...originals.map((f) => dirname(join(root, f))));
      continue;
    }
    const urls = (p.mediaUrls ?? []).filter((u) => /^https?:\/\//i.test(u));
    if (p.mediaFiles?.length || !urls.length) continue;
    counts.considered++;
    const saved = await saveListingPhotos(root, urls, fetcher);
    for (const s of saved.skipped) counts.skipped[s]++;
    counts.filesWritten += saved.written;
    counts.hashes += saved.hashes.length;
    if (saved.files.length) patches.set(p.messageId, { mediaFiles: saved.files, mediaHashes: saved.hashes });
  }
  store.patchPosts(patches);
  for (const dir of new Set(oldDirs)) {
    if (dir.startsWith(join(root, "media") + sep)) rmSync(dir, { recursive: true, force: true });
  }
  return counts;
}
