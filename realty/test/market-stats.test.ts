import assert from "node:assert/strict";
import test from "node:test";
import { MarketStripCache, MARKET_STRIP_TTL_MS, stripFromStats, type MarketStrip } from "../flow/market-stats.ts";
import { staffMarketStrip } from "../node/market-stats.ts";
import { fakeCaller, fakeMarketFetch, reply } from "./desk-fakes.ts";

const STATS = {
  total: 2000,
  active: 1474,
  clusters: 900,
  bySource: { a: 800, b: 674 },
  byArea: { Westmoorings: 40, Maraval: 30, "(none)": 5, Glencoe: 12 },
  byListingType: { sale: { count: 900, minPrice: 1, maxPrice: 2, avgPrice: 1.5 } },
};

function resultOf(payload: unknown) {
  return reply(payload);
}

test("stripFromStats: listings is active, areas are named byArea keys, (none) is left out", () => {
  const strip = stripFromStats(resultOf(STATS));
  assert.deepEqual(strip, { listings: 1474, areas: 3 });
  assert.notEqual(strip?.listings, STATS.total, "inactive rows are not counted as listings");
});

test("stripFromStats: no invented numbers — missing active, or no JSON, is null", () => {
  assert.equal(stripFromStats(resultOf({ total: 2000, byArea: { Westmoorings: 1 } })), null);
  assert.equal(stripFromStats(resultOf("not an object")), null);
  assert.equal(stripFromStats({ content: [{ type: "text", text: "just a summary" }] }), null);
  assert.equal(stripFromStats(null), null);
});

test("stripFromStats: without byArea, listings still show and areas is null (the area counter is omitted)", () => {
  assert.deepEqual(stripFromStats(resultOf({ active: 10 })), { listings: 10, areas: null });
  assert.deepEqual(stripFromStats(resultOf({ active: 10, byArea: [] })), { listings: 10, areas: null });
});

test("stripFromStats never invents a sub-area count: there is no such field on market_stats", () => {
  const strip = stripFromStats(resultOf({ ...STATS, subAreas: 99, sub_areas: 99, clusters: 900 })) as MarketStrip;
  assert.deepEqual(strip, { listings: 1474, areas: 3 });
  assert.ok(!("subAreas" in strip) && !("sub_areas" in strip));
});

test("a 10-minute cache: a second read within the TTL does not call the tool again", async () => {
  const f = fakeCaller({ market_stats: STATS });
  const cache = new MarketStripCache();
  const first = await cache.read(f.caller, 1_000);
  const second = await cache.read(f.caller, 1_000 + MARKET_STRIP_TTL_MS - 1);
  assert.deepEqual(first, { listings: 1474, areas: 3 });
  assert.equal(second, first);
  assert.equal(f.calls.filter((c) => c.tool === "market_stats").length, 1);
  assert.deepEqual(f.calls[0].args, {});
});

test("after the TTL, the tool is called again; a failure keeps the last good strip and is not cached", async () => {
  let n = 0;
  const f = fakeCaller({
    market_stats: () => {
      n += 1;
      if (n === 2) throw new Error("down");
      return n === 1 ? STATS : { ...STATS, active: 1500, byArea: { Westmoorings: 1 } };
    },
  });
  const cache = new MarketStripCache();
  const first = await cache.read(f.caller, 0);
  const stale = await cache.read(f.caller, MARKET_STRIP_TTL_MS);
  assert.deepEqual(first, { listings: 1474, areas: 3 });
  assert.equal(stale, first, "the last good strip is kept when the refresh fails");
  const fresh = await cache.read(f.caller, MARKET_STRIP_TTL_MS);
  assert.deepEqual(fresh, { listings: 1500, areas: 1 });
  assert.equal(n, 3);
});

test("not configured: the strip is null, and nothing is invented", async () => {
  const cache = new MarketStripCache();
  assert.equal(await cache.read(null, 0), null);
  const off = await staffMarketStrip({ env: {}, cache: new MarketStripCache() });
  assert.equal(off, null);
});

test("the node wrapper reads market_stats through MarketClient, read-only, and uses the cache", async () => {
  const env = { ONEON1_MARKET_SEARCH_URL: "http://127.0.0.1:8787/mcp", ONEON1_MARKET_SEARCH_TOKEN: "test-token-not-real-0123" };
  const fake = fakeMarketFetch({ answers: { market_stats: STATS } });
  const cache = new MarketStripCache();
  const first = await staffMarketStrip({ env, fetcher: fake.fetcher, cache, now: 0 });
  const second = await staffMarketStrip({ env, fetcher: fake.fetcher, cache, now: 1_000 });
  assert.deepEqual(first, { listings: 1474, areas: 3 });
  assert.equal(second, first);
  assert.deepEqual(fake.tools(), ["market_stats"]);
  assert.ok(fake.calls.every((c) => c.tool === "market_stats" && Object.keys(c.args).length === 0));
});
