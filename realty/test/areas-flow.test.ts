import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { flowDesk } from "../flow/desk.ts";
import { FlowError, type Inquiry } from "../flow/engine.ts";
import { LeadFlow } from "../flow/flow.ts";
import { PLACEHOLDER_BUSINESS_HOURS } from "../flow/hours.ts";
import { DryRunOutbox } from "../flow/outbox.ts";
import { MarketSearch, marketConfigFromEnv } from "../flow/market-search.ts";
import { rankOurListings } from "../flow/match.ts";
import { FixtureCrm, type FlowAgent, type Listing } from "../flow/source.ts";
import type { Place } from "../flow/areas.ts";
import { AreaStore, areaWiringFromEnv, mapAreaAlias } from "../node/area-store.ts";
import { loadFixtureCrm } from "../node/jsonl.ts";
import { staffAccess } from "../node/periskope-intake.ts";
import { GATE_OPEN_PATHS } from "../../lib/gate.ts";

/**
 * The area rules through the lead flow, the desk and the staff alias store. The market is a fake MCP server
 * (fakeMarket below): resolve_area answers from the small place list here, the learn_ tools are recorded, and
 * search_market_listings returns the hits a test gives it. No live calls; the fetch global is not used.
 */

const MIN = 60_000;
const START = Date.parse("2026-11-12T13:00:00Z"); // Thu 09:00 Port of Spain
const ROOT = mkdtempSync(join(tmpdir(), "areas-flow-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let dirs = 0;
const freshDir = () => join(ROOT, `d${++dirs}`);

const ENV = { ONEON1_MARKET_SEARCH_URL: "http://127.0.0.1:8787/mcp", ONEON1_MARKET_SEARCH_TOKEN: "test-token-not-real-0123", ONEON1_MARKET_SEARCH_TIMEOUT_MS: "2000" };

const PLACES: Place[] = [
  { name: "Westmoorings", region: "North West", neighbours: ["Glencoe", "Maraval"] },
  { name: "Glencoe", region: "North West", neighbours: ["Westmoorings"] },
  { name: "Maraval", region: "North West", neighbours: ["Westmoorings"] },
  { name: "Carenage", region: "North West", neighbours: [] },
  { name: "Woodbrook", region: "Port of Spain", neighbours: ["Port of Spain"] },
  { name: "Port of Spain", region: "Port of Spain", neighbours: ["Woodbrook"] },
  { name: "Scarborough", region: "Tobago", neighbours: ["Westmoorings"] },
];

/** What the fake resolve_area says: the place if it's in the list, a low-confidence guess for "Westmoring", else nothing. */
function resolveAnswer(text: string): Record<string, unknown> {
  const t = text.trim().toLowerCase();
  if (t === "westmoring") return { area: "Westmoring", region: "North West", confidence: 0.5, suggestions: ["Westmoorings"] };
  const p = PLACES.find((x) => x.name.toLowerCase() === t);
  return p ? { area: p.name, region: p.region, neighbours: p.neighbours, confidence: "high" } : {};
}

const SEARCH_HITS = [
  { title: "Glencoe flat", price: 6000, currency: "TTD", area: "Glencoe", beds: 2, baths: 1, listing_type: "rent", source: "otheragency", url: "https://example.com/a/1" },
  { title: "Villa, Scarborough", price: 5000, currency: "TTD", area: "Scarborough", beds: 2, baths: 2, listing_type: "rent", source: "otheragency", url: "https://example.com/a/2" },
];

const sse = (msg: unknown) => `event: message\ndata: ${JSON.stringify(msg)}\n\n`;

/** A fake market-mcp: initialize, the initialized notice, then tools/call. Records every tool call by name. */
function fakeMarket(opts: { learnStatus?: number; hits?: unknown[] } = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") {
      return new Response(sse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } }), {
        status: 200,
        headers: { "content-type": "text/event-stream", "mcp-session-id": "session-test" },
      });
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method !== "tools/call") throw new Error(`unexpected ${body.method}`);
    const { name, arguments: args } = body.params as { name: string; arguments: Record<string, unknown> };
    calls.push({ tool: name, args });
    if (name.startsWith("learn_") && opts.learnStatus) return new Response("nope", { status: opts.learnStatus });
    const payload =
      name === "resolve_area" ? resolveAnswer(String(args.text)) : name === "search_market_listings" ? { total: (opts.hits ?? []).length, hits: opts.hits ?? [] } : { ok: true };
    const result = { content: [{ type: "text", text: "A spoken summary." }, { type: "text", text: JSON.stringify(payload) }] };
    return new Response(sse({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetcher, calls, named: (tool: string) => calls.filter((c) => c.tool === tool) };
}

const fixture = loadFixtureCrm();
const fixtureAgents = await fixture.agents();
/** Ava (1) also covers the North West places in these tests, so they get a listing agent. */
const AGENTS: FlowAgent[] = fixtureAgents.map((a) => (a.id === 1 ? { ...a, areas: ["Westmoorings", "Glencoe", "Carenage", "Woodbrook", "Port of Spain"], listingTypes: ["sale", "rent"] as FlowAgent["listingTypes"] } : a));

const L = (id: string, area: string, over: Partial<Listing> = {}): Listing => ({
  id,
  title: `${area} ${id}`,
  listingType: "rent",
  area,
  price: 6000,
  currency: "TTD",
  beds: 2,
  baths: 1,
  agentId: 1,
  status: "active",
  url: `https://example.com/listings/${id}`,
  ...over,
});

const inq = (over: Partial<Inquiry> = {}): Inquiry => ({
  ref: "t-1",
  source: "property_inquiry",
  name: "Sam Fixture",
  phone: "+1 868 555 0201",
  email: "sam.fixture@example.com",
  listingId: null,
  listingType: "rent",
  area: "Woodbrook",
  budget: { max: 9000, currency: "TTD" },
  beds: 2,
  message: "",
  ...over,
});

/** A flow on a fake clock, with the CRM given. The market is the fake when `fake` is given; areas and learning use the store in `root`. */
function world(listings: Listing[], o: { fake?: ReturnType<typeof fakeMarket> | null; root?: string } = {}) {
  let now = START;
  const clock = () => new Date(now);
  const root = o.root ?? freshDir();
  const store = new AreaStore(join(root, "areas"));
  const wiring = areaWiringFromEnv(store, o.fake ? ENV : {}, o.fake?.fetcher);
  const outbox = new DryRunOutbox({ clock });
  const flow = new LeadFlow({
    crm: FixtureCrm.from({ agents: AGENTS, listings, inquiries: [] }),
    clock,
    outbox,
    market: o.fake ? new MarketSearch(marketConfigFromEnv(ENV)!, o.fake.fetcher) : null,
    timeoutMs: 15 * MIN,
    hours: PLACEHOLDER_BUSINESS_HOURS,
    admin: { name: "Admin", address: "admin@example.com" },
    areas: wiring.areas,
    areaLearning: wiring.areaLearning,
  });
  return { flow, outbox, store, root, advance: (m: number) => (now += m * MIN) };
}

const SAM_LISTINGS = [
  L("R1", "Woodbrook", { price: 7000 }),
  L("R2", "Port of Spain", { price: 6500 }),
  L("R3", "Maraval", { price: 6000 }),
  L("R4", "Scarborough", { price: 5000, agentId: 3 }),
  L("R5", "Woodbrook", { beds: 1 }),
  L("R6", "Woodbrook", { price: 9500 }),
  L("R7", "Woodbrook", { listingType: "sale" }),
  L("R8", "Woodbrook", { status: "sold" }),
];

/** Westmoorings buyer's listings: same area, a neighbour (Glencoe), the same region (Carenage), and a Tobago listing that must not appear. */
const WEST_LISTINGS = [
  L("W1", "Westmoorings", { price: 6000 }),
  L("G1", "Glencoe", { price: 4500 }),
  L("C1", "Carenage", { price: 4000 }),
  L("T1", "Scarborough", { price: 3000, agentId: 3 }),
];

const westInq = () => inq({ area: "Westmoorings", source: "website_contact", name: "Wes Fixture", phone: "+1 868 555 0204", email: null });

const candidateLines = (flow: LeadFlow) => flow.pendingApprovals()[0].candidates.map((c) => [c.id, c.tier, c.reason]);

test("the lead flow ranks by tier: the same area first, then a neighbour; the Maraval and Tobago listings don't fit", async () => {
  const fake = fakeMarket();
  const w = world(SAM_LISTINGS, { fake });
  await w.flow.receive(inq());
  assert.deepEqual(candidateLines(w.flow), [
    ["ours:R1", "same-area", "same area: Woodbrook"],
    ["ours:R2", "neighbour", "nearby: Port of Spain for Woodbrook"],
  ]);
});

test("without a market, matching is exact text, as before: the neighbour isn't seen", async () => {
  const w = world(SAM_LISTINGS);
  await w.flow.receive(inq());
  assert.deepEqual(candidateLines(w.flow).map((c) => c[0]), ["ours:R1"]);
});

test("the agent's alert gives the reason on each line, and co-broke hits are ranked (the Tobago one is dropped)", async () => {
  const fake = fakeMarket({ hits: SEARCH_HITS });
  const w = world(WEST_LISTINGS, { fake });
  await w.flow.receive(westInq());
  const alert = w.outbox.messages.find((m) => m.kind === "agent_alert")!;
  assert.match(alert.text, /Westmoorings W1 · TTD 6,000 · 2 bed · Westmoorings \(W1\) · same area: Westmoorings/);
  assert.match(alert.text, /Glencoe G1 .*· nearby: Glencoe for Westmoorings/);
  assert.match(alert.text, /Carenage C1 .*· same region: North West/);
  assert.match(alert.text, /via otheragency https:\/\/example\.com\/a\/1 · nearby: Glencoe for Westmoorings/);
  assert.match(alert.text, /co-broke candidates, 1 of 2 from other agencies fit\)/);
  assert.doesNotMatch(alert.text, /Scarborough/, "neither the Tobago listing nor the Tobago hit is shown");
  assert.deepEqual(candidateLines(w.flow).map((c) => c[0]), ["ours:W1", "ours:G1", "ours:C1", "cobroke:1"]);
});

