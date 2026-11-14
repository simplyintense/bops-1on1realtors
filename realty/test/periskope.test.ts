import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LeadFlow } from "../flow/flow.ts";
import { PLACEHOLDER_BUSINESS_HOURS } from "../flow/hours.ts";
import { DryRunOutbox } from "../flow/outbox.ts";
import {
  containsPhoneNumber,
  decide,
  interpret,
  listingTypeOf,
  aliasItem,
  marketWriteConfigFromEnv,
  parseConsentPatch,
  postMarketItem,
  recordsDueForPurge,
  retentionFromEnv,
  toInquiry,
  toMarketGroupItem,
  type GroupConsent,
  type MarketIngestItem,
} from "../flow/periskope.ts";
import { handleWebhook, optOutSender, purgeExpiredPeriskope, setConsent, tickFlow, senderHashOf } from "../node/periskope-intake.ts";
import { loadFixtureCrm } from "../node/jsonl.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";

const KEY = "test-signing-key";
const CHAT = "120363000000000000@g.us";
/** The test group's name. The default world allowlists it by name (PERISKOPE_ALLOWED_GROUPS). */
const GROUP = "Co-broke Tobago";
const SENDER = "18685550201@c.us";
const LISTING_TEXT = "3 bed townhouse Maraval TT$1.2M co-broke 50/50";
const REQUEST_TEXT = "Client looking for 2 bed rental Westmoorings under 8k";
const OTHER_TEXT = "see you at the office";
const NOW = new Date("2026-11-13T20:00:00.000Z");

const sign = (raw: string) => createHmac("sha256", KEY).update(raw).digest("hex");

const envelope = (over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) => ({
  event_type: "message.created",
  org_id: "org-1",
  timestamp: "2026-11-13T20:00:00Z",
  data: {
    message_id: "false_" + CHAT + "_aaaaaaaa",
    chat_id: CHAT,
    chat_name: GROUP,
    sender_phone: SENDER,
    body: REQUEST_TEXT,
    from_me: false,
    message_type: "chat",
    has_media: false,
    media: null,
    ...dataOver,
  },
  ...over,
});

const okConsent = (over: Partial<GroupConsent> = {}): GroupConsent => ({
  chatId: CHAT,
  groupName: "Co-broke Tobago",
  noticePostedAt: "2026-11-01T12:00:00.000Z",
  adminOkBy: "Office admin",
  adminOkAt: "2026-11-02T12:00:00.000Z",
  active: true,
  ...over,
});

function world(env: Record<string, string | undefined> = {}, fetchReplies: { status?: number; body?: unknown; error?: Error }[] = []) {
  const root = mkdtempSync(join(tmpdir(), "periskope-"));
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const h = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    h.forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url: String(url), headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = fetchReplies.shift() ?? { status: 200, body: { id: 1, deduped: false } };
    if (next.error) throw next.error;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  };
  const baseEnv = { PERISKOPE_SIGNING_KEY: KEY, PERISKOPE_ALLOWED_GROUPS: GROUP, ...env };
  const opts = {
    root,
    env: baseEnv,
    now: () => NOW,
    crm: loadFixtureCrm(),
    fetch: fetcher,
  };
  return { root, calls, opts, store: () => new PeriskopeStore(root), post: (payload: unknown, sig?: string | null) => handleWebhook(Buffer.from(JSON.stringify(payload)), sig === undefined ? sign(JSON.stringify(payload)) : sig, opts) };
}

async function withConsent(w: ReturnType<typeof world>, over: Partial<GroupConsent> = {}) {
  return setConsent({ ...okConsent(over), ...over, chatId: over.chatId ?? CHAT }, w.opts);
}

/* ---------------- Classification ---------------- */

