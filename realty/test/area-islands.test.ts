import assert from "node:assert/strict";
import { test } from "node:test";
import {
  areaFromToolResult,
  areaTier,
  CompositeAreaResolver,
  ExactAreaFallback,
  islandNamedIn,
  isNearSpelling,
  isStreetName,
  MarketAreaResolver,
  MemoryAreaResolver,
  refFor,
  type AreaResolver,
  type ToolCaller,
} from "../flow/areas.ts";
import { ourAreaContext, ourAreaRelation, type OurAreaRelation } from "../flow/live-match.ts";
import { namesPlace } from "../extract.ts";
import type { Listing } from "../flow/source.ts";

/**
 * Place-level island rules (realty/flow/areas.ts, live-match.ts, extract.ts): a Tobago brief never reaches a Trinidad place, a
 * compound Trinidad name is not its first word, a street is not a place, and a short name's one-letter neighbour is not the same
 * place. Invented places and listings only. No network: the directory is an in-memory list or a fake market.
 */

const DIRECTORY = new MemoryAreaResolver([
  { name: "Westmoorings", region: "North West" },
  { name: "Gasparee Island", region: "North West" },
  { name: "Shorelands", region: "North West" },
  { name: "Petit Valley", region: "North West" },
  { name: "West Hills", region: "North West" },
  { name: "Goodwood Park", region: "North West" },
  { name: "Goodwood Gardens", region: "North West" },
  { name: "Goodwood Heights", region: "North West" },
  { name: "Hermitage", region: "South" },
  { name: "Goodwood", region: "Tobago" },
  { name: "Scarborough", region: "Tobago" },
  { name: "Shirvan", region: "Tobago" },
  { name: "West Tobago", region: "Tobago" },
  { name: "Tobago Plantations", region: "Tobago" },
]);

const LISTING = (id: string, area: string, over: Partial<Listing> = {}): Listing => ({
  id,
  title: `${area} house`,
  listingType: "sale",
  area,
  price: 4_000_000,
  currency: "TTD",
  beds: 4,
  baths: 3,
  agentId: 1,
  status: "active",
  url: "",
  ...over,
});

/** The area relation of one listing to a request's area (null: not a match), through a resolver. */
async function relation(area: string, l: Listing, areas: AreaResolver = DIRECTORY): Promise<OurAreaRelation | null> {
  return ourAreaRelation(await ourAreaContext(area, [l], areas, null), l);
}

/** A fake market: resolve_area answers from `answers` by the text asked (the market's own JSON shape). Each text asked is recorded. */
function fakeMarket(answers: Record<string, Record<string, unknown>>, asked: string[] = []): ToolCaller {
  return {
    callTool: async (_name, args) => {
      const text = String(args.text);
      asked.push(text);
      const answer = answers[text.toLowerCase()] ?? { area: null, unresolved: true, suggestions: [] };
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    },
  };
}

const answer = (area: string, region: string, island: string) => ({ area, region, island, confidence: 0.95 });

test("the island a name spells out: Tobago or Trinidad by the word, never by a guess; both or neither is none", () => {
  for (const t of ["West Tobago", "west tobago", "Tobago West", "Scarborough, Tobago", "Tobago Plantations"]) assert.equal(islandNamedIn(t), "Tobago", t);
  for (const t of ["Trinidad", "Westmoorings, Trinidad"]) assert.equal(islandNamedIn(t), "Trinidad", t);
  for (const t of ["Trinidad and Tobago", "West", "Westmoorings", "Goodwood"]) assert.equal(islandNamedIn(t), null, t);
});

test("'West Tobago' stays in Tobago even when the directory answers North West: the name's island wins, and the Trinidad answer is not a match", async () => {
  const asked: string[] = [];
  const areas = new CompositeAreaResolver({
    market: new MarketAreaResolver(fakeMarket({ "west tobago": answer("North West", "North West", "Trinidad"), "gasparee island": answer("Gasparee Island", "North West", "Trinidad") }, asked)),
  });
  const west = await refFor(areas, "West Tobago");
  assert.equal(west.match?.island, "Tobago", "West Tobago is Tobago");
  assert.equal(west.match?.region, null, "the North West answer is not used as its region");
  const gasparee = await refFor(areas, "Gasparee Island");
  assert.equal(areaTier(west, gasparee).tier, "excluded", "Gasparee Island (Trinidad) never matches West Tobago");
  assert.equal(await relation("West Tobago", LISTING("gp", "Gasparee Island"), areas), null);
});

test("'West Tobago', 'west tobago' and 'Tobago West' keep a Tobago brief in Tobago: Trinidad West listings are out", async () => {
  const trinidadWest = [LISTING("gp", "Gasparee Island"), LISTING("ss", "Shorelands"), LISTING("wm", "Westmoorings"), LISTING("ph", "Petit Valley")];
  for (const area of ["West Tobago", "west tobago", "Tobago West"]) {
    for (const l of trinidadWest) assert.equal(await relation(area, l), null, `${area} vs ${l.area}`);
  }
  for (const area of ["West Tobago", "west tobago"]) {
    assert.deepEqual(await relation(area, LISTING("wt", "West Tobago")), { tier: "same-area" }, `${area} vs West Tobago`);
  }
});