test("approveMatches records one approved pair for each pick, and nothing for the candidates left out", async () => {
  const fake = fakeMarket({ hits: SEARCH_HITS });
  const w = world(WEST_LISTINGS, { fake });
  await w.flow.receive(westInq());
  const a = w.flow.pendingApprovals()[0];
  w.flow.approveMatches(a.id, ["ours:G1"]);
  assert.deepEqual(w.store.pairs().map((p) => [p.inquiryArea, p.listingArea, p.tier, p.signal]), [["Westmoorings", "Glencoe", "neighbour", "approved"]]);
  assert.equal(w.flow.approval(a.id).status, "approved");
  assert.equal(w.flow.areaPairs().length, 1);
  await w.flow.learningSent();
});

test("rejectMatches records every candidate as rejected; an empty selection is the same as a reject", async () => {
  const fake = fakeMarket({ hits: SEARCH_HITS });
  const w = world(WEST_LISTINGS, { fake });
  await w.flow.receive(westInq());
  const a = w.flow.pendingApprovals()[0];
  w.flow.rejectMatches(a.id);
  assert.deepEqual(
    w.store.pairs().map((p) => [p.listingArea, p.tier, p.signal]),
    [
      ["Westmoorings", "same-area", "rejected"],
      ["Glencoe", "neighbour", "rejected"],
      ["Carenage", "same-region", "rejected"],
      ["Glencoe", "neighbour", "rejected"],
    ],
    "the co-broke Glencoe hit is a candidate too",
  );

  const w2 = world(WEST_LISTINGS, { fake: fakeMarket({ hits: SEARCH_HITS }) });
  await w2.flow.receive(westInq());
  w2.flow.approveMatches(w2.flow.pendingApprovals()[0].id, []);
  assert.deepEqual([...new Set(w2.store.pairs().map((p) => p.signal))], ["rejected"]);
  assert.equal(w2.store.pairs().length, 4);
});

