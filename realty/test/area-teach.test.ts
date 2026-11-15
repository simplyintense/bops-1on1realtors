import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryAreaResolver } from "../flow/areas.ts";
import { automatchPairs, type AutomatchAsk } from "../flow/automatch.ts";
import { withTaught, parseAreaTeachFile, placeKey, taughtVerdict, nearbyDriveLabel, type TaughtAreas } from "../flow/taught-areas.ts";
import { knowledgeOf } from "../flow/area-knowledge.ts";
import { matchOurListings, type LiveRequest } from "../flow/live-match.ts";
import type { Listing } from "../flow/source.ts";
import { matchingKnowledgeFrom, SearchStore } from "../node/search-store.ts";

/**
 * Taught nearby areas (realty/data/area-nearby-ai-maps.json, taught_by "ai-maps"): parsing, the verdict rules, the matching it
 * drives, the undo, and that the taught rows stay out of the shared knowledge. Invented listings only; no network.
 */

const DATA = new URL("../data/area-nearby-ai-maps.json", import.meta.url).pathname;
const file = () => parseAreaTeachFile(JSON.parse(readFileSync(DATA, "utf8")));

const listing = (over: Partial<Listing>): Listing => ({
  id: "L", title: "Test flat", listingType: "rent", area: "Woodbrook", price: 9000, currency: "TTD", beds: 2, baths: 1, agentId: 7, status: "active", url: "", ttdEquiv: null, ...over,
});

const RENT: LiveRequest = { intent: "rent", area: "Maraval", beds: 2, propertyType: "apartment", priceMin: null, priceMax: 9000, currency: "TTD", monthly: true };

// A resolver that says Maraval, Woodbrook and St. Ann's are neighbours, the way the market's lists can. Taught pairs must override it.
const AREAS = new MemoryAreaResolver([
  { name: "Maraval", region: "North West", neighbours: ["Woodbrook", "St. Ann's", "Glencoe"] },
  { name: "Woodbrook", region: "Port of Spain", neighbours: ["Maraval"] },
  { name: "St. Ann's", region: "Port of Spain", neighbours: ["Maraval", "Glencoe"] },
  { name: "Glencoe", region: "North West", neighbours: ["Maraval", "St. Ann's"] },
  { name: "West Hills", region: "North West", neighbours: ["Glencoe"] },
]);

function storeWithTeaching(): { root: string; taught: TaughtAreas } {
  const root = mkdtempSync(join(tmpdir(), "area-teach-"));
  const store = SearchStore.open(root);
  try {
    store.teachAreas(file(), "ai-maps", "2026-11-14T12:00:00.000Z");
    return { root, taught: store.taughtAreas() };
  } finally {
    store.close();
  }
}

test("the research file parses: 84 places with coordinates, 6 aliases, 964 pairs of which 431 are nearby", () => {
  const f = file();
  assert.equal(f.places.length, 84);
  assert.equal(f.places.filter((p) => p.lat != null && p.lon != null).length, 84);
  assert.equal(f.aliases.length, 6);
  assert.equal(f.relations.length, 964);
  assert.equal(f.relations.filter((r) => r.nearby).length, 431);
  assert.ok(f.relations.every((r) => !r.nearby || (r.minutes ?? 99) <= 15), "nearby is at most 15 minutes");
  const longCircular = f.places.find((p) => p.name === "Long Circular");
  assert.ok(longCircular && longCircular.lat! > 10.66, "the fixed Long Circular coordinates, not the south-Trinidad ones");
  assert.match(f.places[0].note ?? "", /OpenStreetMap|OSRM/, "each row keeps the file's source note");
  assert.throws(() => parseAreaTeachFile({ pairs: "nope" }), /pairs must be a list/);
});

test("a re-run is idempotent: the same counts and rows, and the taught rows stay out of the shared knowledge and the Teach list", () => {
  const root = mkdtempSync(join(tmpdir(), "area-teach-"));
  const store = SearchStore.open(root);
  try {
    const before = store.knownTerms().length;
    const first = store.teachAreas(file(), "ai-maps");
    const again = store.teachAreas(file(), "ai-maps");
    assert.deepEqual(first, again);
    assert.equal(store.taughtAreas().relations.length, 964);
    assert.equal(store.taughtAreas().places.length, 84);
    assert.equal(store.knownTerms().length, before, "knownTerms doesn't pick the taught places up");
    assert.equal(store.taught().length, 0, "the Teach page's taught list doesn't get them");
  } finally {
    store.close();
  }
});