test("a bare 'Tobago' brief matches Tobago places, and no Trinidad place of any name", async () => {
  assert.deepEqual(await relation("Tobago", LISTING("sc", "Scarborough")), { tier: "same-area" });
  for (const l of [LISTING("gp", "Gasparee Island"), LISTING("ss", "Shorelands"), LISTING("gg", "Goodwood Gardens"), LISTING("hm", "Hermitage")]) {
    assert.equal(await relation("Tobago", l), null, l.area);
  }
});

test("a directory answer for 'West Tobago' that is another place (West Hills) is not used: the name keeps Tobago, and the Trinidad place stays out", async () => {
  const areas = new CompositeAreaResolver({
    market: new MarketAreaResolver(fakeMarket({ "west tobago": answer("West Hills", "North West", "Trinidad"), "west hills": answer("West Hills", "North West", "Trinidad") })),
  });
  const brief = await refFor(areas, "West Tobago");
  assert.equal(brief.match?.canonical, "West Tobago", "the name is its own place, not West Hills");
  assert.equal(brief.match?.island, "Tobago");
  assert.equal(await relation("West Tobago", LISTING("wh", "West Hills"), areas), null);
  assert.equal(await relation("West Tobago", LISTING("wt", "West Tobago"), areas) !== null, true, "West Tobago still matches West Tobago");
});

test("'Scarborough, Tobago' keeps the directory's place and region for its own island (the Tobago region still reaches it)", async () => {
  const areas = new CompositeAreaResolver({ market: new MarketAreaResolver(fakeMarket({ "scarborough, tobago": answer("Scarborough", "Tobago", "Tobago") })) });
  const ref = await refFor(areas, "Scarborough, Tobago");
  assert.equal(ref.match?.canonical, "Scarborough");
  assert.equal(ref.match?.region, "Tobago");
  assert.deepEqual(await relation("Tobago", LISTING("sc", "Scarborough, Tobago"), areas), { tier: "same-area" });
});

test("'West' alone does not hop islands or collapse into a Trinidad West place, and a market 'North West' answer for it is not a place", async () => {
  const asked: string[] = [];
  const areas = new CompositeAreaResolver({ market: new MarketAreaResolver(fakeMarket({ west: answer("North West", "North West", "Trinidad") }, asked)) });
  assert.equal((await refFor(areas, "West")).match, null, "a region answer is unmapped");
  for (const l of [LISTING("ss", "Shorelands"), LISTING("gp", "Gasparee Island"), LISTING("wh", "Westhills"), LISTING("wm", "Westmoorings")]) {
    assert.equal(await relation("West", l, areas), null, l.area);
  }
  assert.equal(namesPlace("West Hills, Petit Valley", "West"), false, "West is part of the longer place West Hills");
});

test("'Goodwood' is not in 'Goodwood Gardens', 'Goodwood Park' or 'Goodwood Heights' (Westmoorings / Diego Martin), with a directory or without one", async () => {
  const trinidad = [LISTING("g1", "Goodwood Gardens"), LISTING("g2", "Goodwood Park"), LISTING("g3", "Goodwood Heights"), LISTING("g4", "", { title: "4 bedroom House - Goodwood Gardens" })];
  for (const l of trinidad) {
    assert.equal(await relation("Goodwood", l), null, `directory: ${l.area} / ${l.title}`);
    assert.equal(await relation("Goodwood", l, new ExactAreaFallback()), null, `no directory: ${l.area} / ${l.title}`);
  }
  assert.deepEqual(await relation("Goodwood", LISTING("gw", "Goodwood")), { tier: "same-area" }, "a Tobago Goodwood still matches a Tobago Goodwood");
  assert.deepEqual(await relation("Goodwood", LISTING("gw", "Goodwood"), new ExactAreaFallback()), { tier: "same-area" }, "and with no directory, the bare name");
});

test("namesPlace: a bare name matches where it stands alone, and never as the start of a longer known place", () => {
  assert.equal(namesPlace("Goodwood Gardens", "Goodwood"), false);
  assert.equal(namesPlace("Goodwood Heights, Westmoorings", "Goodwood"), false);
  assert.equal(namesPlace("Goodwood, Tobago", "Goodwood"), true);
  assert.equal(namesPlace("Goodwood Gardens and Goodwood", "Goodwood"), true, "a bare Goodwood elsewhere in the text still counts");
  assert.equal(namesPlace("West Hills, Petit Valley", "West"), false);
  assert.equal(namesPlace("West Hills, Petit Valley", "West Hills"), true);
  assert.equal(namesPlace("Westmoorings flat", "West"), false, "a word inside another word is not a match");
});