test("classifies a Trinidad co-broke listing and a buyer request, and drops chatter", () => {
  const listing = interpret(LISTING_TEXT);
  assert.equal(listing.kind, "cobroke_listing");
  assert.equal(listing.facts.beds, 3);
  assert.equal(listing.facts.type, "townhouse");
  assert.equal(listing.facts.area, "Maraval");
  assert.equal(listing.facts.budget?.max, 1_200_000);
  assert.equal(listing.facts.budget?.currency, "TTD");
  assert.equal(listingTypeOf(listing.facts), "sale");

  const request = interpret(REQUEST_TEXT);
  assert.equal(request.kind, "buyer_request");
  assert.equal(request.facts.beds, 2);
  assert.equal(request.facts.intent, "rent");
  assert.equal(request.facts.area, "Westmoorings");
  assert.equal(request.facts.budget?.max, 8000);
  assert.equal(request.facts.budget?.currency, "TTD");

  assert.equal(interpret(OTHER_TEXT).kind, "other");
});

test("the buyer-request inquiry never stores the raw body, a private name, or a body phone", () => {
  const i = interpret("Client looking for 2 bed rental Westmoorings under 8k. Buyer is Jane Doe, call 868-555-0199");
  const inq = toInquiry("m1", "+18685550201", i);
  assert.equal(inq.source, "periskope-group");
  assert.equal(inq.channel, "whatsapp");
  assert.equal(inq.name, "Co-broke agent");
  assert.equal(inq.phone, "+18685550201");
  assert.equal(inq.email, null);
  assert.doesNotMatch(inq.message, /Jane Doe|555-0199|Client looking/i);
  assert.match(inq.message, /2 bed/);
  assert.match(inq.message, /Westmoorings/);
});

/* ---------------- Signature and webhook gates ---------------- */

test("the webhook is 503 without a signing key, 401 with a missing or wrong signature, and 200 when it is valid", async () => {
  const w = world();
  const raw = JSON.stringify(envelope());
  assert.equal((await handleWebhook(Buffer.from(raw), sign(raw), { ...w.opts, env: {} })).status, 503);
  assert.equal((await w.post(envelope(), null)).status, 401);
  assert.equal((await w.post(envelope(), "deadbeef")).status, 401);
  const ok = await w.post(envelope());
  assert.equal(ok.status, 200);
  assert.match(String(ok.body.result), /ignored: group not accepted/);
});

test("a wrong event type, a message from us, media, and a 1:1 chat are ignored with 200", async () => {
  const w = world();
  await withConsent(w);
  assert.equal((await w.post(envelope({ event_type: "message.updated" }))).status, 200);
  assert.match(String((await w.post(envelope({}, { from_me: true }))).body.result), /sent by us/);
  assert.match(String((await w.post(envelope({}, { message_type: "image", has_media: true, body: "photo" }))).body.result), /not a text message/);
  assert.match(String((await w.post(envelope({}, { chat_id: "18685550201@c.us" }))).body.result), /dropped: not allowlisted/);
});

