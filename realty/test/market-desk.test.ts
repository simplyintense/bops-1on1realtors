import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { criteriaFromParams, marketDeskSearch, type DeskCriteria, type DeskResult } from "../flow/market-desk.ts";
import type { MarketConfig } from "../flow/market-search.ts";
import { areasFromEnv, AreaStore } from "../node/area-store.ts";
import { staffAccess } from "../node/periskope-intake.ts";
import { demoRoute, GATE_OPEN_PATHS } from "../../lib/gate.ts";

/**
 * The staff market search (realty/flow/market-desk.ts) against a fake market-mcp: resolve_area answers from a small
 * place list, search_market_listings returns the hits a test gives for each area. No real network; the fetch global is
 * never used. The tests also check that only search and resolve are ever called, and that no alias is written.
 */

const ROOT = mkdtempSync(join(tmpdir(), "market-desk-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let dirs = 0;
const freshDir = () => join(ROOT, `d${++dirs}`);

const TOKEN = "test-token-not-real-0123";
const CFG: MarketConfig = { url: "http://127.0.0.1:8787/mcp", token: TOKEN, timeoutMs: 2000 };
const ENV = { ONEON1_MARKET_SEARCH_URL: CFG.url, ONEON1_MARKET_SEARCH_TOKEN: TOKEN, ONEON1_MARKET_SEARCH_TIMEOUT_MS: "2000" };

type Hit = Record<string, unknown>;
type Fake = { hits?: (area: string | null) => Hit[]; failArea?: string; status?: number; throws?: Error };

/** Places the fake resolve_area knows: the canonical name, the island's region, and the neighbours. */
const PLACES: Record<string, { area: string; neighbours: string[] }> = {
  westmoorings: { area: "Westmoorings", neighbours: ["Glencoe", "Maraval"] },
  glencoe: { area: "Glencoe", neighbours: ["Westmoorings"] },
  maraval: { area: "Maraval", neighbours: ["Westmoorings"] },
  woodbrook: { area: "Woodbrook", neighbours: [] },
};

function resolveAnswer(text: string): Record<string, unknown> {
  const p = PLACES[text.trim().toLowerCase()];
  return p
    ? { area: p.area, island: "Trinidad", region: "North West", neighbours: p.neighbours, confidence: 0.95 }
    : { area: null, unresolved: true, suggestions: [] };
}

const sse = (msg: unknown) => `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
const sseReply = (id: number, payload: unknown) =>
  new Response(sse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "A spoken summary." }, { type: "text", text: JSON.stringify(payload) }] } }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

/** A fake market-mcp: initialize, the initialized notice, then tools/call. Records each tool call. */
function fakeMarket(f: Fake = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (f.throws) throw f.throws;
    if (f.status) return new Response("nope", { status: f.status });
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") {
      return new Response(sse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } }), {
        status: 200,
        headers: { "content-type": "text/event-stream", "mcp-session-id": "session-test" },
      });
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    const { name, arguments: args } = body.params as { name: string; arguments: Record<string, unknown> };
    calls.push({ tool: name, args });
    if (name === "resolve_area") return sseReply(body.id, resolveAnswer(String(args.text)));
    const area = typeof args.area === "string" ? args.area : null;
    if (f.failArea && area === f.failArea) return new Response("nope", { status: 500 });
    const hits = f.hits?.(area) ?? [];
    return sseReply(body.id, { total: hits.length, hits });
  }) as typeof fetch;
  return {
    fetcher,
    calls,
    tools: () => [...new Set(calls.map((c) => c.tool))].sort(),
    searches: () => calls.filter((c) => c.tool === "search_market_listings").map((c) => c.args),
  };
}

const base: DeskCriteria = { area: "", nearby: false, listingType: null, bedsMin: null, bedsMax: null, priceMin: null, priceMax: null, propertyType: null, currency: "any" };
const crit = (over: Partial<DeskCriteria>): DeskCriteria => ({ ...base, ...over });

const hit = (title: string, over: Hit = {}): Hit => ({
  title,
  price: 6000,
  currency: "TTD",
  area: "Westmoorings",
  beds: 2,
  baths: 1,
  listing_type: "rent",
  source: "otheragency",
  url: `https://example.com/${title.replace(/\s+/g, "-")}`,
  ...over,
});