test("'Hermitage' is island-classified by its listing: a Trinidad Hermitage is not a Tobago place, and a Tobago brief never gets it", async () => {
  assert.deepEqual(await relation("Hermitage", LISTING("hm", "Hermitage")), { tier: "same-area" }, "a Hermitage brief gets the Hermitage place");
  assert.equal(await relation("Tobago", LISTING("hm", "Hermitage")), null, "a Tobago brief does not get the Trinidad Hermitage");
  assert.equal(await relation("West Tobago", LISTING("hm", "Hermitage")), null);
});

test("'Shivan Drive' is a street, not Shirvan: a Tobago 'Shirvan' brief never gets a Trinidad Shivan Drive listing", async () => {
  assert.equal(isStreetName("Shivan Drive"), true);
  assert.equal(isStreetName("Westmoorings"), false);
  assert.equal(isStreetName("St. James"), false);
  const shivan = LISTING("sd", "Shivan Drive", { title: "TWO STOREY FOUR BEDROOM HOUSE, HERMITAGE" });
  assert.equal(await relation("Shirvan", shivan), null, "a 1-letter neighbour is not the same place");
  assert.equal(await relation("Tobago", shivan), null, "a Tobago brief never gets the Trinidad street");
  assert.deepEqual(await relation("Shirvan", LISTING("sh", "Shirvan")), { tier: "same-area" }, "a real Shirvan, Tobago listing still matches");
});

test("a street name is never sent to the market: the market can only find the place its name looks like", async () => {
  const asked: string[] = [];
  const areas = new CompositeAreaResolver({ market: new MarketAreaResolver(fakeMarket({ shivan: answer("Shirvan", "Tobago", "Tobago") }, asked)) });
  const street = await refFor(areas, "Shivan Drive");
  assert.equal(street.match, null, "a street is unmapped");
  assert.deepEqual(asked, [], "the market is not asked about the street");
});

test("a one-letter market answer for a short name is refused ('Shivan' is not 'Shirvan'); a long name's one-letter typo still maps", async () => {
  const asked: string[] = [];
  const areas = new CompositeAreaResolver({
    market: new MarketAreaResolver(fakeMarket({ shivan: answer("Shirvan", "Tobago", "Tobago"), westmorings: answer("Westmoorings", "North West", "Trinidad") }, asked)),
  });
  assert.equal((await refFor(areas, "Shivan")).match, null, "Shivan is unmapped, not Shirvan");
  assert.equal(isNearSpelling("Shivan", "Shirvan"), true, "a one-letter neighbour of a short name is refused");
  assert.equal(isNearSpelling("Shivan", "Shiven"), true, "the same for any one-letter change to a short name");
  assert.equal(isNearSpelling("Tobago", "Tobagos"), true, "six letters is short, whatever the change");
  assert.equal(isNearSpelling("Westmorings", "Westmoorings"), false, "a long name's one-letter typo is tolerated");
  assert.equal(isNearSpelling("Chaguanas", "Chaguanos"), false, "nine letters is not short");
  assert.equal(isNearSpelling("Westmoorings", "Westmoorings"), false, "the same letters are not a typo at all");
  assert.equal((await refFor(areas, "Westmorings")).match?.canonical, "Westmoorings");
});

test("a market answer that is a region is unmapped, and the suggestion is kept for the desk", () => {
  const lookup = areaFromToolResult("West", { content: [{ type: "text", text: JSON.stringify({ area: "North West", region: "North West", island: "Trinidad", confidence: 0.99, suggestions: ["Westmoorings"] }) }] });
  assert.equal(lookup.mapped, false);
  assert.equal(lookup.canonical, "North West");
  assert.deepEqual(lookup.suggestions, ["North West", "Westmoorings"]);
  const region = areaFromToolResult("North West", { area: "North West", region: "North West", island: "Trinidad", confidence: 0.99 });
  assert.equal(region.mapped, true, "a region named as the brief names it is still that region");
});

test("West Hills and Westhills are North West Trinidad, never West Tobago", async () => {
  const hillsRef = await refFor(DIRECTORY, "West Hills");
  assert.equal(hillsRef.match?.region, "North West", "West Hills is North West");
  assert.equal(hillsRef.match?.island, "Trinidad");
  const hills = LISTING("wh", "West Hills", { title: "WEST HILLS, PETIT VALLEY 3BR" });
  const westhills = LISTING("wh2", "Westhills", { title: "Westhills building 10" });
  const petit = LISTING("pv", "West Hills, Petit Valley");
  assert.deepEqual(await relation("West Hills", hills), { tier: "same-area" });
  assert.deepEqual(await relation("Westhills", westhills), { tier: "same-area" }, "the alias is the same development");
  assert.deepEqual(await relation("West Hills", petit), { tier: "same-area" }, "West Hills, Petit Valley is the development");
  for (const l of [hills, westhills, petit]) {
    assert.equal(await relation("West Tobago", l), null, `West Tobago vs ${l.area}`);
    assert.equal(await relation("Tobago", l), null, `Tobago vs ${l.area}`);
    assert.equal(await relation("West", l), null, `West vs ${l.area}`);
  }
});