test("a second decision on the same approval is refused, and records nothing more", async () => {
  const w = world(WEST_LISTINGS, { fake: fakeMarket({ hits: SEARCH_HITS }) });
  await w.flow.receive(westInq());
  const a = w.flow.pendingApprovals()[0];
  w.flow.approveMatches(a.id, ["ours:W1"]);
  const before = w.store.pairs().length;
  assert.throws(() => w.flow.rejectMatches(a.id), FlowError);
  assert.equal(w.store.pairs().length, before);
});

test("learn_area_neighbour is sent only for an explicit approve or reject, one call per record, never on receive or tick", async () => {
  const fake = fakeMarket({ hits: SEARCH_HITS });
  const w = world(WEST_LISTINGS, { fake });
  await w.flow.receive(westInq());
  w.advance(16);
  await w.flow.tick();
  assert.equal(fake.named("learn_area_neighbour").length, 0, "nothing sent on receive or tick");
  assert.equal(fake.named("learn_area_alias").length, 0);

  w.flow.approveMatches(w.flow.pendingApprovals()[0].id, ["ours:G1"]);
  await w.flow.learningSent();
  assert.deepEqual(fake.named("learn_area_neighbour").map((c) => c.args), [{ inquiryArea: "Westmoorings", listingArea: "Glencoe", tier: "neighbour", signal: "approved" }]);
});