/** One search: a fresh alias store (with `aliases` seeded), the fake market, and the config (null for "off"). */
async function run(c: DeskCriteria, f: Fake = {}, o: { aliases?: [string, string][]; config?: MarketConfig | null } = {}) {
  const fake = fakeMarket(f);
  const store = new AreaStore(freshDir());
  for (const [alias, canonical] of o.aliases ?? []) store.addAlias({ alias, canonical, at: "2026-11-01T00:00:00.000Z", market: "dry-run" });
  const resolver = areasFromEnv(store, ENV, fake.fetcher);
  const result = await marketDeskSearch(c, { config: o.config === undefined ? CFG : o.config, resolver, fetcher: fake.fetcher });
  return { result, fake, store };
}

function ok(r: DeskResult) {
  assert.equal(r.status, "ok", JSON.stringify(r));
  return r as Extract<DeskResult, { status: "ok" }>;
}

const titles = (r: DeskResult) => ok(r).listings.map((h) => h.title).sort();

test("nearby on: the area and its neighbours are searched once each, and listings are de-duplicated", async () => {
  const byArea: Record<string, Hit[]> = {
    Westmoorings: [hit("A"), hit("B")],
    Glencoe: [hit("B"), hit("C")],
    Maraval: [hit("D", { url: null }), hit("D", { url: null })],
  };
  const { result, fake, store } = await run(crit({ area: "Westmoorings", nearby: true }), { hits: (a) => byArea[a ?? ""] ?? [] });
  assert.deepEqual(fake.searches().map((a) => a.area).sort(), ["Glencoe", "Maraval", "Westmoorings"]);
  assert.deepEqual(titles(result), ["A", "B", "C", "D"]);
  assert.equal(ok(result).returned, 4);
  assert.equal(ok(result).area?.canonical, "Westmoorings");
  assert.deepEqual(ok(result).area?.searched, ["Westmoorings", "Glencoe", "Maraval"]);
  assert.deepEqual(fake.tools(), ["resolve_area", "search_market_listings"], "only search and resolve are called");
  assert.equal(store.aliasRows().length, 0, "no alias is written");
});

test("nearby off: only the canonical area is searched, and the neighbours are named but not searched", async () => {
  const { result, fake } = await run(crit({ area: "Westmoorings" }), { hits: () => [hit("A")] });
  assert.deepEqual(fake.searches().map((a) => a.area), ["Westmoorings"]);
  assert.deepEqual(ok(result).area?.neighbours, ["Glencoe", "Maraval"]);
  assert.deepEqual(ok(result).area?.searched, ["Westmoorings"]);
});

test("a nickname resolves through the alias store, and the search uses the canonical name", async () => {
  const { result, fake, store } = await run(crit({ area: "west  moorings" }), { hits: () => [hit("A")] }, { aliases: [["West Moorings", "Westmoorings"]] });
  assert.deepEqual(fake.searches().map((a) => a.area), ["Westmoorings"]);
  assert.equal(ok(result).area?.mapped, true);
  assert.equal(store.aliasRows().length, 1, "the alias file is only read, never added to");
  assert.ok(!fake.tools().includes("learn_area_neighbour") && !fake.tools().some((t) => t.startsWith("learn_")));
});

test("an unmapped area is searched as typed, and the page is told it isn't known", async () => {
  const { result, fake } = await run(crit({ area: "Nowhere Town" }), { hits: () => [hit("A")] });
  assert.deepEqual(fake.searches().map((a) => a.area), ["Nowhere Town"]);
  assert.equal(ok(result).area?.mapped, false);
  assert.equal(ok(result).area?.canonical, null);
});

test("beds: beds_min and beds_max both go to the market, and Bops keeps every hit the market returns", async () => {
  const hits = [hit("beds 1", { beds: 1 }), hit("beds 2", { beds: 2 }), hit("beds 3", { beds: 3 }), hit("beds 4", { beds: 4 }), hit("beds unknown", { beds: null })];
  const { result, fake } = await run(crit({ bedsMin: 2, bedsMax: 3 }), { hits: () => hits });
  const args = fake.searches()[0];
  assert.equal(args.beds_min, 2);
  assert.equal(args.beds_max, 3);
  assert.deepEqual(titles(result), ["beds 1", "beds 2", "beds 3", "beds 4", "beds unknown"]);
});

