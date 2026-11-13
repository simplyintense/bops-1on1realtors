import assert from "node:assert/strict";
import { test } from "node:test";
import {
  areaFromToolResult,
  areaKey,
  areaTier,
  AliasTable,
  CachedAreaResolver,
  CompositeAreaResolver,
  ExactAreaFallback,
  exactRef,
  islandOf,
  lookupAll,
  MarketAreaResolver,
  MemoryAreaResolver,
  parseIsland,
  parseRegion,
  refFor,
  REGIONS,
  type AreaLookup,
  type AreaRef,
  type Place,
  type ToolCaller,
} from "../flow/areas.ts";
import { aggregatePairs, pairFor, type AreaPair } from "../flow/area-learning.ts";
import type { Inquiry } from "../flow/engine.ts";
import { matchOurListings, rankCoBroke, rankOurListings } from "../flow/match.ts";
import type { CoBrokeHit } from "../flow/market-search.ts";
import type { Listing } from "../flow/source.ts";

/**
 * Geography for matching (realty/flow/areas.ts, match.ts, area-learning.ts), with an in-memory place list.
 * The places here are a test fixture, not a gazetteer: Westmoorings and Glencoe are neighbours in North
 * West, Maraval and Carenage are also North West, Woodbrook and Port of Spain are Port of Spain, and
 * Scarborough is Tobago. No network: the market is a fake ToolCaller or is absent.
 */

const PLACES: Place[] = [
  { name: "Westmoorings", region: "North West", neighbours: ["Glencoe", "Maraval"] },
  { name: "Glencoe", region: "North West", neighbours: ["Westmoorings"] },
  { name: "Maraval", region: "North West", neighbours: ["Westmoorings"] },
  { name: "Carenage", region: "North West", neighbours: [] },
  { name: "Woodbrook", region: "Port of Spain", neighbours: ["Port of Spain"] },
  { name: "Port of Spain", region: "Port of Spain", neighbours: ["Woodbrook"] },
  { name: "Scarborough", region: "Tobago", neighbours: ["Westmoorings"] },
];

const market = () => new MemoryAreaResolver(PLACES);
const composite = (aliases: AliasTable | null = null) => new CompositeAreaResolver({ aliases, market: market() });

const inq = (over: Partial<Inquiry> = {}): Inquiry => ({
  ref: "t-1",
  source: "property_inquiry",
  name: "Test Client",
  phone: "+1 868 555 0900",
  email: null,
  listingId: null,
  listingType: "rent",
  area: "Westmoorings",
  budget: { max: 9000, currency: "TTD" },
  beds: 2,
  message: "",
  ...over,
});