test("a failed learn_area_neighbour keeps the local record and doesn't throw into the approve path", async () => {
  const fake = fakeMarket({ hits: SEARCH_HITS, learnStatus: 500 });
  const w = world(WEST_LISTINGS, { fake });
  await w.flow.receive(westInq());
  const a = w.flow.pendingApprovals()[0];
  const done = w.flow.approveMatches(a.id, ["ours:G1"]);
  assert.equal(done.status, "approved");
  await w.flow.learningSent();
  assert.equal(fake.named("learn_area_neighbour").length, 1, "the send was tried once");
  assert.equal(w.store.pairs().length, 1, "the record is kept");
});

test("with no market configured, the learning is recorded locally and nothing is sent", async () => {
  const w = world(WEST_LISTINGS);
  await w.flow.receive(westInq());
  // Exact text only: Westmoorings is the one same-area candidate (Glencoe is not seen as a neighbour).
  w.flow.approveMatches(w.flow.pendingApprovals()[0].id, ["ours:W1"]);
  await w.flow.learningSent();
  assert.deepEqual(w.store.pairs().map((p) => [p.listingArea, p.tier]), [["Westmoorings", "same-area"]]);
});

test("the desk: an unmapped inquiry area is flagged with its suggestions; unmapped areas are counted with examples; learning is counted", async () => {
  const fake = fakeMarket({ hits: SEARCH_HITS });
  const listings = [...WEST_LISTINGS, L("N1", "Nowhere Hill", { price: 3000 })];
  const w = world(listings, { fake });
  await w.flow.receive(westInq());
  await w.flow.receive(inq({ ref: "typo-1", area: "Westmoring", name: "Typo Client", phone: "+1 868 555 0205", email: null }));

  const v = await flowDesk(w.flow);
  const typo = v.queue.exceptions.find((l) => l.client === "Typo Client")!;
  assert.equal(typo.unmappedArea, true);
  assert.deepEqual(typo.suggestions, ["Westmoorings"]);
  const wes = v.queue.open.find((l) => l.client === "Wes Fixture") ?? v.queue.exceptions.find((l) => l.client === "Wes Fixture")!;
  assert.equal(wes.unmappedArea, false, "a mapped area isn't flagged");

  assert.equal(v.unmappedAreas.count, 2, "Westmoring from an inquiry, Nowhere Hill from a listing");
  const examples = Object.fromEntries(v.unmappedAreas.examples.map((e) => [e.text, e]));
  assert.deepEqual(examples.Westmoring, { text: "Westmoring", occurrences: 1, from: ["inquiry"], suggestions: ["Westmoorings"] });
  assert.deepEqual(examples["Nowhere Hill"], { text: "Nowhere Hill", occurrences: 1, from: ["listing"], suggestions: [] });

  w.flow.rejectMatches(w.flow.pendingApprovals()[0].id);
  const after = await flowDesk(w.flow);
  assert.equal(after.areaLearning.total, 4);
  assert.deepEqual(after.areaLearning.bySignal, { approved: 0, rejected: 4 });
  assert.deepEqual(after.areaLearning.byTier.find((x) => x.tier === "neighbour"), { tier: "neighbour", approved: 0, rejected: 2 });
});

