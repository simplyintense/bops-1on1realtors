import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_NOTES_MAX, AGENT_ROW_KEYS, agentRow, agentSearch, agentSnapshot, bearerOk, deskPostUrl, externalRow, hitDate, inDateRange, mergeExternal, sameListing, sameSecret, snapshotGroups, type AgentRequest, type Env, type ListingKey } from "../node/agent-search.ts";
import type { DeskCriteria, DeskResult } from "../flow/market-desk.ts";
import type { CoBrokeHit } from "../flow/market-search.ts";
import { GATE_OPEN_PATHS } from "../../lib/gate.ts";
import { PeriskopeStore, requestIdOf } from "../node/periskope-store.ts";
import { withSearchStore, type SearchRow } from "../node/search-store.ts";

// Invented data only: made-up agents, 555-style numbers, invented listings, groups, chats and text.
const SENDER = "+18685550101";
const SENDER_DIGITS = "18685550101";
const TEXT_MARK = "Invented ZEBRA listing text";
const GROUP_MARK = "Invented HERON Group";
const CHAT_MARK = "heron-chat-0001@g.us";
const TOKEN = "test-token-not-a-secret-0123456789";
const ENV: Env = { BOPS_MCP_TOKEN: TOKEN };
const AUTH = { authorization: `Bearer ${TOKEN}` };
const DESK = "https://bop.1on1realtors.com";
// No network in this file: the market is always a fake, and any real fetch is a failure.
globalThis.fetch = (async () => {
  throw new Error("network is not allowed in tests");
}) as typeof fetch;

function post(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: `msg-${i}`,
    chatId: CHAT_MARK,
    groupName: GROUP_MARK,
    sentAt: `2026-11-${String(10 + (i % 10)).padStart(2, "0")}T12:00:00.000Z`,
    category: "listing_for_sale",
    cobroke: false,
    senderPhone: SENDER,
    senderName: "Test Agent",
    firm: "Test Realty",
    area: "Maraval",
    development: null,
    price: 1_000_000 + i * 100_000,
    currency: "TTD",
    beds: 3,
    baths: 2,
    type: "house",
    listingType: "sale",
    intent: "buy",
    propertyClass: "sale",
    notes: null,
    originalText: `${TEXT_MARK} house ${i}`,
    set: "supply",
    ...over,
  };
}

function world(supply: Record<string, unknown>[], demand: Record<string, unknown>[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "agent-search-"));
  const lines = (rows: Record<string, unknown>[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");
  writeFileSync(join(root, "supply.jsonl"), lines(supply), { mode: 0o600 });
  writeFileSync(join(root, "demand.jsonl"), lines(demand), { mode: 0o600 });
  return root;
}

const req = (query = "", extra: Partial<AgentRequest> = {}): AgentRequest => ({ authorization: `Bearer ${TOKEN}`, params: new URLSearchParams(query), ...extra });

function storeRow(over: Partial<SearchRow> = {}): SearchRow {
  return {
    id: "rec-1",
    tab: "supply",
    kind: "supply",
    senderPhone: SENDER,
    senderName: "Test Agent",
    firm: "Test Realty",
    category: "listing_for_sale",
    chatId: CHAT_MARK,
    firstSentAt: "2026-11-10T12:00:00.000Z",
    lastSentAt: "2026-11-11T12:00:00.000Z",
    timesSeen: 2,
    groups: [GROUP_MARK],
    messageIds: ["msg-1", "msg-2"],
    area: "Maraval",
    development: null,
    price: 2_000_000,
    currency: "TTD",
    beds: 3,
    baths: 2,
    type: "house",
    listingType: "sale",
    intent: "buy",
    propertyClass: "sale",
    notes: "Quiet street",
    originalText: `${TEXT_MARK} house`,
    explanation: "owner note",
    explainedAt: "2026-11-12T00:00:00.000Z",
    status: null,
    priority: null,
    ...over,
  };
}

const sortedKeys = (o: object) => Object.keys(o).sort();
const rowsOf = (body: Record<string, unknown>) => body.rows as Record<string, unknown>[];

/** Every key in a value, at any depth. */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

/** Keys that must never reach an agent, in any row: the original text, the group and chat, the message ids, the owner's fields. */
const FORBIDDEN_ROW_KEYS = ["originalText", "groups", "groupName", "chatId", "messageIds", "explanation", "explainedAt", "status", "priority", "category", "tab", "redacted", "full"];

/* ---------------- auth ---------------- */

test("401 with no header, a wrong token, a blank or non-bearer header, and when BOPS_MCP_TOKEN is unset or blank", async () => {
  const root = world([post(1)]);
  for (const authorization of [null, "", "Bearer ", "Bearer wrong-token", `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN} extra`]) {
    const r = await agentSearch(req("", { authorization }), root, ENV);
    assert.equal(r.status, 401, `header ${authorization}`);
    assert.deepEqual(r.body, { error: "Unauthorized." });
  }
  assert.equal((await agentSearch(req(), root, {})).status, 401, "env unset");
  assert.equal((await agentSearch(req(), root, { BOPS_MCP_TOKEN: "   " })).status, 401, "env blank");
  assert.equal(agentSnapshot(req(), root, {}).status, 401, "snapshot: env unset");
  assert.equal(agentSnapshot(req("", { authorization: null }), root, ENV).status, 401, "snapshot: no header");
  assert.equal(agentSnapshot(req("", { authorization: "Bearer wrong" }), root, ENV).status, 401, "snapshot: wrong token");
});

test("a 401 never says what was searched: no rows, no counts", async () => {
  const root = world([post(1)]);
  const r = await agentSearch(req("", { authorization: "Bearer nope" }), root, ENV);
  assert.deepEqual(Object.keys(r.body), ["error"]);
});

test("bearerOk: the right token passes, with or without spare spaces around it", async () => {
  assert.equal(bearerOk(`Bearer ${TOKEN}`, ENV), true);
  assert.equal(bearerOk(`bearer ${TOKEN}`, ENV), true, "scheme is case-insensitive");
  assert.equal(bearerOk(`Bearer  ${TOKEN}  `, ENV), true);
  assert.equal(bearerOk(`Bearer ${TOKEN}x`, ENV), false);
});

test("sameSecret: equal secrets match; different lengths and different text are a plain no, never a throw", async () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abcd"), false, "a shorter guess");
  assert.equal(sameSecret("abcd", "abc"), false, "a longer guess");
  assert.equal(sameSecret("", "abc"), false);
  assert.equal(sameSecret("abd", "abc"), false, "same length, different");
});