const listing = (id: string, area: string, over: Partial<Listing> = {}): Listing => ({
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

const hit = (area: string | null, over: Partial<CoBrokeHit> = {}): CoBrokeHit => ({
  title: `${area ?? "No area"} hit`,
  price: 6000,
  currency: "TTD",
  area,
  beds: 2,
  baths: 1,
  listingType: "rent",
  source: "otheragency",
  url: "https://example.com/a/1",
  ...over,
});

/** A fake ToolCaller: records each call and answers with whatever the function returns. */
function fakeCaller(answer: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const caller: ToolCaller = {
    async callTool(name, args) {
      calls.push({ name, args });
      return answer(name, args);
    },
  };
  return { caller, calls };
}

/** The tool result shape market-mcp returns: a spoken summary, then the JSON. */
const toolResult = (json: unknown) => ({ content: [{ type: "text", text: "A spoken summary." }, { type: "text", text: JSON.stringify(json) }] });

// ── Regions and islands ───────────────────────────────────────────────────────────────────────────

test("the six regions are exact strings; Tobago is Tobago, every other region is Trinidad", () => {
  assert.deepEqual([...REGIONS], ["Port of Spain", "North West", "East–West Corridor", "Central", "South", "Tobago"]);
  assert.equal(islandOf("Tobago"), "Tobago");
  assert.equal(islandOf("North West"), "Trinidad");
  assert.equal(islandOf("East–West Corridor"), "Trinidad");
  assert.equal(islandOf(null), null, "no region, no island");
  assert.equal(islandOf("Atlantis"), null, "a region that isn't one of the six isn't claimed for either island");
  assert.equal(parseRegion("  tobago "), "Tobago", "region names are read in any case");
});

test("the island is the payload's when it's there, and the region's when it isn't", () => {
  assert.equal(parseIsland(" tobago "), "Tobago");
  assert.equal(parseIsland("Atlantis"), null);
  const fromPayload = areaFromToolResult("x", toolResult({ area: "Glencoe", island: "Tobago", region: "North West", confidence: 0.95 }));
  assert.equal(fromPayload.island, "Tobago", "the payload's island wins over the region's");
  const fromRegion = areaFromToolResult("Glencoe", toolResult({ area: "Glencoe", region: "North West", confidence: 0.95 }));
  assert.equal(fromRegion.island, "Trinidad", "no island in the payload: the region gives it");
});

test("a Tobago area and a Trinidad area never match, whatever the neighbour weights say", async () => {
  const answers: Record<string, unknown> = {
    Scarborough: { area: "Scarborough", island: "Tobago", region: "Tobago", confidence: 0.95, neighbours: [{ area: "Westmoorings", weight: 0.99 }] },
    Westmoorings: { area: "Westmoorings", island: "Trinidad", region: "North West", confidence: 0.95, neighbours: [{ area: "Scarborough", weight: 0.99 }] },
  };
  const { caller } = fakeCaller((_name, args) => toolResult(answers[String(args.text)]));
  const r = new MarketAreaResolver(caller);
  const s = await refFor(r, "Scarborough");
  const w = await refFor(r, "Westmoorings");
  assert.deepEqual(areaTier(w, s), { tier: "excluded", reason: "excluded: Tobago vs Trinidad" });
  assert.deepEqual(areaTier(s, w), { tier: "excluded", reason: "excluded: Trinidad vs Tobago" });
});

test("areaKey ignores case, spacing and dash style", () => {
  assert.equal(areaKey("  East-West   Corridor "), areaKey("east–west corridor"));
  assert.notEqual(areaKey("Westmoorings"), areaKey("Westmoring"));
});

// ── Tiers and reasons ─────────────────────────────────────────────────────────────────────────────

test("tier reasons: same area, nearby (listing named first, with its weight), same region", async () => {
  const r = composite();
  const westmoorings = await refFor(r, "Westmoorings");
  assert.deepEqual(areaTier(westmoorings, await refFor(r, "westmoorings ")), { tier: "same-area", reason: "same area: Westmoorings" });
  assert.deepEqual(areaTier(westmoorings, await refFor(r, "Glencoe")), { tier: "neighbour", reason: "nearby: Glencoe for Westmoorings", weight: 0 });
  assert.deepEqual(areaTier(westmoorings, await refFor(r, "Carenage")), { tier: "same-region", reason: "same region: North West" });
});

test("no area asked for: any area fits, with the reason saying so", async () => {
  assert.deepEqual(areaTier(null, await refFor(composite(), "Glencoe")), { tier: "any", reason: "no area asked for" });
});

test("Tobago and Trinidad never cross-match, even when a neighbour list says they do", async () => {
  // Westmoorings lists Scarborough and Scarborough lists Westmoorings: the island rule still wins.
  const places: Place[] = [
    { name: "Westmoorings", region: "North West", neighbours: ["Glencoe", "Scarborough"] },
    { name: "Scarborough", region: "Tobago", neighbours: ["Westmoorings"] },
  ];
  const r = new CompositeAreaResolver({ market: new MemoryAreaResolver(places) });
  assert.deepEqual(areaTier(await refFor(r, "Westmoorings"), await refFor(r, "Scarborough")), { tier: "excluded", reason: "excluded: Tobago vs Trinidad" });
  assert.deepEqual(areaTier(await refFor(r, "Scarborough"), await refFor(r, "Westmoorings")), { tier: "excluded", reason: "excluded: Trinidad vs Tobago" });
});

test("an unmapped side matches only identical text, and nothing else", () => {
  const unmapped = (text: string): AreaRef => ({ text, match: null });
  assert.deepEqual(areaTier(unmapped("Nowhere Hill"), unmapped("nowhere  hill")), { tier: "same-area", reason: "same area: Nowhere Hill" });
  assert.deepEqual(areaTier(unmapped("Nowhere Hill"), unmapped("Glencoe")), { tier: "excluded", reason: "excluded" });
});

test("exact text (no resolver): case and spacing only, no neighbours, no regions", () => {
  assert.deepEqual(areaTier(exactRef("Westmoorings"), exactRef(" westmoorings")), { tier: "same-area", reason: "same area: Westmoorings" });
  assert.deepEqual(areaTier(exactRef("Westmoorings"), exactRef("Glencoe")), { tier: "excluded", reason: "excluded" });
});

// ── Aliases ───────────────────────────────────────────────────────────────────────────────────────

test("a local alias is checked first, and its canonical name takes the market's region, island and neighbours", async () => {
  // The market has "Hill View" as its own place (Central). Staff mapped it to Glencoe, and the alias wins.
  const places = [...PLACES, { name: "Hill View", region: "Central" as const, neighbours: [] }];
  const r = new CompositeAreaResolver({
    aliases: new AliasTable([{ alias: "Hill View", canonical: "Glencoe" }]),
    market: new MemoryAreaResolver(places),
  });
  const l = await r.lookup("  hill VIEW ");
  assert.equal(l.source, "alias");
  assert.equal(l.canonical, "Glencoe");
  assert.equal(l.region, "North West", "the market's region for Glencoe, not Central");
  assert.equal(l.island, "Trinidad");
  assert.deepEqual(l.neighbours, [{ area: "Westmoorings", weight: 0 }]);
  assert.equal(l.query, "  hill VIEW ", "the query is kept as asked");
});

test("with the market down, an alias still gives its canonical name (same area), with no region", async () => {
  const failing = { lookup: async () => { throw new Error("down"); }, resolve: async () => { throw new Error("down"); } };
  const r = new CompositeAreaResolver({ aliases: new AliasTable([{ alias: "Glen Cove", canonical: "Glencoe" }]), market: failing });
  assert.deepEqual(await r.resolve("glen  cove"), { canonical: "Glencoe", region: null, island: null, neighbours: [] });
});

test("a later alias for the same name wins", () => {
  const t = new AliasTable([{ alias: "Wood Brook", canonical: "Glencoe" }, { alias: "wood brook", canonical: "Maraval" }]);
  assert.equal(t.canonicalFor("WOOD  BROOK"), "Maraval");
  assert.equal(t.canonicalFor("Carenage"), null);
});

// ── Matching through the composite ────────────────────────────────────────────────────────────────

test("ranking: same area first, then a neighbour, then the same region, cheapest first within a tier", async () => {
  const r = composite();
  const listings = [
    listing("A", "Carenage", { price: 4000 }),
    listing("B", "Glencoe", { price: 4500 }),
    listing("C", "Westmoorings", { price: 6000 }),
    listing("D", "Westmoorings", { price: 5500 }),
    listing("E", "Scarborough", { price: 3000 }),
  ];
  const ranked = await rankOurListings(inq(), listings, r);
  assert.deepEqual(
    ranked.map((x) => [x.item.id, x.tier, x.reason]),
    [
      ["D", "same-area", "same area: Westmoorings"],
      ["C", "same-area", "same area: Westmoorings"],
      ["B", "neighbour", "nearby: Glencoe for Westmoorings"],
      ["A", "same-region", "same region: North West"],
    ],
    "Scarborough (Tobago) is dropped; the tiers come before price",
  );
});

test("Westmoorings and Scarborough never match in either direction", async () => {
  const r = composite();
  assert.deepEqual((await rankOurListings(inq(), [listing("S", "Scarborough", { price: 1 })], r)).map((x) => x.item.id), []);
  assert.deepEqual((await rankOurListings(inq({ area: "Scarborough" }), [listing("W", "Westmoorings")], r)).map((x) => x.item.id), []);
});

test("inside the neighbour tier, the higher market weight comes first, then the cheaper price; other tiers stay price-only", async () => {
  const places: Place[] = [
    { name: "Westmoorings", region: "North West", neighbours: [{ area: "Glencoe", weight: 0.6 }, { area: "Maraval", weight: 0.9 }, { area: "Diego Martin", weight: 0.9 }] },
    { name: "Glencoe", region: "North West" },
    { name: "Maraval", region: "North West" },
    { name: "Diego Martin", region: "North West" },
    { name: "Carenage", region: "North West" },
  ];
  const r = new CompositeAreaResolver({ market: new MemoryAreaResolver(places) });
  const listings = [listing("G", "Glencoe", { price: 3000 }), listing("M", "Maraval", { price: 6000 }), listing("D", "Diego Martin", { price: 5000 }), listing("C", "Carenage", { price: 1000 })];
  const ranked = await rankOurListings(inq(), listings, r);
  assert.deepEqual(ranked.map((x) => [x.item.id, x.tier, x.weight]), [["D", "neighbour", 0.9], ["M", "neighbour", 0.9], ["G", "neighbour", 0.6], ["C", "same-region", 0]]);
});

test("when both areas list each other, the higher of the two weights is the one used", async () => {
  const places: Place[] = [
    { name: "Westmoorings", region: "North West", neighbours: [{ area: "Glencoe", weight: 0.4 }] },
    { name: "Glencoe", region: "North West", neighbours: [{ area: "Westmoorings", weight: 0.9 }] },
  ];
  const r = new CompositeAreaResolver({ market: new MemoryAreaResolver(places) });
  assert.deepEqual(areaTier(await refFor(r, "Westmoorings"), await refFor(r, "Glencoe")), { tier: "neighbour", reason: "nearby: Glencoe for Westmoorings", weight: 0.9 });
  assert.deepEqual(areaTier(await refFor(r, "Glencoe"), await refFor(r, "Westmoorings")), { tier: "neighbour", reason: "nearby: Westmoorings for Glencoe", weight: 0.9 });
});

test("co-broke hits are ranked client-side too: a Scarborough hit is dropped, a neighbour hit is kept with its reason", async () => {
  const r = composite();
  const hits = [hit("Scarborough"), hit("Glencoe"), hit(null), hit("Carenage", { price: 9999999 }), hit("Carenage", { price: 4000 })];
  const ranked = await rankCoBroke(inq(), hits, r);
  assert.deepEqual(
    ranked.map((x) => [x.item.area, x.item.price, x.tier, x.reason]),
    [
      ["Glencoe", 6000, "neighbour", "nearby: Glencoe for Westmoorings"],
      ["Carenage", 4000, "same-region", "same region: North West"],
    ],
    "Tobago is dropped; a hit with no area is dropped; the over-budget Carenage is dropped; the affordable one stays",
  );
});

test("co-broke hits with no inquiry area are kept as 'any'", async () => {
  const r = composite();
  const ranked = await rankCoBroke(inq({ area: null }), [hit("Scarborough"), hit(null)], r);
  assert.deepEqual(ranked.map((x) => [x.tier, x.reason]), [["any", "no area asked for"], ["any", "no area asked for"]]);
});

test("without a resolver, co-broke hits use exact text", async () => {
  const ranked = await rankCoBroke(inq(), [hit("Glencoe"), hit("westmoorings  ")], new ExactAreaFallback());
  assert.deepEqual(ranked.map((x) => x.reason), ["same area: Westmoorings"], "the inquiry's spelling is the one shown");
});

test("the fixed filters still apply: our own listing, status, type, budget currency and beds", async () => {
  const r = composite();
  const listings = [
    listing("OWN", "Westmoorings"),
    listing("SOLD", "Westmoorings", { status: "sold" }),
    listing("SALE", "Westmoorings", { listingType: "sale" }),
    listing("USD", "Westmoorings", { currency: "USD", price: 1000 }),
    listing("SMALL", "Westmoorings", { beds: 1 }),
    listing("OK", "Westmoorings"),
  ];
  const got = await rankOurListings(inq({ listingId: "OWN" }), listings, r);
  assert.deepEqual(got.map((x) => x.item.id), ["OK"]);
});

test("matchOurListings (no resolver) keeps its old answer for the old rules", () => {
  const listings = [listing("L-101", "Woodbrook"), listing("L-103", "Woodbrook", { price: 7000 }), listing("L-104", "Maraval")];
  assert.deepEqual(matchOurListings(inq({ listingId: "L-101", area: "Woodbrook" }), listings).map((l) => l.id), ["L-103"]);
  assert.deepEqual(matchOurListings(inq({ area: null, listingType: null, budget: null, beds: null }), listings), [], "nothing to search on");
});

// ── Fallback when the resolver is down ────────────────────────────────────────────────────────────

test("when the market is down, exact text still matches; a different spelling or a neighbour does not", async () => {
  const down = { lookup: async () => { throw new Error("timed out"); }, resolve: async () => { throw new Error("timed out"); } };
  const r = new CompositeAreaResolver({ market: down });
  const listings = [listing("SAME", " westmoorings"), listing("NEAR", "Glencoe"), listing("SPELL", "Westmoring")];
  assert.deepEqual((await rankOurListings(inq(), listings, r)).map((x) => [x.item.id, x.tier]), [["SAME", "same-area"]]);
});

test("with the market unset, the composite is exact text, with nothing else", async () => {
  const r = new CompositeAreaResolver();
  assert.deepEqual(await r.resolve("  Woodbrook "), { canonical: "Woodbrook", region: null, island: null, neighbours: [] });
  assert.equal((await r.lookup("Woodbrook")).source, "exact");
  assert.equal(await r.resolve("   "), null, "empty text has no area");
});

// ── Unmapped areas ────────────────────────────────────────────────────────────────────────────────

test("an unrecognised area is unmapped: the lookup says so and resolve() is null", async () => {
  const l = await composite().lookup("Nowhere Hill");
  assert.equal(l.mapped, false);
  assert.equal(l.query, "Nowhere Hill");
  assert.equal(l.source, "market");
  assert.equal(await composite().resolve("Nowhere Hill"), null);
});

test("lookupAll: once per area key, and an area whose lookup throws is left out (not flagged)", async () => {
  const flaky = {
    calls: 0,
    async lookup(text: string): Promise<AreaLookup> {
      this.calls += 1;
      if (text === "Broken") throw new Error("boom");
      return new ExactAreaFallback().lookup(text);
    },
    async resolve() {
      return null;
    },
  };
  const got = await lookupAll(flaky, ["Woodbrook", " woodbrook", "Broken", "Broken", ""]);
  assert.deepEqual(got.map((x) => x.query), ["Woodbrook"]);
  assert.equal(flaky.calls, 2, "Woodbrook and Broken are asked once each; the empty text is never asked");
});

// ── Market resolve_area: parsing ──────────────────────────────────────────────────────────────────

test("high confidence: the area, island, region, municipality and weighted neighbours are read from the JSON block", () => {
  const l = areaFromToolResult(
    "westmoorings",
    toolResult({
      area: "Westmoorings",
      island: "Trinidad",
      region: "North West",
      municipality: "Diego Martin",
      neighbours: [{ area: "Glencoe", weight: 0.9 }, { area: " Maraval ", weight: 0.4 }, { area: "Glencoe", weight: 0.7 }],
      confidence: 0.93,
      suggestions: [],
    }),
  );
  assert.equal(l.mapped, true);
  assert.equal(l.canonical, "Westmoorings");
  assert.equal(l.island, "Trinidad");
  assert.equal(l.region, "North West");
  assert.equal(l.municipality, "Diego Martin");
  assert.deepEqual(l.neighbours, [{ area: "Glencoe", weight: 0.9 }, { area: "Maraval", weight: 0.4 }], "trimmed and de-duplicated, the higher weight kept");
  assert.equal(l.confidence, "high");
});

test("plain neighbour names are accepted too, with weight 0", () => {
  const l = areaFromToolResult("Glencoe", toolResult({ area: "Glencoe", region: "North West", neighbours: ["Westmoorings", "Westmoorings"], confidence: 0.9 }));
  assert.deepEqual(l.neighbours, [{ area: "Westmoorings", weight: 0 }]);
});

test("confidence is a number from 0 to 1: 0.8 or more is high; below it is low and unmapped, with its suggestions", () => {
  assert.equal(areaFromToolResult("x", toolResult({ area: "Glencoe", region: "North West", confidence: 0.8 })).mapped, true, "0.8 itself is high");
  const low = areaFromToolResult("Westmoring", toolResult({ area: "Westmoorings", region: "North West", confidence: 0.5, suggestions: ["Westmoorings", "Westmorland"] }));
  assert.equal(low.mapped, false);
  assert.equal(low.canonical, "Westmoorings", "the guess is kept for the desk");
  assert.equal(low.confidence, "low");
  assert.deepEqual(low.suggestions, ["Westmoorings", "Westmorland"]);
  assert.equal(low.neighbours.length, 0, "this answer named no neighbours");
});

test("the string \"low\" is unmapped too, and the suggestions come through (old fixtures)", () => {
  const l = areaFromToolResult("Westmoring", toolResult({ area: "Westmoorings", region: "North West", confidence: "low", suggestions: ["Westmoorings"] }));
  assert.equal(l.mapped, false);
  assert.deepEqual(l.suggestions, ["Westmoorings"]);
});

test("an unresolved answer (area null) is unmapped, and its suggestions reach the desk", () => {
  const l = areaFromToolResult("Westmoring", toolResult({ area: null, unresolved: true, suggestions: ["Westmoorings"] }));
  assert.equal(l.mapped, false);
  assert.equal(l.canonical, null);
  assert.equal(l.confidence, null);
  assert.deepEqual(l.suggestions, ["Westmoorings"]);
});

test("no confidence is unmapped; a non-list of neighbours is ignored, not split", () => {
  assert.equal(areaFromToolResult("Westmoorings", toolResult({ area: "Westmoorings", region: "North West" })).mapped, false, "an answer with no confidence isn't trusted");
  const oddLists = areaFromToolResult("Glencoe", toolResult({ area: "Glencoe", region: "North West", confidence: 0.95, neighbours: "Westmoorings", suggestions: null }));
  assert.equal(oddLists.mapped, true);
  assert.deepEqual(oddLists.neighbours, [], "a string where a list belongs is ignored, not split");
  assert.deepEqual(oddLists.suggestions, []);
});

test("an explicit high confidence with an unknown region keeps the area and drops the region and island", () => {
  const l = areaFromToolResult("Glencoe", toolResult({ area: "Glencoe", region: "Atlantis", confidence: 0.95 }));
  assert.equal(l.mapped, true);
  assert.equal(l.region, null, "a region we don't know isn't claimed for an island");
  assert.equal(l.island, null);
});

test("structuredContent is read too; a spoken summary alone is unmapped", () => {
  const structured = areaFromToolResult("Glencoe", { structuredContent: { area: "Glencoe", region: "North West", confidence: 0.9 }, content: [] });
  assert.equal(structured.mapped, true);
  const spoken = areaFromToolResult("Glencoe", { content: [{ type: "text", text: "Glencoe is in North West." }] });
  assert.equal(spoken.mapped, false);
  assert.deepEqual(spoken.suggestions, []);
});

// ── Market resolve_area: the call, the cooldown ───────────────────────────────────────────────────

test("MarketAreaResolver asks resolve_area with { text } and parses the answer", async () => {
  const { caller, calls } = fakeCaller(() => toolResult({ area: "Glencoe", island: "Trinidad", region: "North West", neighbours: [{ area: "Westmoorings", weight: 0.9 }], confidence: 0.95 }));
  const r = new MarketAreaResolver(caller);
  assert.deepEqual(await r.resolve(" Glencoe "), { canonical: "Glencoe", region: "North West", island: "Trinidad", neighbours: [{ area: "Westmoorings", weight: 0.9 }] });
  assert.deepEqual(calls, [{ name: "resolve_area", args: { text: "Glencoe" } }]);
  assert.equal(await r.resolve("   "), null);
  assert.equal(calls.length, 1, "empty text is never sent");
});

test("MarketAreaResolver: a failure throws, and nothing is asked during the cooldown", async () => {
  let now = 0;
  let fail = true;
  const { caller, calls } = fakeCaller(() => {
    if (fail) throw new Error("timed out");
    return toolResult({ area: "Glencoe", region: "North West", confidence: 0.95 });
  });
  const r = new MarketAreaResolver(caller, { now: () => now, cooldownMs: 60_000 });
  await assert.rejects(r.lookup("Glencoe"), /timed out/);
  now = 30_000;
  await assert.rejects(r.lookup("Maraval"), /cooling down/);
  assert.equal(calls.length, 1, "the second lookup didn't go out");
  now = 61_000;
  fail = false;
  assert.equal((await r.lookup("Glencoe")).mapped, true);
});

test("CachedAreaResolver: one inner call per area key; a failure is passed on and not kept", async () => {
  let inner = 0;
  let fail = true;
  const source = {
    async lookup(text: string): Promise<AreaLookup> {
      inner += 1;
      if (fail) throw new Error("down");
      return new ExactAreaFallback().lookup(text);
    },
    async resolve() {
      return null;
    },
  };
  const c = new CachedAreaResolver(source);
  await assert.rejects(c.lookup("Woodbrook"), /down/);
  fail = false;
  await c.lookup("Woodbrook");
  const again = await c.lookup("  woodbrook ");
  assert.equal(again.query, "  woodbrook ", "the cached answer carries the query as asked");
  assert.equal(inner, 2, "the failure wasn't cached, the success was");
});

// ── Learning records (data only) ──────────────────────────────────────────────────────────────────

test("pairFor: nothing to learn without an inquiry area, a listing area, or with tier 'any'", () => {
  assert.equal(pairFor(null, "Glencoe", "neighbour", "approved", "t"), null);
  assert.equal(pairFor("Westmoorings", null, "neighbour", "approved", "t"), null);
  assert.equal(pairFor("Westmoorings", "Glencoe", "any", "approved", "t"), null);
  assert.deepEqual(pairFor("Westmoorings", "Glencoe", "neighbour", "rejected", "t"), { inquiryArea: "Westmoorings", listingArea: "Glencoe", tier: "neighbour", signal: "rejected", at: "t" });
});

test("aggregatePairs counts by signal, by tier and by pair, busiest pair first", () => {
  const p = (inquiryArea: string, listingArea: string, tier: AreaPair["tier"], signal: AreaPair["signal"]): AreaPair => ({ inquiryArea, listingArea, tier, signal, at: "t" });
  const stats = aggregatePairs([
    p("Westmoorings", "Glencoe", "neighbour", "approved"),
    p("westmoorings", "glencoe", "neighbour", "rejected"),
    p("Westmoorings", "Carenage", "same-region", "rejected"),
  ]);
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.bySignal, { approved: 1, rejected: 2 });
  assert.deepEqual(stats.byTier.find((t) => t.tier === "neighbour"), { tier: "neighbour", approved: 1, rejected: 1 });
  assert.deepEqual(stats.byTier.find((t) => t.tier === "same-area"), { tier: "same-area", approved: 0, rejected: 0 });
  assert.deepEqual(stats.byPair[0], { inquiryArea: "Westmoorings", listingArea: "Glencoe", tier: "neighbour", approved: 1, rejected: 1 });
  assert.equal(stats.byPair.length, 2);
});