test("the verdict: same name is the same area; listed nearby is a neighbour; any other taught pair is apart; unknown areas keep today's rules", () => {
  const { taught } = storeWithTeaching();
  assert.deepEqual(taughtVerdict(taught, "Woodbrook", "Woodbrook"), { tier: "same" });
  assert.deepEqual(taughtVerdict(taught, "St James", "St. James"), { tier: "same" }, "punctuation and an alias are one place");
  assert.deepEqual(taughtVerdict(taught, "St Ann's", "St. Ann's"), { tier: "same" });
  assert.deepEqual(taughtVerdict(taught, "MOKA", "Moka"), { tier: "same" }, "MOKA is Moka");
  assert.deepEqual(taughtVerdict(taught, "La Romain", "La Romaine"), { tier: "same" }, "the La Romain alias");
  assert.equal(taughtVerdict(taught, "Maraval", "Woodbrook")?.tier, "apart", "different markets: not nearby, though 8 min apart");
  assert.equal(taughtVerdict(taught, "St Ann's", "Glencoe")?.tier, "apart");
  const wh = taughtVerdict(taught, "West Hills", "Glencoe");
  assert.deepEqual(wh, { tier: "nearby", minutes: 9, km: 7 }, "West Hills and Glencoe are taught as nearby, 9 min");
  assert.equal(taughtVerdict(taught, "Maraval", "Chaguanas")?.tier, "apart", "Chaguanas is taught too, and not a neighbour of Maraval");
  assert.equal(taughtVerdict(taught, "Maraval", "Nowhere Hill"), null, "an area that isn't taught keeps today's rules");
  assert.equal(taughtVerdict(taught, "Maraval", null), null);
  assert.equal(taughtVerdict(null, "Maraval", "Woodbrook"), null, "nothing taught: null");
  assert.equal(placeKey("St. Ann's"), placeKey("St Anns"));
  assert.equal(nearbyDriveLabel("Woodbrook", 3.2), "Nearby (Woodbrook, ~3 min drive)");
});

test("matching: taught pairs decide over the market's neighbour lists; the taught rows, not the resolver, say who is nearby", async () => {
  const { taught } = storeWithTeaching();
  const listings = [
    listing({ id: "wb", title: "Woodbrook flat", area: "Woodbrook" }),
    listing({ id: "sa", title: "St. Ann's flat", area: "St. Ann's" }),
    listing({ id: "gl", title: "Glencoe flat", area: "Glencoe" }),
  ];
  const withoutTaught = await matchOurListings(RENT, listings, AREAS);
  assert.deepEqual(withoutTaught.map((m) => m.title).sort(), ["Glencoe flat", "St. Ann's flat", "Woodbrook flat"], "the market's lists alone make all three neighbours");
  const withTaught = await matchOurListings(RENT, listings, AREAS, 5, withTaught0(taught));
  // The data: Woodbrook and St. Ann's are other markets (not nearby); Glencoe is the same market, 12.9 min (nearby).
  assert.deepEqual(withTaught.map((m) => m.title), ["Glencoe flat"], "Woodbrook and St. Ann's are out; Glencoe is taught nearby");
  assert.equal(withTaught[0].reason, "Nearby (Glencoe, ~13 min drive), TT$9,000 for a TT$9,000 budget, 2 bed, our listing");

  const hills: LiveRequest = { ...RENT, area: "West Hills", beds: null };
  const glencoe = await matchOurListings(hills, [listing({ id: "gl", title: "NEWBURY HILL EXTENSION", area: "Glencoe", price: 8500, beds: 3 })], AREAS, 5, withTaught0(taught));
  assert.equal(glencoe.length, 1, "West Hills and Glencoe are taught nearby, so the West Hills block for Glencoe doesn't apply");
  assert.equal(glencoe[0].reason, "Nearby (Glencoe, ~9 min drive), TT$8,500 for a TT$9,000 budget, 3 bed, our listing");
});

test("matching: a taught place's own name is the same area, and a non-taught listing still uses the other rules", async () => {
  const { taught } = storeWithTeaching();
  const k = withTaught0(taught);
  const got = await matchOurListings({ ...RENT, area: "Woodbrook" }, [listing({ id: "w", title: "Woodbrook flat", area: "Woodbrook" })], AREAS, 5, k);
  assert.equal(got[0]?.reason, "in Woodbrook, TT$9,000 for a TT$9,000 budget, 2 bed, our listing");
  // Chaguanas isn't taught: the resolver's lists (none here) and the old rules decide, so it isn't matched.
  assert.deepEqual(await matchOurListings({ ...RENT, area: "Woodbrook" }, [listing({ id: "c", area: "Chaguanas" })], AREAS, 5, k), []);
});