/* ---------------- WhatsApp rows ---------------- */

test("agentRow keeps exactly the allow-list, plus source and deskUrl", async () => {
  const out = agentRow(storeRow(), DESK);
  assert.deepEqual(sortedKeys(out), [...AGENT_ROW_KEYS, "source", "deskUrl"].sort());
  assert.equal(out.source, "whatsapp");
  assert.equal(out.area, "Maraval");
  assert.equal(out.price, 2_000_000);
  assert.equal(out.firm, "Test Realty");
});

test("agentRow carries the sender, the dates and the times seen", async () => {
  const out = agentRow(storeRow(), DESK);
  assert.equal(out.senderName, "Test Agent");
  assert.equal(out.senderPhone, SENDER);
  assert.equal(out.firstSentAt, "2026-11-10T12:00:00.000Z");
  assert.equal(out.lastSentAt, "2026-11-11T12:00:00.000Z");
  assert.equal(out.timesSeen, 2);
});

test("agentRow never carries the original text, the group or group name, the chat, the message ids, the explanation, status, priority or category", async () => {
  const out = agentRow(storeRow({ status: "parked", priority: "low" }), DESK) as unknown as Record<string, unknown>;
  for (const k of ["originalText", "groups", "chatId", "messageIds", "explanation", "explainedAt", "status", "priority", "category", "tab"]) {
    assert.equal(k in out, false, k);
  }
  assert.equal(JSON.stringify(out).includes(TEXT_MARK), false, "no original text");
  assert.equal(JSON.stringify(out).includes(GROUP_MARK), false, "no group name");
  assert.equal(JSON.stringify(out).includes(CHAT_MARK), false, "no chat id");
});

test("agentRow clips long notes to the max and passes short notes, numbers included, as they are", async () => {
  const long = agentRow(storeRow({ notes: "x".repeat(400) }), DESK);
  assert.equal(long.notes?.length, AGENT_NOTES_MAX);
  assert.equal(long.notes?.endsWith("…"), true);
  const short = agentRow(storeRow({ notes: "Call 868 555 0101 after six", firm: "+1 (868) 555-0199" }), DESK);
  assert.equal(short.notes, "Call 868 555 0101 after six", "notes are not scrubbed");
  assert.equal(short.firm, "+1 (868) 555-0199", "the firm is not scrubbed");
  assert.equal(agentRow(storeRow({ notes: null }), DESK).notes, null);
});

test("a search returns the sender's name and phone, and never the text, group, chat or message ids", async () => {
  const root = world([post(1), post(2)]);
  const r = await agentSearch(req("kind=supply&source=whatsapp"), root, ENV);
  assert.equal(r.status, 200);
  const rows = rowsOf(r.body);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].senderPhone, SENDER, "the phone is returned");
  assert.equal(rows[0].senderName, "Test Agent", "the name is returned");
  const json = JSON.stringify(r.body);
  assert.equal(json.includes(SENDER_DIGITS), true, "the phone is in the reply");
  assert.equal(json.includes(TEXT_MARK), false, "no original text");
  assert.equal(json.includes(GROUP_MARK), false, "no group name");
  assert.equal(json.includes(CHAT_MARK), false, "no chat id");
  assert.equal(json.includes("msg-1"), false, "no message id");
  assert.equal(json.includes("msg-2"), false, "no message id");
  for (const row of rows) {
    for (const k of FORBIDDEN_ROW_KEYS) assert.equal(k in row, false, `${k} is in a row`);
  }
  assert.equal(allKeys(rows).has("groups"), false);
});