test("a group is ignored until both noticePostedAt and adminOkAt are set, and after staff set them it is accepted", async () => {
  const w = world();
  await setConsent({ chatId: CHAT, groupName: "Co-broke Tobago", noticePostedAt: "2026-11-01T12:00:00Z" }, w.opts);
  assert.match(String((await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-notice-only" }))).body.result), /group not accepted/);
  await setConsent({ chatId: CHAT, adminOkBy: "Office admin", adminOkAt: "2026-11-02T12:00:00Z" }, w.opts);
  const accepted = await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-listing-1" }));
  assert.equal(accepted.status, 200);
  assert.match(String(accepted.body.result), /listing recorded/);
});

test("PERISKOPE_ALLOWED_CHATS is an extra restriction when set, and an empty value does not block a consented group", async () => {
  const blocked = world({ PERISKOPE_ALLOWED_CHATS: "120363999@g.us" });
  await withConsent(blocked);
  assert.match(String((await blocked.post(envelope({}, { body: LISTING_TEXT, message_id: "m-extra" }))).body.result), /group not accepted/);
  const open = world({ PERISKOPE_ALLOWED_CHATS: "" });
  await withConsent(open);
  assert.match(String((await open.post(envelope({}, { body: LISTING_TEXT, message_id: "m-open" }))).body.result), /listing recorded/);
});

/* ---------------- Group allowlist (deny by default) ---------------- */

/** Listing and request rows only: setConsent also queues kind=group, which isn't a message. */
const sourceRows = (w: ReturnType<typeof world>) => w.store().market().filter((row) => row.item.kind === "listing" || row.item.kind === "request");

test("an allowlisted group is stored: its exact name, trimmed, in a |-separated list", async () => {
  const w = world({ PERISKOPE_ALLOWED_GROUPS: " Other group | Co-broke Tobago " });
  await withConsent(w);
  const r = await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-allowed" }));
  assert.match(String(r.body.result), /listing recorded/);
  assert.ok(w.store().isSeen("m-allowed"));
  assert.equal(w.store().market().filter((row) => row.item.kind === "listing").length, 1);
});

test("a message from another group is dropped before it is classified or stored, with 200", async () => {
  const w = world();
  await withConsent(w);
  const r = await w.post(envelope({}, { body: REQUEST_TEXT, message_id: "m-other-group", chat_name: "Area Registered Agents" }));
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "dropped: not allowlisted");
  assert.ok(!w.store().isSeen("m-other-group"), "not marked seen");
  assert.equal(w.store().leads().length, 0);
  assert.equal(w.store().live().length, 0);
  assert.equal(sourceRows(w).length, 0);
  assert.equal(w.calls.length, 0);
  const decision = decide({ payload: envelope({}, { body: REQUEST_TEXT, chat_name: "Area Registered Agents" }), at: NOW, env: { PERISKOPE_ALLOWED_GROUPS: GROUP }, optedOut: [], consentOf: () => okConsent(), seen: () => false });
  assert.deepEqual(decision, { action: "drop", reason: "other-group" });
});

test("a group with no name in the payload is dropped when only names are allowlisted", async () => {
  const w = world();
  await withConsent(w);
  const r = await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-no-name", chat_name: undefined }));
  assert.equal(r.body.result, "dropped: not allowlisted");
  assert.equal(sourceRows(w).length, 0);
});

test("PERISKOPE_ALLOWED_CHAT_IDS pins a group by chat id, and the name in chat.chat_name counts when chat_name is absent", async () => {
  const byId = world({ PERISKOPE_ALLOWED_GROUPS: "", PERISKOPE_ALLOWED_CHAT_IDS: CHAT });
  await withConsent(byId);
  assert.match(String((await byId.post(envelope({}, { body: LISTING_TEXT, message_id: "m-by-id", chat_name: "Renamed" }))).body.result), /listing recorded/);
  const byNested = world();
  await withConsent(byNested);
  const nested = await byNested.post(envelope({}, { body: LISTING_TEXT, message_id: "m-nested", chat_name: undefined, chat: { chat_name: GROUP } }));
  assert.match(String(nested.body.result), /listing recorded/);
});

test("a direct message is dropped the same way, even when its name matches", async () => {
  const w = world();
  await withConsent(w);
  const r = await w.post(envelope({}, { chat_id: "18685550201@c.us", body: LISTING_TEXT, message_id: "m-dm" }));
  assert.equal(r.body.result, "dropped: not allowlisted");
  assert.ok(!w.store().isSeen("m-dm"));
  assert.equal(sourceRows(w).length, 0);
});

test("an empty allowlist drops everything, including a consented group with a matching name", async () => {
  const w = world({ PERISKOPE_ALLOWED_GROUPS: "", PERISKOPE_ALLOWED_CHAT_IDS: "" });
  await withConsent(w);
  const r = await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-empty" }));
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "dropped: not allowlisted");
  assert.ok(!w.store().isSeen("m-empty"));
  assert.equal(sourceRows(w).length, 0);
  assert.equal(decide({ payload: envelope({}, { body: LISTING_TEXT }), at: NOW, env: {}, optedOut: [], consentOf: () => okConsent(), seen: () => false }).action, "drop");
});

test("a second delivery of the same message_id is 200 and does not create another record", async () => {
  const w = world();
  await withConsent(w);
  const first = await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-dupe" }));
  const second = await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-dupe" }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(String(second.body.result), /already seen/);
  assert.equal(w.store().market().filter((r) => r.item.kind === "listing").length, 1);
});

/* ---------------- Flow and outbox ---------------- */

test("a buyer request reaches the lead flow as a WhatsApp / periskope-group lead, with no raw text stored", async () => {
  const w = world();
  await withConsent(w);
  const r = await w.post(envelope({}, { body: REQUEST_TEXT, message_id: "m-req-1" }));
  assert.equal(r.status, 200);
  assert.match(String(r.body.result), /buyer request taken as L/);
  const snap = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(w.root, "flow-state.json"), "utf8")));
  assert.equal(snap.leads.length, 1);
  const inq = snap.leads[0].inquiry;
  assert.equal(inq.source, "periskope-group");
  assert.equal(inq.channel, "whatsapp");
  assert.doesNotMatch(inq.message, /Client looking|under 8k/i);
  assert.match(inq.message, /Westmoorings/);
  const queued = w.store().market().filter((row) => row.item.kind === "request");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].item.kind, "request");
  if (queued[0].item.kind === "request") {
    assert.equal(queued[0].item.group, CHAT);
    assert.equal(queued[0].item.source, "whatsapp");
    assert.equal(queued[0].item.beds, 2);
    assert.equal(queued[0].item.area, "Westmoorings");
    assert.equal(queued[0].item.listingType, "rent");
    assert.equal(queued[0].item.priceMax, 8000);
    assert.equal("consent" in queued[0].item, false);
  }
});