test("the taught coordinates replace the snapshot's: Long Circular and Bayshore are no longer in the south", () => {
  const { taught } = storeWithTeaching();
  const idx = withTaught0(taught);
  const lc = knowledgeOf(idx, "Long Circular")?.coords;
  assert.ok(lc && Math.abs(lc.lat - 10.6745) < 0.001 && Math.abs(lc.lon + 61.53) < 0.001);
  const bay = knowledgeOf(idx, "Bayshore")?.coords;
  assert.ok(bay && bay.lat > 10.67);
});

test("automatch uses the same taught rules and shows the drive minutes; a USD ask matches a TTD listing", async () => {
  const { taught } = storeWithTeaching();
  const now = new Date("2026-11-14T12:00:00.000Z");
  const ask: AutomatchAsk = { id: "a", area: "West Hills", beds: null, budget: 9000, currency: "TTD", type: null, listingType: "rent", lastSeenAt: now.toISOString() };
  const pairs = await automatchPairs([ask], [listing({ id: "gl", title: "Glencoe flat", area: "Glencoe", price: 8500, beds: 2 })], AREAS, now, withTaught0(taught));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].areaRelation, "nearby");
  assert.match(pairs[0].reason, /^Nearby \(Glencoe, ~9 min drive\)/);

  const usd: AutomatchAsk = { ...ask, id: "u", area: "Woodbrook", budget: 1_400, currency: "USD" };
  const ttd = listing({ id: "t", title: "Woodbrook TT flat", area: "Woodbrook", listingType: "rent", price: 9_000, currency: "TTD", beds: 2 });
  const hit = await automatchPairs([usd], [ttd], AREAS, now, withTaught0(taught));
  assert.equal(hit.length, 1, "US$1,400 is TT$9,492 at the fixed rate, so TT$9,000 is within it");
});

test("undo returns matching to today's behaviour: the same answer as with no taught data at all", async () => {
  const { root, taught } = storeWithTeaching();
  const listings = [listing({ id: "wb", title: "Woodbrook flat", area: "Woodbrook" })];
  assert.equal((await matchOurListings(RENT, listings, AREAS, 5, withTaught0(taught))).length, 0);
  const store = SearchStore.open(root);
  try {
    assert.deepEqual(store.undoAreaTeach("ai-maps"), { places: 84, aliases: 6, pairs: 964 });
    assert.deepEqual(store.taughtAreas(), { places: [], aliases: [], relations: [] });
  } finally {
    store.close();
  }
  const undone = matchingKnowledgeFrom(root);
  assert.equal(undone?.taught, undefined, "nothing taught after undo");
  // The same answer as a store that never had the teaching (no database at all).
  const never = matchingKnowledgeFrom(mkdtempSync(join(tmpdir(), "area-never-")));
  assert.deepEqual(await matchOurListings(RENT, listings, AREAS, 5, undone), await matchOurListings(RENT, listings, AREAS, 5, never));
  // Back to today's rules: the resolver's neighbour list, and the snapshot's distance for the reason.
  const back = await matchOurListings(RENT, listings, AREAS, 5, undone);
  assert.equal(back.length, 1, "Woodbrook is a neighbour again, as before the teaching");
  assert.match(back[0].reason ?? "", /^Woodbrook, about \d+ min from Maraval, in budget$/);
});

test("the CLI teaches and undoes, printing counts only", () => {
  const root = mkdtempSync(join(tmpdir(), "area-teach-cli-"));
  const cli = new URL("../cli/area-teach.ts", import.meta.url).pathname;
  const run = (args: string[]) => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
  const taught = run(["--file", DATA, "--by", "ai-maps", "--root", root]);
  assert.match(taught, /Taught by "ai-maps": places 84, aliases 6, pairs 964 \(nearby 431, not nearby 533\)\./);
  assert.match(run(["--undo", "ai-maps", "--root", root]), /Undone for "ai-maps": places 84, aliases 6, pairs 964\./);
});

/** The matcher's index for these tests: no volume or bundled snapshot, just the taught places and pairs. */
function withTaught0(taught: TaughtAreas) {
  return withTaught(null, taught);
}