test("the search reply: no forbidden key anywhere in the rows, with or without external listings", async () => {
  const root = world([post(1, { area: "Maraval" })], [post(2)]);
  const m = fakeMarket([hit()]);
  for (const query of ["area=Maraval", "area=Maraval&source=whatsapp", "kind=demand"]) {
    const r = await agentSearch(req(query), root, ENV, { market: m });
    assert.equal(r.status, 200, query);
    const keys = allKeys(r.body.rows);
    for (const k of FORBIDDEN_ROW_KEYS) assert.equal(keys.has(k), false, `${k} in ${query}`);
    assert.equal(JSON.stringify(r.body).includes(TEXT_MARK), false, query);
    assert.equal(JSON.stringify(r.body).includes(GROUP_MARK), false, query);
    assert.equal(JSON.stringify(r.body).includes(CHAT_MARK), false, query);
  }
});

/* ---------------- deskUrl ---------------- */

test("deskUrl is the desk page of the original message: absolute, from BOPS_PUBLIC_URL, or the default when unset or not a URL", async () => {
  const root = world([post(1)]);
  const path = `/realty/posts/${requestIdOf("msg-1")}`;
  const deskOf = async (env: Env) => (rowsOf((await agentSearch(req("source=whatsapp"), root, env)).body)[0].deskUrl);
  assert.equal(await deskOf(ENV), `${DESK}${path}`, "the default when BOPS_PUBLIC_URL is unset");
  assert.equal(await deskOf({ ...ENV, BOPS_PUBLIC_URL: "https://desk.example.test/" }), `https://desk.example.test${path}`, "a trailing slash is dropped");
  assert.equal(await deskOf({ ...ENV, BOPS_PUBLIC_URL: "desk.example.test" }), `${DESK}${path}`, "not an http(s) URL: the default");
});

test("deskUrl uses the first message of a record seen in several messages, and is null when the record has none", async () => {
  const path = (id: string) => `${DESK}/realty/posts/${requestIdOf(id)}`;
  assert.equal(agentRow(storeRow({ messageIds: ["msg-1", "msg-2"] }), DESK).deskUrl, path("msg-1"));
  assert.equal(agentRow(storeRow({ messageIds: [] }), DESK).deskUrl, null);
  assert.equal(deskPostUrl(DESK, ["msg-9"]), path("msg-9"));
});

test("deskUrl is the link the Supply & Demand page uses for a row: the same per-post page, by the same request id", async () => {
  // The page links a row to /realty/posts/<requestIdOf(messageIds[0])>; deskUrl is that path on the public base.
  const root = world([post(3)]);
  const r = await agentSearch(req("source=whatsapp"), root, ENV);
  assert.equal(rowsOf(r.body)[0].deskUrl, `${DESK}/realty/posts/${requestIdOf("msg-3")}`);
});

test("parked and ignored rows are not returned and not counted", async () => {
  const root = world([post(1), post(2), post(3)]);
  new PeriskopeStore(root).setKindOverride({ messageId: "msg-2", status: "parked", by: "test", at: "2026-11-20T00:00:00.000Z" });
  const r = await agentSearch(req(), root, ENV);
  assert.equal(r.body.total, 2);
  const paths = rowsOf(r.body).map((x) => x.deskUrl as string);
  assert.equal(paths.some((p) => p.endsWith(requestIdOf("msg-2"))), false);
  assert.equal(paths.length, 2);
});

/* ---------------- full param ---------------- */

test("a full param is ignored: no 403 for any value, and every value returns the same rows", async () => {
  const root = world([post(1)]);
  const plain = await agentSearch(req(), root, ENV);
  assert.equal(plain.status, 200);
  assert.equal("redacted" in plain.body, false, "no redacted flag");
  for (const query of ["full=true", "full=false", "full=yes", "full=TRUE", "full="]) {
    const r = await agentSearch(req(query), root, ENV);
    assert.equal(r.status, 200, query);
    assert.deepEqual(r.body, plain.body, query);
  }
  assert.equal(rowsOf(plain.body)[0].senderPhone, SENDER, "the same rows for every staff user");
});

/* ---------------- parameters ---------------- */

test("kind: supply by default, demand allowed; vague and anything else are a 400", async () => {
  const root = world([post(1)]);
  assert.equal(((await agentSearch(req(), root, ENV)).body as { kind: string }).kind, "supply");
  assert.equal((await agentSearch(req("kind=demand"), root, ENV)).status, 200);
  for (const kind of ["vague", "all", "SUPPLY", "supply,demand"]) {
    const r = await agentSearch(req(`kind=${encodeURIComponent(kind)}`), root, ENV);
    assert.equal(r.status, 400, kind);
    assert.match(String(r.body.error), /kind must be supply or demand/);
  }
});

test("agent and group filters are refused (400), not applied", async () => {
  const root = world([post(1)]);
  for (const query of ["agent=Test", "group=Test", `agent=${SENDER}`, "group=Test%20Group%20A"]) {
    const r = await agentSearch(req(query), root, ENV);
    assert.equal(r.status, 400, query);
    assert.deepEqual(r.body, { error: "The agent and group filters are not available on this search." });
  }
  assert.equal(agentSnapshot(req("agent=Test"), root, ENV).status, 400, "snapshot refuses them too");
});