test("a co-broke listing is queued as kind=listing with no consent field, and chatter is not stored", async () => {
  const w = world();
  await withConsent(w);
  await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-list-1" }));
  await w.post(envelope({}, { body: OTHER_TEXT, message_id: "m-other-1" }));
  const listings = w.store().market().filter((r) => r.item.kind === "listing");
  assert.equal(listings.length, 1);
  const item = listings[0].item;
  assert.equal(item.kind, "listing");
  if (item.kind === "listing") {
    assert.equal(item.group, CHAT);
    assert.equal(item.beds, 3);
    assert.equal(item.area, "Maraval");
    assert.equal(item.propertyType, "townhouse");
    assert.equal(item.price, 1_200_000);
    assert.equal(item.currency, "TTD");
    assert.equal(item.listingType, "sale");
    assert.equal("consent" in item, false);
    assert.doesNotMatch(item.notes ?? "", /50\/50|co-broke/i);
  }
  assert.equal(w.store().seenRows().filter((s) => s.id === "m-other-1")[0]?.kind, "other");
  assert.ok(!JSON.stringify(w.store().market()).includes(OTHER_TEXT));
});

/* ---------------- Consent, revoke, adminOkBy ---------------- */

test("adminOkBy is rejected when it is a phone number, and accepted as a business name or role", () => {
  assert.equal(containsPhoneNumber("Office admin"), false);
  assert.equal(containsPhoneNumber("868-555-0201"), true);
  const bad = parseConsentPatch({ chatId: CHAT, adminOkBy: "868-555-0201" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /phone/);
  const good = parseConsentPatch({ chatId: CHAT, adminOkBy: "Office admin" });
  assert.equal(good.ok, true);
});

test("completing consent queues kind=group with the chat_id as group, and revoke sends active: false", async () => {
  const w = world({
    ONEON1_MARKET_WRITE_URL: "https://market.example/functions/v1/market-ingest",
    ONEON1_MARKET_INGEST_TOKEN: "ingest-token",
  }, [
    { status: 200, body: { group: CHAT, active: true, adminOk: true } },
    { status: 200, body: { group: CHAT, active: false, adminOk: true } },
  ]);
  await setConsent({ chatId: CHAT, groupName: "Co-broke Tobago", noticePostedAt: "2026-11-01T12:00:00Z" }, w.opts);
  assert.equal(w.calls.length, 0, "incomplete consent is not posted");
  await setConsent({ chatId: CHAT, adminOkBy: "Office admin", adminOkAt: "2026-11-02T12:00:00Z" }, w.opts);
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].headers.authorization, "Bearer ingest-token");
  assert.deepEqual(w.calls[0].body, {
    kind: "group",
    group: CHAT,
    name: "Co-broke Tobago",
    noticePostedAt: "2026-11-01T12:00:00.000Z",
    adminOkAt: "2026-11-02T12:00:00.000Z",
    adminOkBy: "Office admin",
    active: true,
  });
  await setConsent({ chatId: CHAT, active: false }, w.opts);
  assert.equal(w.calls.length, 2);
  assert.equal((w.calls[1].body as { active: boolean }).active, false);
  assert.equal((w.calls[1].body as { kind: string }).kind, "group");
  assert.equal((w.calls[1].body as { group: string }).group, CHAT);
  assert.ok(!("adminOkAt" in (w.calls[1].body as object) && (w.calls[1].body as { adminOkAt: unknown }).adminOkAt === null));
  const ignored = await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-revoked" }));
  assert.match(String(ignored.body.result), /group not accepted/);
});