test("a staff mapping: the row is written, learn_area_alias is sent (live), and the alias then matches first", async () => {
  const fake = fakeMarket();
  const root = freshDir();
  const store = new AreaStore(root);
  const row = await mapAreaAlias({ alias: "  Westmoring ", canonical: "Westmoorings" }, { store, env: ENV, fetcher: fake.fetcher, now: new Date(START) });
  assert.equal(row.ok, true);
  assert.equal(row.ok && row.row.market, "sent");
  assert.deepEqual(fake.named("learn_area_alias").map((c) => c.args), [{ alias: "Westmoring", canonical: "Westmoorings" }]);
  assert.deepEqual(store.aliasRows().map((r) => [r.alias, r.canonical]), [["Westmoring", "Westmoorings"]]);

  const { areas } = areaWiringFromEnv(store, ENV, fake.fetcher);
  const l = await areas.lookup("westmoring");
  assert.equal(l.mapped, true);
  assert.equal(l.source, "alias");
  assert.equal(l.canonical, "Westmoorings");
  assert.equal(l.region, "North West", "the market's region for the canonical name");
  const ranked = await rankOurListings(inq({ area: "Westmoring" }), WEST_LISTINGS, areas);
  assert.deepEqual(ranked.map((r) => [r.item.id, r.reason]), [["W1", "same area: Westmoorings"], ["G1", "nearby: Glencoe for Westmoorings"], ["C1", "same region: North West"]]);
});

test("a staff mapping with no market is a dry run: no network, the row says so, and the alias still resolves (same area only)", async () => {
  const root = freshDir();
  const store = new AreaStore(root);
  const noNetwork = (async () => {
    throw new Error("no network in tests");
  }) as unknown as typeof fetch;
  const row = await mapAreaAlias({ alias: "Glen Cove", canonical: "Glencoe" }, { store, env: {}, fetcher: noNetwork });
  assert.equal(row.ok && row.row.market, "dry-run");
  const l = await areaWiringFromEnv(store, {}, noNetwork).areas.lookup("glen  cove");
  assert.equal(l.canonical, "Glencoe");
  assert.equal(l.region, null);
});

test("a failed learn_area_alias keeps the mapping and says so on the row; the request still succeeds", async () => {
  const fake = fakeMarket({ learnStatus: 503 });
  const store = new AreaStore(freshDir());
  const row = await mapAreaAlias({ alias: "Westmoring", canonical: "Westmoorings" }, { store, env: ENV, fetcher: fake.fetcher });
  assert.equal(row.ok && row.row.market, "failed");
  assert.equal(store.aliasRows().length, 1);
});

test("bad alias bodies are refused, and the files are private (0700 directory, 0600 files)", async () => {
  const root = freshDir();
  const store = new AreaStore(root);
  for (const body of [null, "x", { alias: "", canonical: "Glencoe" }, { alias: "Glencoe" }, { alias: "a".repeat(81), canonical: "Glencoe" }]) {
    const r = await mapAreaAlias(body, { store, env: {} });
    assert.equal(r.ok, false, JSON.stringify(body));
  }
  assert.equal(store.aliasRows().length, 0);
  assert.equal((await mapAreaAlias({ alias: "Glen  Cove", canonical: " Glencoe " }, { store, env: {} })).ok, true);
  assert.equal(store.aliasRows()[0].canonical, "Glencoe", "trimmed");
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, "aliases.jsonl")).mode & 0o777, 0o600);
});

test("the alias route is staff-only: 403 on the public demo, nothing written, and not an open path", async () => {
  const denied = await staffAccess(new Request("http://localhost/api/realty/areas/alias", { method: "POST" }), { ONEON1_PUBLIC_DEMO: "1" });
  assert.equal(denied?.status, 403);
  assert.equal(GATE_OPEN_PATHS.has("/api/realty/areas/alias"), false);
});