test("limit defaults to 10 and is capped at 50; a non-integer limit is a 400", async () => {
  const root = world(Array.from({ length: 12 }, (_, i) => post(i + 1)));
  const d = await agentSearch(req(), root, ENV);
  assert.equal(d.body.limit, 10);
  assert.equal(d.body.total, 12, "total counts every match, not the page");
  assert.equal(rowsOf(d.body).length, 10);
  assert.equal((await agentSearch(req("limit=999"), root, ENV)).body.limit, 50);
  assert.equal(rowsOf((await agentSearch(req("limit=3&offset=10"), root, ENV)).body).length, 2, "the last page is short");
  assert.equal((await agentSearch(req("limit=2.5"), root, ENV)).status, 400);
  assert.equal((await agentSearch(req("limit=0"), root, ENV)).status, 400);
});

test("the shared filters work: area, price range, beds and listingType", async () => {
  const root = world([post(1, { area: "Maraval", price: 1_000_000, beds: 2 }), post(2, { area: "St Ann's", price: 3_000_000, beds: 3 }), post(3, { area: "Maraval", price: 5_000_000, beds: 3, listingType: "rent" })]);
  const names = async (q: string) => rowsOf((await agentSearch(req(q), root, ENV)).body).length;
  assert.equal(await names("area=Maraval"), 2);
  assert.equal(await names("minPrice=2000000&maxPrice=4000000"), 1);
  assert.equal(await names("beds=3"), 2);
  assert.equal(await names("listingType=rent"), 1);
  assert.equal((await agentSearch(req("listingType=lease"), root, ENV)).status, 400);
});

/* ---------------- snapshot ---------------- */

test("snapshotGroups: count, min, median and max per group; prices only from rows that have one", async () => {
  const base = { area: "Maraval", type: "house", listingType: "sale", currency: "TTD" };
  const groups = snapshotGroups([
    { ...base, price: 1_000_000 },
    { ...base, price: 4_000_000 },
    { ...base, price: 2_000_000 },
    { ...base, price: 3_000_000 },
    { ...base, price: null },
  ]);
  assert.deepEqual(groups, [{ area: "Maraval", type: "house", listingType: "sale", currency: "TTD", count: 5, minPrice: 1_000_000, medianPrice: 2_500_000, maxPrice: 4_000_000 }]);
});

test("snapshotGroups: an odd count takes the middle price; no price gives nulls; no area is left out", async () => {
  const base = { area: "Cascade", type: null, listingType: "rent", currency: "TTD" };
  const [odd] = snapshotGroups([
    { ...base, price: 9_000 },
    { ...base, price: 5_000 },
    { ...base, price: 7_000 },
  ]);
  assert.equal(odd.medianPrice, 7_000);
  assert.equal(odd.minPrice, 5_000);
  assert.equal(odd.maxPrice, 9_000);
  const [none] = snapshotGroups([{ ...base, price: null }]);
  assert.equal(none.count, 1);
  assert.equal(none.minPrice, null);
  assert.equal(none.medianPrice, null);
  assert.equal(none.maxPrice, null);
  assert.deepEqual(snapshotGroups([{ area: null, type: "house", listingType: "sale", currency: "TTD", price: 1 }, { area: "  ", type: "house", listingType: "sale", currency: "TTD", price: 1 }]), []);
});

test("snapshotGroups: sorted by count (largest first), split by currency, and capped", async () => {
  const rows = [
    { area: "B", type: "house", listingType: "sale", currency: "TTD", price: 1 },
    { area: "A", type: "house", listingType: "sale", currency: "USD", price: 1 },
    { area: "A", type: "house", listingType: "sale", currency: "TTD", price: 1 },
    { area: "A", type: "house", listingType: "sale", currency: "TTD", price: 2 },
  ];
  const groups = snapshotGroups(rows);
  assert.deepEqual(groups.map((g) => [g.area, g.currency, g.count]), [
    ["A", "TTD", 2],
    ["A", "USD", 1],
    ["B", "TTD", 1],
  ]);
  const many = Array.from({ length: 150 }, (_, i) => ({ area: `Area ${i}`, type: null, listingType: null, currency: null, price: null }));
  assert.equal(snapshotGroups(many).length, 100);
});

test("snapshot handler: groups from the store, parked rows left out, no phone or text in the output", async () => {
  const root = world([post(1, { area: "Maraval", price: 1_000_000 }), post(2, { area: "Maraval", price: 3_000_000 }), post(3, { area: "Maraval", price: 9_000_000 }), post(4, { area: "St Ann's", price: 2_000_000 })]);
  new PeriskopeStore(root).setKindOverride({ messageId: "msg-3", status: "parked", by: "test", at: "2026-11-20T00:00:00.000Z" });
  const r = agentSnapshot(req("kind=supply"), root, ENV);
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, "supply");
  const groups = r.body.groups as { area: string; count: number; minPrice: number; medianPrice: number; maxPrice: number }[];
  assert.deepEqual(groups.map((g) => [g.area, g.count, g.minPrice, g.medianPrice, g.maxPrice]), [
    ["Maraval", 2, 1_000_000, 2_000_000, 3_000_000],
    ["St Ann's", 1, 2_000_000, 2_000_000, 2_000_000],
  ]);
  const json = JSON.stringify(r.body);
  assert.equal(json.includes(SENDER_DIGITS), false);
  assert.equal(json.includes(TEXT_MARK), false);
  assert.equal(json.includes(GROUP_MARK), false);
  assert.equal(json.includes("Test Agent"), false);
});