/* ---------------- Opt-out ---------------- */

test("an opted-out sender is dropped before parse, and opting out deletes stored leads, listings and seen rows", async () => {
  const w = world();
  await withConsent(w);
  await w.post(envelope({}, { body: REQUEST_TEXT, message_id: "m-opt-req" }));
  await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-opt-list" }));
  assert.ok(w.store().leads().length >= 1);
  assert.ok(w.store().market().some((r) => r.item.kind === "listing"));
  const result = await optOutSender("+18685550201", w.opts);
  assert.equal(result.leads, 1);
  assert.ok(result.market >= 1);
  assert.ok(result.seen >= 1);
  assert.equal(w.store().leads().length, 0);
  assert.equal(w.store().market().filter((r) => r.item.kind === "listing" || r.item.kind === "request").length, 0);
  assert.ok(w.store().market().some((r) => r.item.kind === "optout"));
  const later = await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-after-opt" }));
  assert.match(String(later.body.result), /opted out/);
  assert.ok(!w.store().isSeen("m-after-opt"), "an ignored opted-out message is not parsed or marked seen");
});

/* ---------------- Adapter ---------------- */

test("the adapter is off unless both the write URL and the ingest token are set", () => {
  assert.equal(marketWriteConfigFromEnv({}), null);
  assert.equal(marketWriteConfigFromEnv({ ONEON1_MARKET_WRITE_URL: "https://market.example/ingest" }), null);
  assert.equal(marketWriteConfigFromEnv({ ONEON1_MARKET_INGEST_TOKEN: "tok" }), null);
  assert.deepEqual(marketWriteConfigFromEnv({ ONEON1_MARKET_WRITE_URL: "https://market.example/ingest", ONEON1_MARKET_INGEST_TOKEN: "tok" }), {
    url: "https://market.example/ingest",
    token: "tok",
  });
});