test("price with TTD: price min and max both go to the market, and Bops doesn't filter prices or currencies", async () => {
  const hits = [hit("TTD 3000", { price: 3000 }), hit("TTD 5000", { price: 5000 }), hit("TTD 8000", { price: 8000 }), hit("USD 5000", { price: 5000, currency: "USD" }), hit("no price", { price: null })];
  const { result, fake } = await run(crit({ currency: "TTD", priceMin: 4000, priceMax: 7000 }), { hits: () => hits });
  const args = fake.searches()[0];
  assert.equal(args.price_min, 4000);
  assert.equal(args.price_max, 7000);
  assert.deepEqual(titles(result), ["TTD 3000", "TTD 5000", "TTD 8000", "USD 5000", "no price"]);
});

test("price with USD: price min and max both go to the market, and Bops doesn't filter by currency", async () => {
  const hits = [hit("USD 1000", { price: 1000, currency: "USD" }), hit("USD 2000", { price: 2000, currency: "USD" }), hit("TTD 1000", { price: 1000 })];
  const { result, fake } = await run(crit({ currency: "USD", priceMin: 500, priceMax: 1500 }), { hits: () => hits });
  const args = fake.searches()[0];
  assert.equal(args.price_min, 500);
  assert.equal(args.price_max, 1500);
  assert.deepEqual(titles(result), ["TTD 1000", "USD 1000", "USD 2000"]);
});

test("price with any currency: the bounds go to the market as raw amounts, and every hit is shown", async () => {
  const hits = [hit("TTD 3000", { price: 3000 }), hit("USD 1000", { price: 1000, currency: "USD" })];
  const { result, fake } = await run(crit({ currency: "any", priceMin: 2000, priceMax: 5000 }), { hits: () => hits });
  assert.equal(fake.searches()[0].price_min, 2000);
  assert.equal(fake.searches()[0].price_max, 5000);
  assert.deepEqual(titles(result), ["TTD 3000", "USD 1000"]);
});

test("property type: a valid one goes to the market as property_type, and an invalid one is ignored", async () => {
  const valid = await run(crit({ area: "Woodbrook", propertyType: "apartment" }), { hits: () => [hit("A")] });
  assert.equal(valid.fake.searches()[0].property_type, "apartment");
  const invalid = await run(criteriaFromParams(new URLSearchParams("area=Woodbrook&propertyType=villa")), { hits: () => [hit("A")] });
  assert.equal("property_type" in invalid.fake.searches()[0], false);
  const wrongCase = await run(criteriaFromParams(new URLSearchParams("area=Woodbrook&propertyType=House")), { hits: () => [hit("A")] });
  assert.equal("property_type" in wrongCase.fake.searches()[0], false);
});

test("property_class on a hit becomes propertyClass; a missing or blank one is null", async () => {
  const hits = [hit("Typed", { property_class: "townhouse" }), hit("Blank", { property_class: "  " }), hit("Missing")];
  const { result } = await run(crit({ area: "Woodbrook" }), { hits: () => hits });
  const byTitle = Object.fromEntries(ok(result).listings.map((h) => [h.title, h.propertyClass]));
  assert.equal(byTitle.Typed, "townhouse");
  assert.equal(byTitle.Blank, null);
  assert.equal(byTitle.Missing, null);
});