test("snapshot: kind defaults to supply, demand is allowed, vague and other values are a 400, and the area filter is a substring", async () => {
  const root = world([post(1, { area: "Maraval" }), post(2, { area: "St Ann's" })]);
  assert.equal(agentSnapshot(req(), root, ENV).body.kind, "supply");
  assert.equal(agentSnapshot(req("kind=demand"), root, ENV).status, 200);
  assert.equal(agentSnapshot(req("kind=vague"), root, ENV).status, 400);
  assert.equal(agentSnapshot(req("listingType=lease"), root, ENV).status, 400);
  assert.equal(agentSnapshot(req("from=2026-13-01"), root, ENV).status, 400);
  const groups = agentSnapshot(req("area=ara"), root, ENV).body.groups as { area: string }[];
  assert.deepEqual(groups.map((g) => g.area), ["Maraval"]);
});

/* ---------------- the gate ---------------- */

test("the search paths are open to the gate (no Google session) and are server-to-server in proxy.ts", async () => {
  for (const p of ["/api/realty/agent-search", "/api/realty/agent-search/snapshot", "/api/mcp/stats"]) assert.equal(GATE_OPEN_PATHS.has(p), true, p);
  const proxy = readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");
  const line = proxy.split("\n").find((l) => l.startsWith("const TAILNET_PATHS"));
  assert.ok(line, "TAILNET_PATHS is found");
  assert.ok(line.includes('"/api/realty/agent-search"') && line.includes('"/api/realty/agent-search/snapshot"') && line.includes('"/api/mcp/stats"'));
});

/* ---------------- external listings (the market search, a fake here) ---------------- */

const EXT_SITE = "Site Alpha";
/** The exact keys of an external row: the same shape as the WhatsApp row where they overlap, plus the site, url and contact. */
const EXT_ROW_KEYS = ["id", "kind", "dateKnown", "area", "development", "price", "currency", "beds", "baths", "type", "listingType", "intent", "propertyClass", "notes", "firstSentAt", "lastSentAt", "timesSeen", "firm", "source", "site", "url", "photo", "agent", "agentPhone", "agentWhatsapp", "agentEmail", "deskUrl"];

/** An invented market hit. The contact details are invented and not real numbers or addresses. */
function hit(over: Partial<CoBrokeHit> = {}): CoBrokeHit {
  return {
    title: "Invented Lime listing",
    price: 2_000_000,
    currency: "TTD",
    area: "Maraval",
    beds: 3,
    baths: 2,
    listingType: "sale",
    propertyClass: "house",
    source: EXT_SITE,
    url: "https://site-alpha.example/listing/1",
    firstSeen: "2026-11-01",
    lastSeen: "2026-11-20",
    photo: "https://site-alpha.example/photo.jpg",
    agent: "Test Broker",
    agency: "Test Agency",
    agentPhone: "+18685550199",
    agentWhatsapp: "+18685550198",
    agentEmail: "broker@example.test",
    ...over,
  };
}

/** A fake of the market: records every criteria asked for and answers with the given listings. */
function fakeMarket(listings: CoBrokeHit[], calls: DeskCriteria[] = []): (c: DeskCriteria) => Promise<DeskResult> {
  return async (c) => {
    calls.push(c);
    return { status: "ok", area: null, listings, returned: listings.length, failed: 0 };
  };
}

test("source: every supply row says whatsapp or external; external rows carry site and url; the WhatsApp shape is unchanged", async () => {
  const root = world([post(1, { area: "Maraval", price: 1_100_000 })]);
  const calls: DeskCriteria[] = [];
  const r = await agentSearch(req("area=Maraval"), root, ENV, { market: fakeMarket([hit({ price: 5_000_000 })], calls) });
  assert.equal(r.status, 200);
  const rows = rowsOf(r.body);
  assert.deepEqual(rows.map((x) => x.source), ["whatsapp", "external"]);
  assert.equal(rows[1].site, EXT_SITE);
  assert.equal(rows[1].url, "https://site-alpha.example/listing/1");
  assert.equal(rows[1].kind, "supply");
  assert.equal(rows[1].firm, "Test Agency");
  assert.equal(rows[1].timesSeen, 1);
  assert.equal(rows[1].firstSentAt, "2026-11-01");
  assert.equal(rows[1].lastSentAt, "2026-11-20");
  assert.deepEqual(r.body.totals, { whatsapp: 1, external: 1 });
  assert.deepEqual(r.body.external, { status: "ok", returned: 1 });
  assert.equal(r.body.total, 1, "total stays the WhatsApp total");
  assert.equal(calls.length, 1);

  const w = await agentSearch(req("area=Maraval&source=whatsapp"), root, ENV, { market: fakeMarket([hit()], calls) });
  assert.deepEqual(sortedKeys(w.body), ["kind", "limit", "offset", "rows", "total"].sort(), "old shape: no external, no totals");
  assert.equal(rowsOf(w.body)[0].source, "whatsapp");
  assert.equal(calls.length, 1, "source=whatsapp never asks the market");
});