test("a successful listing post uses the bearer token and returns id and deduped; a 403 is not retried; a network error stays pending", async () => {
  const cfg = { url: "https://market.example/functions/v1/market-ingest", token: "ingest-token" };
  const item: MarketIngestItem = {
    kind: "listing",
    sourceMessageId: "m1",
    source: "whatsapp",
    group: CHAT,
    agency: "Co-broke agent",
    agencyPhone: "+18685550201",
    seenAt: NOW.toISOString(),
    currency: "TTD",
    area: "Maraval",
    listingType: "sale",
    price: 1_200_000,
    beds: 3,
  };
  const calls: unknown[] = [];
  const ok = await postMarketItem(cfg, item, async (url, init) => {
    calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: 99, deduped: true }), { status: 200 });
  });
  assert.deepEqual(ok, { ok: true, kind: "source", id: 99, deduped: true });
  assert.equal((calls[0] as { auth: string }).auth, "Bearer ingest-token");
  assert.equal("consent" in ((calls[0] as { body: object }).body), false);

  const forbidden = await postMarketItem(cfg, item, async () => new Response(JSON.stringify({ error: "not_allowlisted" }), { status: 403 }));
  assert.deepEqual(forbidden, { ok: false, retry: false, error: "not_allowlisted", status: 403 });
  const opted = await postMarketItem(cfg, item, async () => new Response(JSON.stringify({ error: "opted_out" }), { status: 403 }));
  assert.deepEqual(opted, { ok: false, retry: false, error: "opted_out", status: 403 });
  const down = await postMarketItem(cfg, item, async () => {
    throw new Error("ECONNRESET");
  });
  assert.deepEqual(down, { ok: false, retry: true, error: "network" });

  const group = await postMarketItem({ url: cfg.url, token: cfg.token }, toMarketGroupItem(okConsent()), async () => new Response(JSON.stringify({ group: CHAT, active: true, adminOk: true }), { status: 200 }));
  assert.deepEqual(group, { ok: true, kind: "group", group: CHAT, active: true, adminOk: true });
});

test("a staff alias is posted as the flat { kind: 'alias', alias, canonical } body, and comes back ok as kind alias", async () => {
  const cfg = { url: "https://market.example/functions/v1/market-ingest", token: "ingest-token" };
  const sent: unknown[] = [];
  const ok = await postMarketItem(cfg, aliasItem("Westmoring", "Westmoorings"), async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.deepEqual(ok, { ok: true, kind: "alias" });
  assert.deepEqual(sent, [{ kind: "alias", alias: "Westmoring", canonical: "Westmoorings" }]);
  const invalid = await postMarketItem(cfg, aliasItem("", "Westmoorings"), async () => new Response(JSON.stringify({ error: "bad" }), { status: 400 }));
  assert.deepEqual(invalid, { ok: false, retry: false, error: "invalid", status: 400 });
});

test("when the adapter is on, a listing is posted once; a 403 is recorded as rejected and not retried on tick", async () => {
  const w = world({
    ONEON1_MARKET_WRITE_URL: "https://market.example/functions/v1/market-ingest",
    ONEON1_MARKET_INGEST_TOKEN: "ingest-token",
  }, [
    { status: 200, body: { group: CHAT, active: true, adminOk: true } },
    { status: 403, body: { error: "not_allowlisted" } },
  ]);
  await withConsent(w);
  await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-403" }));
  const rows = w.store().market().filter((r) => r.item.kind === "listing");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "rejected");
  assert.equal(rows[0].lastError, "not_allowlisted");
  const before = w.calls.length;
  await tickFlow(w.opts);
  assert.equal(w.calls.length, before, "a rejected 403 is not retried");
});

test("a network error stays pending and is retried once on tick, not inline", async () => {
  const w = world({
    ONEON1_MARKET_WRITE_URL: "https://market.example/functions/v1/market-ingest",
    ONEON1_MARKET_INGEST_TOKEN: "ingest-token",
  }, [
    { status: 200, body: { group: CHAT, active: true, adminOk: true } },
    { error: new Error("ECONNRESET") },
    { status: 200, body: { id: 7, deduped: false } },
  ]);
  await withConsent(w);
  await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-net" }));
  const pending = w.store().market().filter((r) => r.item.kind === "listing");
  assert.equal(pending[0].status, "pending");
  assert.equal(w.calls.length, 2, "group + one listing attempt, no inline retry");
  await tickFlow(w.opts);
  const after = w.store().market().find((r) => r.item.kind === "listing");
  assert.equal(after?.status, "sent");
  assert.equal(after?.remoteId, 7);
  assert.equal(w.calls.length, 3);
});

test("with the adapter off, items are recorded and nothing is fetched", async () => {
  const w = world();
  await withConsent(w);
  await w.post(envelope({}, { body: LISTING_TEXT, message_id: "m-dry" }));
  assert.equal(w.calls.length, 0);
  assert.equal(w.store().market().filter((r) => r.item.kind === "listing")[0]?.status, "pending");
});