test("our own listings and unsafe links are dropped; a bad link is shown with no link", async () => {
  const hits = [hit("Ours", { source: "oneonone" }), hit("Bad", { url: "javascript:alert(1)" }), hit("Good")];
  const { result } = await run(crit({ area: "Woodbrook" }), { hits: () => hits });
  assert.deepEqual(titles(result), ["Bad", "Good"]);
  const byTitle = Object.fromEntries(ok(result).listings.map((h) => [h.title, h]));
  assert.equal(byTitle.Bad.url, null);
  assert.match(byTitle.Good.url ?? "", /^https:\/\//);
});

test("no market configured: not-configured, and no call is made", async () => {
  const { result, fake } = await run(crit({ area: "Westmoorings" }), {}, { config: null });
  assert.deepEqual(result, { status: "not-configured" });
  assert.equal(fake.calls.length, 0);
});

test("every search failing is an error: unavailable on an HTTP failure, timeout on a timeout", async () => {
  const down = await run(crit({ area: "Woodbrook" }), { status: 500 });
  assert.deepEqual(down.result, { status: "error", reason: "unavailable" });
  const slow = await run(crit({ area: "Woodbrook" }), { throws: new DOMException("slow", "TimeoutError") });
  assert.deepEqual(slow.result, { status: "error", reason: "timeout" });
});

test("one area failing still shows the rest, with the failure counted", async () => {
  const { result } = await run(crit({ area: "Westmoorings", nearby: true }), {
    failArea: "Glencoe",
    hits: (a) => (a === "Westmoorings" ? [hit("A")] : a === "Maraval" ? [hit("M")] : []),
  });
  assert.deepEqual(titles(result), ["A", "M"]);
  assert.equal(ok(result).failed, 1);
});

test("no matching listings is ok and empty", async () => {
  const { result } = await run(crit({ area: "Woodbrook" }), { hits: () => [] });
  assert.deepEqual(ok(result).listings, []);
  assert.equal(ok(result).returned, 0);
});

test("last_seen shows as a date when the hit has one, and is null when it doesn't", async () => {
  const { result } = await run(crit({ area: "Woodbrook" }), { hits: () => [hit("Dated", { last_seen: "2026-11-10T09:30:00Z" }), hit("Undated")] });
  const byTitle = Object.fromEntries(ok(result).listings.map((h) => [h.title, h.lastSeen]));
  assert.equal(byTitle.Dated, "2026-11-10");
  assert.equal(byTitle.Undated, null);
});

test("criteriaFromParams reads the filters and ignores what it can't read", () => {
  const c = criteriaFromParams(new URLSearchParams("area=%20%20west%20%20moorings%20&nearby=1&type=lease&bedsMin=2.7&bedsMax=abc&priceMin=-5&priceMax=9000&propertyType=villa&currency=EUR"));
  assert.deepEqual(c, {
    area: "west moorings",
    nearby: true,
    listingType: null,
    bedsMin: 2,
    bedsMax: null,
    priceMin: null,
    priceMax: 9000,
    propertyType: null,
    currency: "any",
  });
  assert.equal(criteriaFromParams(new URLSearchParams("type=rent&nearby=0")).listingType, "rent");
  assert.equal(criteriaFromParams(new URLSearchParams("nearby=0")).nearby, false);
  for (const t of ["house", "apartment", "townhouse", "land", "commercial"]) {
    assert.equal(criteriaFromParams(new URLSearchParams(`propertyType=${t}`)).propertyType, t);
  }
  assert.equal(criteriaFromParams(new URLSearchParams("propertyType=")).propertyType, null);
});

test("staff only: the search API is refused on the public demo and needs a session when the gate is on", async () => {
  const req = new Request("http://localhost/api/realty/market/search?area=x");
  assert.equal((await staffAccess(req, { ONEON1_PUBLIC_DEMO: "1" }))?.status, 403);
  const gated = {
    BOPS_LOGIN_GATE: "google",
    BOPS_GATE_SECRET: "x".repeat(32),
    BOPS_ALLOWED_EMAILS: "@1on1realtors.com",
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    BOPS_PUBLIC_URL: "https://bop.1on1realtors.com",
  };
  assert.equal((await staffAccess(req, gated))?.status, 401);
  assert.equal((await staffAccess(req, { BOPS_LOGIN_GATE: "google" }))?.status, 503);
  assert.equal(GATE_OPEN_PATHS.has("/api/realty/market/search"), false);
});

test("public demo: the market pages and the search API are not passed through", () => {
  assert.equal(demoRoute("/realty/market"), "demo");
  assert.equal(demoRoute("/realty/desk"), "demo");
  assert.equal(demoRoute("/api/realty/market/search"), "deny");
  for (const p of ["/realty/market", "/realty/desk"]) assert.equal(GATE_OPEN_PATHS.has(p), false, p);
});