test("external rows have exactly the external shape: site, url, the listing agent's contact, and no desk link", async () => {
  const root = world([]);
  const r = await agentSearch(req("area=Maraval"), root, ENV, { market: fakeMarket([hit()]) });
  const row = rowsOf(r.body)[0];
  assert.deepEqual(sortedKeys(row), [...EXT_ROW_KEYS].sort());
  assert.equal(row.source, "external");
  assert.equal(row.site, EXT_SITE);
  assert.equal(row.url, "https://site-alpha.example/listing/1");
  assert.equal(row.deskUrl, null, "no WhatsApp message behind an external listing");
  assert.equal(row.agent, "Test Broker");
  assert.equal(row.agentPhone, "+18685550199");
  assert.equal(row.agentWhatsapp, "+18685550198");
  assert.equal(row.agentEmail, "broker@example.test");
});

test("source: whatsapp, external or all (the default); anything else is a 400", async () => {
  const root = world([post(1, { area: "Maraval" })]);
  const m = fakeMarket([hit()]);
  const ext = await agentSearch(req("area=Maraval&source=external"), root, ENV, { market: m });
  assert.deepEqual(rowsOf(ext.body).map((x) => x.source), ["external"]);
  assert.equal(ext.body.total, 1, "the WhatsApp total is still reported for paging");
  const all = await agentSearch(req("area=Maraval"), root, ENV, { market: m });
  const explicit = await agentSearch(req("area=Maraval&source=all"), root, ENV, { market: m });
  assert.deepEqual(all.body, explicit.body);
  const bad = await agentSearch(req("source=both"), root, ENV, { market: m });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /source must be whatsapp, external or all/);
});

test("demand: source=external is a 400; any other source ignores the market, with no external or totals", async () => {
  const root = world([post(1)], [post(2)]);
  const calls: DeskCriteria[] = [];
  const m = fakeMarket([hit()], calls);
  const e = await agentSearch(req("kind=demand&source=external"), root, ENV, { market: m });
  assert.equal(e.status, 400);
  assert.match(String(e.body.error), /supply only/);
  const all = await agentSearch(req("kind=demand&area=Maraval"), root, ENV, { market: m });
  assert.equal(all.status, 200);
  assert.equal("external" in all.body, false);
  assert.equal("totals" in all.body, false);
  for (const row of rowsOf(all.body)) assert.equal(row.source, "whatsapp");
  assert.equal(calls.length, 0, "demand never asks the market");
});

test("the market is not asked on page 2, for shortlet, for a bad type, or with no area and no market filter", async () => {
  const root = world(Array.from({ length: 12 }, (_, i) => post(i + 1, { area: "Maraval" })));
  const calls: DeskCriteria[] = [];
  const m = fakeMarket([hit()], calls);
  const cases: [string, RegExp][] = [
    ["area=Maraval&offset=10", /only on the first page/],
    ["area=Maraval&listingType=shortlet", /Shortlet/],
    ["area=Maraval&type=villa", /property type/],
    ["", /Give an area/],
    ["q=lime", /Give an area/],
  ];
  for (const [q, reason] of cases) {
    const r = await agentSearch(req(q), root, ENV, { market: m });
    assert.equal(r.status, 200, q);
    const ext = r.body.external as { status: string; reason?: string; returned: number };
    assert.equal(ext.status, "skipped", q);
    assert.equal(ext.returned, 0, q);
    assert.match(ext.reason ?? "", reason, q);
  }
  assert.equal(calls.length, 0);
});

test("a market error, a timeout, a throw or not-configured never fails the request: WhatsApp rows stay, external.status says why", async () => {
  const root = world([post(1, { area: "Maraval" })]);
  const cases: [string, () => Promise<DeskResult>, string][] = [
    ["timeout", async () => ({ status: "error", reason: "timeout" }), "error"],
    ["unavailable", async () => ({ status: "error", reason: "unavailable" }), "error"],
    ["throw", async () => {
      throw new Error("boom: internal detail");
    }, "error"],
    ["not configured", async () => ({ status: "not-configured" }), "not-configured"],
  ];
  for (const [name, market, status] of cases) {
    const r = await agentSearch(req("area=Maraval"), root, ENV, { market });
    assert.equal(r.status, 200, name);
    assert.deepEqual(rowsOf(r.body).map((x) => x.source), ["whatsapp"], name);
    assert.equal((r.body.external as { status: string }).status, status, name);
    assert.equal((r.body.external as { returned: number }).returned, 0, name);
    assert.equal(JSON.stringify(r.body).includes("boom"), false, "the error text is never echoed");
  }
});

test("external rows carry the listing agent's contact as it is, and the title as notes (not scrubbed, clipped like the WhatsApp notes)", async () => {
  const root = world([]);
  const m = fakeMarket([hit({ title: "Call +1 868 555 0199 today" })]);
  const r = await agentSearch(req("area=Maraval"), root, ENV, { market: m });
  const row = rowsOf(r.body)[0];
  assert.equal(row.notes, "Call +1 868 555 0199 today");
  assert.equal(row.agent, "Test Broker");
  assert.equal(row.agentEmail, "broker@example.test");
  assert.equal(JSON.stringify(r.body).includes("Test Broker"), true);
  assert.equal(JSON.stringify(r.body).includes("broker@example.test"), true);
  assert.equal(externalRow(hit({ title: "x".repeat(400) })).notes?.length, AGENT_NOTES_MAX);
});