/* ---------------- Retention and tick ---------------- */

test("retention defaults are 60 days for requests and 90 for listings, and honour the two env vars", () => {
  assert.deepEqual(retentionFromEnv({}), { requestDays: 60, listingDays: 90 });
  assert.deepEqual(retentionFromEnv({ PERISKOPE_REQUEST_RETENTION_DAYS: "30", PERISKOPE_LISTING_RETENTION_DAYS: "120" }), { requestDays: 30, listingDays: 120 });
  const now = new Date("2026-11-13T00:00:00Z");
  const rows = [
    { id: "old", receivedAt: "2026-08-01T00:00:00Z" },
    { id: "new", receivedAt: "2026-11-01T00:00:00Z" },
  ];
  assert.deepEqual(recordsDueForPurge(rows, now, 60).map((r) => r.id), ["old"]);
});

test("purge drops buyer requests older than 60 days and listings older than 90, and keeps newer ones; tick runs it", async () => {
  const w = world();
  await withConsent(w);
  const store = w.store();
  store.addLead({ leadId: "L-old", messageId: "old-req", senderPhone: "+18685550201", receivedAt: "2026-08-01T00:00:00.000Z" });
  store.addLead({ leadId: "L-new", messageId: "new-req", senderPhone: "+18685550201", receivedAt: "2026-11-01T00:00:00.000Z" });
  store.enqueueMarket(
    { kind: "listing", sourceMessageId: "old-list", source: "whatsapp", group: CHAT, agency: "Co-broke agent", seenAt: "2026-07-01T00:00:00.000Z", currency: "TTD", area: "Maraval", listingType: "sale" },
    "2026-07-01T00:00:00.000Z",
  );
  store.enqueueMarket(
    { kind: "listing", sourceMessageId: "new-list", source: "whatsapp", group: CHAT, agency: "Co-broke agent", seenAt: "2026-11-01T00:00:00.000Z", currency: "TTD", area: "Maraval", listingType: "sale" },
    "2026-11-01T00:00:00.000Z",
  );
  store.markSeen({ id: "old-req", senderPhone: "+18685550201", kind: "buyer_request", at: "2026-08-01T00:00:00.000Z" });
  store.markSeen({ id: "new-req", senderPhone: "+18685550201", kind: "buyer_request", at: "2026-11-01T00:00:00.000Z" });
  store.markSeen({ id: "old-list", senderPhone: "+18685550201", kind: "cobroke_listing", at: "2026-07-01T00:00:00.000Z" });
  const purged = purgeExpiredPeriskope(store, NOW, w.opts.env);
  assert.equal(purged.leads, 1);
  assert.equal(purged.leadIds[0], "L-old");
  assert.equal(purged.market, 1);
  assert.equal(store.leads().map((l) => l.leadId).join(), "L-new");
  const left = store.market().filter((r) => r.item.kind === "listing");
  assert.equal(left.length, 1);
  assert.equal(left[0].item.kind === "listing" && left[0].item.sourceMessageId, "new-list");
  assert.ok(!store.isSeen("old-req"));
  assert.ok(store.isSeen("new-req"));

  let ticked = 0;
  const flow = new LeadFlow({
    crm: loadFixtureCrm(),
    clock: () => NOW,
    outbox: new DryRunOutbox({ clock: () => NOW }),
    market: null,
    timeoutMs: 15 * 60_000,
    hours: PLACEHOLDER_BUSINESS_HOURS,
    admin: { name: "Admin", address: "admin@example.com" },
    onTick: () => {
      ticked += 1;
    },
  });
  await flow.tick();
  assert.equal(ticked, 1);
});

test("senderHashOf is a stable sha256 hex of the number", () => {
  assert.equal(senderHashOf("+18685550201").length, 64);
  assert.equal(senderHashOf("+18685550201"), senderHashOf("+18685550201"));
});