test("external rows: a stable ext: id from the url (or source and title)", () => {
  const a = externalRow(hit({ title: "x".repeat(400) }));
  const b = externalRow(hit({ title: "x".repeat(400) }));
  assert.equal(a.id, b.id);
  assert.match(a.id, /^ext:[0-9a-f]{16}$/);
  const noUrl = externalRow(hit({ url: null, title: "Invented Mango listing" }));
  assert.match(noUrl.id, /^ext:[0-9a-f]{16}$/);
  assert.notEqual(noUrl.id, a.id);
  assert.equal(noUrl.url, null);
});

test("criteria: area (or development), price, beds, type, listing type and currency 'any' go to the market; q is applied to the hits", async () => {
  const root = world([]);
  const calls: DeskCriteria[] = [];
  const m = fakeMarket([hit({ title: "Invented Lime house" }), hit({ title: "Invented Plum house", url: "https://site-alpha.example/listing/2" })], calls);
  const r = await agentSearch(req("area=Maraval&minPrice=1000000&maxPrice=9000000&beds=3&type=House&listingType=sale&q=LIME"), root, ENV, { market: m });
  assert.deepEqual(calls[0], { area: "Maraval", nearby: false, listingType: "sale", bedsMin: 3, bedsMax: null, priceMin: 1_000_000, priceMax: 9_000_000, propertyType: "house", currency: "any" });
  assert.deepEqual(rowsOf(r.body).map((x) => x.notes), ["Invented Lime house"]);

  await agentSearch(req("development=Bay%20View&beds=2"), root, ENV, { market: m });
  assert.equal(calls[1].area, "Bay View", "development is the area when there is no area");
  assert.equal(calls[1].bedsMin, 2);

  const none = await agentSearch(req("area=Maraval&q=lime+plum"), root, ENV, { market: m });
  assert.equal(rowsOf(none.body).length, 0, "every q word must match");
  assert.equal((none.body.external as { status: string }).status, "ok");
});

test("dedupe on the page: a duplicate hit is dropped and listed on the WhatsApp row; the page limit counts every row", async () => {
  const root = world([post(1, { area: "Maraval", price: 1_100_000, beds: 3, listingType: "sale", currency: "TTD" })]);
  const m = fakeMarket([
    hit({ price: 1_120_000, url: "https://site-alpha.example/listing/7", source: "Site Beta" }),
    hit({ price: 9_000_000, url: "https://site-alpha.example/listing/8" }),
  ]);
  const r = await agentSearch(req("area=Maraval"), root, ENV, { market: m });
  const rows = rowsOf(r.body);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, "whatsapp");
  assert.deepEqual(rows[0].alsoListedOn, [{ site: "Site Beta", url: "https://site-alpha.example/listing/7" }]);
  assert.equal(rows[1].url, "https://site-alpha.example/listing/8");
  assert.deepEqual(r.body.totals, { whatsapp: 1, external: 1 });
});

test("the page limit counts WhatsApp rows first: external rows only fill what is left", async () => {
  const root = world([post(1, { area: "Maraval" }), post(2, { area: "Maraval" })]);
  const m = fakeMarket([hit({ url: "https://site-alpha.example/x1" }), hit({ url: "https://site-alpha.example/x2", price: 9_000_000 })]);
  const full = await agentSearch(req("area=Maraval&limit=3"), root, ENV, { market: m });
  assert.deepEqual(rowsOf(full.body).map((x) => x.source), ["whatsapp", "whatsapp", "external"]);
  assert.equal((full.body.external as { returned: number }).returned, 1);
  assert.deepEqual(full.body.totals, { whatsapp: 2, external: 2 });
  const short = await agentSearch(req("area=Maraval&limit=2"), root, ENV, { market: m });
  assert.equal(rowsOf(short.body).length, 2);
  assert.equal((short.body.external as { returned: number }).returned, 0);
});

test("the date filters do not skip the market: external hits are kept by their own date, last seen first, both bounds inclusive, undated kept", async () => {
  const root = world([]);
  const calls: DeskCriteria[] = [];
  const u = (n: number) => `https://site-alpha.example/d${n}`;
  // Prices are apart by more than 2%, so none of these is a duplicate of another.
  const m = fakeMarket(
    [
      hit({ url: u(1), price: 1_000_000, firstSeen: "2026-11-01", lastSeen: "2026-11-20" }), // last seen in range: kept, though first seen is before
      hit({ url: u(2), price: 2_000_000, firstSeen: "2026-11-01", lastSeen: "2026-11-05" }), // last seen before: dropped, though first seen is in range
      hit({ url: u(3), price: 3_000_000, firstSeen: "2026-10-01", lastSeen: null }), // no last seen: first seen is before: dropped
      hit({ url: u(4), price: 4_000_000, firstSeen: "2026-11-15", lastSeen: null }), // no last seen: first seen in range: kept
      hit({ url: u(5), price: 5_000_000, firstSeen: null, lastSeen: null }), // no date: kept, dateKnown false
      hit({ url: u(6), price: 6_000_000, firstSeen: "2026-11-25", lastSeen: "2026-11-25" }), // the last day: kept (inclusive)
    ],
    calls,
  );
  const r = await agentSearch(req("area=Maraval&from=2026-11-10&to=2026-11-25"), root, ENV, { market: m });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1, "the date filters don't stop the market being asked");
  assert.equal((r.body.external as { status: string }).status, "ok");
  const rows = rowsOf(r.body);
  assert.deepEqual(rows.map((x) => x.url), [u(1), u(4), u(5), u(6)]);
  assert.deepEqual(rows.map((x) => x.dateKnown), [true, true, false, true]);
  assert.deepEqual(r.body.totals, { whatsapp: 0, external: 4 });
  assert.deepEqual(r.body.external, { status: "ok", returned: 4 });
});

test("hitDate: last seen, else first seen; neither is null", () => {
  assert.equal(hitDate(hit({ firstSeen: "2026-11-01", lastSeen: "2026-11-20" })), "2026-11-20");
  assert.equal(hitDate(hit({ firstSeen: "2026-11-01", lastSeen: null })), "2026-11-01");
  assert.equal(hitDate(hit({ firstSeen: null, lastSeen: "not-a-date" })), null, "a bad last seen falls through, and no first seen is null");
  assert.equal(hitDate(hit({ firstSeen: null, lastSeen: null })), null);
});

test("inDateRange: both bounds inclusive, an open bound is open, and an undated hit is kept", () => {
  assert.equal(inDateRange("2026-11-10", "2026-11-10", "2026-11-25"), true, "the first day");
  assert.equal(inDateRange("2026-11-25", "2026-11-10", "2026-11-25"), true, "the last day");
  assert.equal(inDateRange("2026-11-09", "2026-11-10", "2026-11-25"), false, "the day before");
  assert.equal(inDateRange("2026-11-26", "2026-11-10", "2026-11-25"), false, "the day after");
  assert.equal(inDateRange("2020-01-01", undefined, "2026-11-25"), true, "no from");
  assert.equal(inDateRange("2030-01-01", "2026-11-10", undefined), true, "no to");
  assert.equal(inDateRange(null, "2026-11-10", "2026-11-25"), true, "undated is kept");
});

test("beds is at least on the agent search, for WhatsApp rows too: beds=3 gives the 3 and 4 bed rows, not 2 or unknown; the owner's store search stays exact", async () => {
  const root = world([post(1, { beds: 2 }), post(2, { beds: 3 }), post(3, { beds: 4 }), post(4, { beds: null })]);
  const r = await agentSearch(req("beds=3&source=whatsapp"), root, ENV);
  assert.equal(r.status, 200);
  assert.deepEqual(rowsOf(r.body).map((x) => x.beds).sort(), [3, 4]);
  assert.equal(r.body.total, 2);
  const exact = withSearchStore(root, (store) => store.search({ kind: "supply", beds: 3 }));
  assert.equal(exact.total, 1, "without the flag, the owner's search is exact");
  assert.deepEqual(exact.rows.map((x) => x.beds), [3]);
});

const key = (over: Partial<ListingKey> = {}): ListingKey => ({ area: "Maraval", listingType: "sale", beds: 3, price: 1_000_000, currency: "TTD", ...over });

test("sameListing: area (normalized), listing type, beds and currency must match, and price within 2%", () => {
  assert.equal(sameListing(key(), key({ area: " maraval " })), true, "area is normalized");
  assert.equal(sameListing(key(), key({ price: 1_019_000 })), true, "1.9% apart");
  assert.equal(sameListing(key(), key({ price: 1_021_000 })), false, "2.1% apart");
  assert.equal(sameListing(key(), key({ currency: "USD" })), false, "other currency");
  assert.equal(sameListing(key(), key({ beds: 4 })), false);
  assert.equal(sameListing(key({ beds: null }), key({ beds: null })), true, "both no beds");
  assert.equal(sameListing(key({ beds: null }), key()), false);
  assert.equal(sameListing(key(), key({ listingType: "rent" })), false);
  assert.equal(sameListing(key({ area: null }), key({ area: null })), false, "no area is never a match");
  assert.equal(sameListing(key({ price: null }), key({ price: null })), false, "no price is never a match");
});

test("mergeExternal: a hit matching a WhatsApp row is listed on it; of several matching external hits the first is kept", () => {
  const desk: (ListingKey & { id: string; alsoListedOn?: { site: string; url: string | null }[] })[] = [{ id: "w1", ...key({ price: 1_000_000 }) }, { id: "w2", ...key({ area: "St Ann's", price: 3_000_000 }) }];
  const ext = [
    externalRow(hit({ price: 1_010_000, url: "https://a.example/1", source: "Site A" })),
    externalRow(hit({ price: 1_005_000, url: "https://b.example/9", source: "Site B" })),
    externalRow(hit({ area: "Cascade", price: 7_000_000, url: "https://c.example/2", source: "Site C" })),
    externalRow(hit({ area: "Cascade", price: 7_000_000, url: "https://d.example/3", source: "Site D" })),
    externalRow(hit({ area: "Cascade", price: 7_000_000, url: "https://c.example/2", source: "Site C" })),
  ];
  const r = mergeExternal(desk, ext);
  assert.deepEqual(r.desk[0].alsoListedOn, [
    { site: "Site A", url: "https://a.example/1" },
    { site: "Site B", url: "https://b.example/9" },
  ]);
  assert.equal(r.desk[1].alsoListedOn, undefined);
  assert.deepEqual(r.external.map((x) => x.site), ["Site C"]);
  assert.equal("alsoListedOn" in desk[0], false, "the input rows are not changed");
});
