import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MemoryAreaResolver, type Place } from "../flow/areas.ts";
import { FAIR } from "../flow/automatch.ts";
import { NOT_CONNECTED, type CrmSeam } from "../flow/crm-seam.ts";
import type { Listing } from "../flow/source.ts";
import { areasForMatch, isCentralAreaGroup } from "../extract.ts";
import { automatchClient, placeWithoutRegion, type AutomatchClientOpts } from "../node/automatch-client.ts";
import type { AgentReply } from "../node/agent-search.ts";
import { GATE_OPEN_PATHS } from "../../lib/gate.ts";

/**
 * POST /api/realty/automatch-client: the bearer gate (503 unset, 401 wrong), the brief's validation (400), the scoring against
 * a fake CRM seam (eligibility, areas, location lists, bathrooms, limit), and the response shape. Invented data only: made-up
 * listings and test secrets. No network, no live CRM, no real token.
 */

const NOW = new Date("2026-11-20T12:00:00.000Z");
const TOKEN = "invented-automatch-token-0001";
const WRONG = "invented-automatch-token-0002";
const ENV = { BOPS_AUTOMATCH_TOKEN: TOKEN };
const AUTH = `Bearer ${TOKEN}`;

const PLACES = [
  { name: "Westmoorings", region: "North West" as const, neighbours: ["Glencoe", "Diego Martin"] },
  { name: "Glencoe", region: "North West" as const, neighbours: ["Westmoorings"] },
  { name: "Diego Martin", region: "North West" as const, neighbours: ["Westmoorings"] },
  { name: "Chaguanas", region: "Central" as const },
];
const AREAS = new MemoryAreaResolver(PLACES);

const LISTING = (over: Partial<Listing> = {}): Listing => ({
  id: "1",
  title: "Westmoorings flat",
  listingType: "rent",
  area: "Westmoorings",
  price: 9000,
  currency: "TTD",
  beds: 2,
  baths: 1,
  agentId: 7,
  status: "active",
  url: "https://1on1realtors.com/property/test-flat",
  ...over,
});

/** The brief every scoring test starts from: a rent apartment in Westmoorings, up to 9000 a month, two beds. */
const BRIEF = { listing_type: "rent", property_type: "apartment", location: "Westmoorings", budget_max: 9000, bedrooms_min: 2 };

const seamOf = (listings: Listing[]): CrmSeam => ({ connected: true, listings: async () => ({ status: "ok", listings }), agents: async () => [] });
const opts = (listings: Listing[]): AutomatchClientOpts => ({ seam: seamOf(listings), areas: AREAS, knowledge: null, now: NOW });

async function call(listings: Listing[], brief: unknown, o: { auth?: string | null; env?: Record<string, string | undefined> } = {}): Promise<AgentReply> {
  const body = typeof brief === "string" ? brief : JSON.stringify(brief);
  const authorization = o.auth === undefined ? AUTH : o.auth;
  return automatchClient({ authorization, body }, o.env ?? ENV, opts(listings));
}

type Match = { property_id: string; title: string; location: string | null; score: number; reasons: string[]; matched_fields: string[]; bedrooms: number | null; bathrooms: number | null };
const matchesOf = (r: AgentReply) => r.body.matches as Match[];
const idsOf = (r: AgentReply) => matchesOf(r).map((m) => m.property_id);

const A = LISTING({ id: "A", title: "Westmoorings flat, same area", baths: 2 });
const B = LISTING({ id: "B", title: "Glencoe flat", area: "Glencoe" });
const C = LISTING({ id: "C", title: "Chaguanas flat", area: "Chaguanas" });
const D = LISTING({ id: "D", title: "Westmoorings house for sale", listingType: "sale", price: 900000 });
const E = LISTING({ id: "E", title: "Westmoorings flat, withdrawn", status: "withdrawn" });
const F = LISTING({ id: "F", title: "Westmoorings flat, five beds", beds: 5 });
const G = LISTING({ id: "G", title: "Westmoorings flat, over budget", price: 20000 });
const ALL = [A, B, C, D, E, F, G];

/* ---------------- the bearer gate ---------------- */

test("503 when BOPS_AUTOMATCH_TOKEN is unset or blank, even with a bearer header (never a 401)", async () => {
  for (const env of [{}, { BOPS_AUTOMATCH_TOKEN: "" }, { BOPS_AUTOMATCH_TOKEN: "   " }]) {
    for (const auth of [AUTH, `Bearer ${WRONG}`, null]) {
      const r = await call(ALL, BRIEF, { auth, env });
      assert.equal(r.status, 503);
      assert.equal(typeof r.body.error, "string");
      assert.equal(JSON.stringify(r.body).includes(TOKEN), false, "the 503 never echoes a token");
    }
  }
});

test("401 when the token is set and the header is missing, malformed, or wrong (constant-time compare, same body each time)", async () => {
  const headers: (string | null)[] = [
    null,
    "",
    "Basic invented",
    "Bearer",
    "Bearer ",
    `Token ${TOKEN}`,
    `Bearer ${WRONG}`,
    `Bearer ${TOKEN}x`,
    `Bearer ${TOKEN.slice(0, -1)}`,
    `Bearer ${TOKEN} extra`,
  ];
  for (const auth of headers) {
    const r = await call(ALL, BRIEF, { auth });
    assert.equal(r.status, 401, String(auth));
    assert.deepEqual(r.body, { error: "Unauthorized." });
  }
});

test("401 comes before the body is read: a bad body with a wrong token is still 401", async () => {
  assert.equal((await call(ALL, "not json", { auth: `Bearer ${WRONG}` })).status, 401);
});

test("the scheme is case-insensitive and the right token passes", async () => {
  assert.equal((await call(ALL, BRIEF, { auth: `bearer ${TOKEN}` })).status, 200);
});

/* ---------------- the brief's validation (400) ---------------- */

test("400 for a body that is not a JSON object, with a short message", async () => {
  for (const body of ["not json", "[]", "null", '"text"', "42"]) {
    const r = await call(ALL, body);
    assert.equal(r.status, 400, body);
    assert.equal(typeof r.body.error, "string");
  }
});

test("400 for a missing or bad listing_type, a missing or empty location, and a bad location list", async () => {
  const bad: unknown[] = [
    {},
    { listing_type: "lease", location: "Westmoorings" },
    { listing_type: 3, location: "Westmoorings" },
    { listing_type: "rent" },
    { listing_type: "rent", location: "   " },
    { listing_type: "rent", location: [] },
    { listing_type: "rent", location: ["Westmoorings", 5] },
    { listing_type: "rent", location: 9 },
  ];
  for (const b of bad) assert.equal((await call(ALL, b)).status, 400, JSON.stringify(b));
});

test("400 for non-numeric or negative money, beds, baths and limit, and for budget_min above budget_max", async () => {
  const bad: Record<string, unknown>[] = [
    { budget_max: "abc" },
    { budget_min: -5 },
    { budget_min: 10, budget_max: 5 },
    { bedrooms_min: true },
    { bathrooms_min: "x" },
    { limit: 0 },
    { limit: 1.5 },
    { limit: "x" },
    { property_type: 5 },
    { client_id: {} },
  ];
  for (const extra of bad) {
    const r = await call(ALL, { ...BRIEF, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(typeof r.body.error, "string");
  }
});

test("a numeric string for a number field is read as its number", async () => {
  const r = await call(ALL, { ...BRIEF, limit: "1", budget_max: "9000" });
  assert.equal(r.status, 200);
  assert.equal(matchesOf(r).length, 1);
});

/* ---------------- scoring against the active listings ---------------- */

test("a rent brief returns the same-area and neighbouring rent listings, and nothing from another area, sale, sold or over budget", async () => {
  const r = await call(ALL, BRIEF);
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r), ["A", "B"]);
  assert.equal(matchesOf(r)[0].score, 100);
  assert.equal(matchesOf(r)[1].score, 85);
  assert.match(matchesOf(r)[1].reasons[0], /Nearby/);
});

test("a sale brief returns sale listings only", async () => {
  const r = await call(ALL, { listing_type: "sale", property_type: "house", location: "Westmoorings", budget_max: 900000 });
  assert.deepEqual(idsOf(r), ["D"]);
});

test("a rent brief never returns a sale listing, and a sale brief never a rent one", async () => {
  assert.equal(idsOf(await call(ALL, BRIEF)).includes("D"), false);
  const sale = await call([A, D], { listing_type: "sale", location: "Westmoorings", budget_max: 900000 });
  assert.deepEqual(idsOf(sale), ["D"]);
});

test("beds: exact is full, one off still matches (within one, the existing rule), further off is excluded", async () => {
  const one = LISTING({ id: "I", title: "Westmoorings flat, three beds", beds: 3 });
  const r = await call([one, F], BRIEF);
  assert.deepEqual(idsOf(r), ["I"]);
  assert.equal(matchesOf(r)[0].score, 90, "one bed off loses half the beds points");
});

test("budget: listings from 80% to 120% of the budget pass; under or over that band are excluded", async () => {
  const under = LISTING({ id: "under", price: 7000 });
  const within = LISTING({ id: "within", price: 8000 });
  const r = await call([under, within, G], BRIEF);
  assert.deepEqual(idsOf(r), ["within"]);
});

test("budget_min is a floor: a listing below the band's bottom is excluded", async () => {
  const r = await call([A], { ...BRIEF, budget_min: 20000, budget_max: 25000 });
  assert.deepEqual(idsOf(r), []);
  assert.deepEqual(idsOf(await call([A], { ...BRIEF, budget_min: 8000, budget_max: 9000 })), ["A"]);
});

test("a listing with no price or no beds is not turned away by those rules", async () => {
  const noPrice = LISTING({ id: "np", price: 0 });
  const noBeds = LISTING({ id: "nb", beds: 0 });
  const r = await call([noPrice, noBeds], BRIEF);
  assert.deepEqual(idsOf(r).sort(), ["nb", "np"]);
});

test("an inactive listing (withdrawn or sold) is never returned, though it would otherwise match", async () => {
  const sold = LISTING({ id: "S", status: "sold" });
  const r = await call([A, E, sold], BRIEF);
  assert.deepEqual(idsOf(r), ["A"]);
  assert.equal(r.body.meta && (r.body.meta as { total_candidates: number }).total_candidates, 1);
});

test("a location string or a list scores the same; blank entries are dropped", async () => {
  const single = await call(ALL, BRIEF);
  const trimmed = await call(ALL, { ...BRIEF, location: ["  ", " Westmoorings "] });
  assert.deepEqual(idsOf(trimmed), idsOf(single));
  assert.deepEqual(matchesOf(trimmed).map((m) => m.score), matchesOf(single).map((m) => m.score));
});

test("a list of locations returns each listing once, with its best score across the locations", async () => {
  const r = await call(ALL, { ...BRIEF, location: ["Glencoe", "Westmoorings"] });
  const ids = idsOf(r);
  assert.equal(new Set(ids).size, ids.length, "no duplicate property_id");
  assert.deepEqual(ids.slice().sort(), ["A", "B"]);
  const b = matchesOf(r).find((m) => m.property_id === "B");
  assert.equal(b?.score, 100, "B is in the Glencoe ask's own area, so its best score is the full one");
});

test("a list of locations keeps an unrelated area's listing out of the result", async () => {
  const r = await call(ALL, { ...BRIEF, location: ["Westmoorings", "Chaguanas"] });
  assert.deepEqual(idsOf(r).sort(), ["A", "B", "C"]);
});

test("the neighbouring area can match, an unrelated area must not", async () => {
  const near = await call([B], BRIEF);
  assert.deepEqual(idsOf(near), ["B"]);
  const far = await call([C], BRIEF);
  assert.deepEqual(idsOf(far), []);
});

test("bathrooms_min is a hard floor: a listing with fewer baths is dropped; one with no baths recorded passes", async () => {
  const twoBath = LISTING({ id: "two", baths: 2 });
  const oneBath = LISTING({ id: "one", baths: 1 });
  const noBaths = LISTING({ id: "none", baths: 0 });
  const r = await call([twoBath, oneBath, noBaths], { ...BRIEF, bathrooms_min: 2 });
  assert.deepEqual(idsOf(r).sort(), ["none", "two"]);
  assert.equal((r.body.meta as { total_candidates: number }).total_candidates, 2, "the floor is applied before the count");
});

test("limit: the default is 10, a given limit caps it, and a huge limit is capped at 50", async () => {
  const many = Array.from({ length: 60 }, (_, i) => LISTING({ id: `S${i}`, title: `Westmoorings flat ${i}` }));
  assert.equal(matchesOf(await call(many, BRIEF)).length, 10);
  assert.equal(matchesOf(await call(many, { ...BRIEF, limit: 3 })).length, 3);
  assert.equal(matchesOf(await call(many, { ...BRIEF, limit: 500 })).length, 50);
  assert.equal(matchesOf(await call(many, { ...BRIEF, limit: "4" })).length, 4);
});

test("matches are sorted best first and every match is at the fair band or above", async () => {
  const r = await call(ALL, BRIEF);
  const scores = matchesOf(r).map((m) => m.score);
  assert.deepEqual(scores, scores.slice().sort((a, b) => b - a));
  for (const s of scores) assert.ok(s >= FAIR, String(s));
});

/* ---------------- the response shape ---------------- */

test("the success response has the contract's field names and meta", async () => {
  const r = await call(ALL, BRIEF);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["matches", "meta", "ok"]);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.meta, { total_candidates: 3, scored_at: NOW.toISOString() });
  assert.deepEqual(Object.keys(matchesOf(r)[0]).sort(), ["bathrooms", "bedrooms", "currency", "listing_type", "location", "matched_fields", "price", "property_id", "property_type", "reasons", "score", "title"]);
  const m = matchesOf(r)[0];
  assert.equal(m.property_id, "A");
  assert.equal(m.location, "Westmoorings");
  assert.equal(m.bedrooms, 2);
  assert.equal(m.bathrooms, 2);
  assert.deepEqual(m.reasons.length, 1);
  assert.ok(m.matched_fields.includes("location"));
});

test("property_type follows the existing category rule: a house meets an apartment ask, land does not, and land asks take land only", async () => {
  const house = LISTING({ id: "H", title: "Westmoorings house" });
  const residential = await call([house], { ...BRIEF, property_type: "apartment" });
  assert.equal(matchesOf(residential)[0].score, 100, "both are residential");
  assert.ok(matchesOf(residential)[0].matched_fields.includes("property_type"));
  const land = LISTING({ id: "L", title: "Westmoorings land", propertyKind: "land" });
  assert.deepEqual(idsOf(await call([land], { ...BRIEF, property_type: "apartment" })), [], "a land plot is not residential");
  const plot = await call([land], { ...BRIEF, property_type: "land" });
  assert.deepEqual(idsOf(plot), ["L"]);
  assert.ok(matchesOf(plot)[0].matched_fields.includes("property_type"));
});

test("the client's name and notes are never returned or scored", async () => {
  const r = await call(ALL, { ...BRIEF, name: "Invented Client Zed", notes: "private note about the client", client_id: "crm-42" });
  const text = JSON.stringify(r.body);
  assert.equal(r.status, 200);
  assert.equal(text.includes("Invented Client Zed"), false);
  assert.equal(text.includes("private note"), false);
  assert.equal(text.includes("crm-42"), false);
});

test("a CRM that is not connected or can't be read is a 503 with a generic message, never a throw", async () => {
  const notConnected = await automatchClient({ authorization: AUTH, body: JSON.stringify(BRIEF) }, ENV, { seam: NOT_CONNECTED, areas: AREAS, knowledge: null, now: NOW });
  assert.equal(notConnected.status, 503);
  const throws: CrmSeam = { connected: true, listings: async () => { throw new Error("boom"); }, agents: async () => [] };
  const down = await automatchClient({ authorization: AUTH, body: JSON.stringify(BRIEF) }, ENV, { seam: throws, areas: AREAS, knowledge: null, now: NOW });
  assert.equal(down.status, 503);
  assert.equal(typeof down.body.error, "string");
  assert.equal(JSON.stringify(down.body).includes("boom"), false, "the error text is not echoed");
});

test("with no CRM settings and no seam given, the default seam is not connected: 503", async () => {
  const r = await automatchClient({ authorization: AUTH, body: JSON.stringify(BRIEF) }, ENV, {});
  assert.equal(r.status, 503);
});

/* ---------------- regions and "Place, Region" locations ---------------- */

// Invented places with invented neighbour lists. The regions are the ones the market's directory gives.
const REGION_PLACES: Place[] = [
  { name: "Chaguanas", region: "Central", neighbours: ["Riverview Park", "Brentwood Palms"] },
  { name: "Riverview Park", region: "Central", neighbours: ["Chaguanas"] },
  { name: "Brentwood Palms", region: "Central", neighbours: ["Chaguanas"] },
  { name: "Cunupia", region: "Central" },
  { name: "Couva", region: "Central" },
  { name: "Freeport", region: "Central" },
  { name: "Fort George", region: "North West", neighbours: ["Woodbrook", "Port of Spain"] },
  { name: "Westmoorings", region: "North West" },
  { name: "Port of Spain", region: "Port of Spain" },
  { name: "St. James", region: "Port of Spain", neighbours: ["Port of Spain"] },
  { name: "Cascade", region: "Port of Spain" },
  { name: "Woodbrook", region: "Port of Spain" },
  { name: "Tunapuna", region: "East–West Corridor" },
  { name: "San Fernando", region: "South" },
  { name: "Scarborough", region: "Tobago" },
];
const REGION_AREAS = new MemoryAreaResolver(REGION_PLACES);

const AREA_LISTING = (id: string, area: string, over: Partial<Listing> = {}): Listing =>
  LISTING({ id, title: `${area} 2-bed apartment`, area, ...over });
const REGION_LISTINGS = {
  chaguanas: AREA_LISTING("chaguanas", "Chaguanas"),
  riverview: AREA_LISTING("riverview", "Riverview Park"),
  brentwood: AREA_LISTING("brentwood", "Brentwood Palms"),
  cunupia: AREA_LISTING("cunupia", "Cunupia"),
  couva: AREA_LISTING("couva", "Couva"),
  freeport: AREA_LISTING("freeport", "Freeport"),
  fortGeorge: AREA_LISTING("fort-george", "Fort George"),
  // A North West listing whose title says "Central": the word in the title never makes it a Central listing.
  fortGeorgeCentralTitle: AREA_LISTING("fort-george-central", "Fort George", { title: "Central View 2-bed apartment" }),
  stJames: AREA_LISTING("st-james", "St. James"),
  cascade: AREA_LISTING("cascade", "Cascade"),
  woodbrook: AREA_LISTING("woodbrook", "Woodbrook"),
  portOfSpain: AREA_LISTING("port-of-spain", "Port of Spain"),
  westmoorings: AREA_LISTING("westmoorings", "Westmoorings"),
  tunapuna: AREA_LISTING("tunapuna", "Tunapuna"),
  sanFernando: AREA_LISTING("san-fernando", "San Fernando"),
  scarborough: AREA_LISTING("scarborough", "Scarborough"),
};
const EVERY_REGION_LISTING = Object.values(REGION_LISTINGS);

/** The rent brief from BRIEF, with the location given, against the region fixtures. */
async function regionMatches(location: string | string[], listings: Listing[] = EVERY_REGION_LISTING): Promise<Match[]> {
  const r = await automatchClient({ authorization: AUTH, body: JSON.stringify({ ...BRIEF, location }) }, ENV, { seam: seamOf(listings), areas: REGION_AREAS, knowledge: null, now: NOW });
  assert.equal(r.status, 200);
  return matchesOf(r);
}
const idsSorted = (ms: Match[]) => ms.map((m) => m.property_id).sort();

test("'Central' matches the Central Trinidad listings (Chaguanas, Cunupia, Couva, Freeport, and the places in Central) and not Port of Spain or North West", async () => {
  const got = await regionMatches("Central");
  assert.deepEqual(idsSorted(got), ["brentwood", "chaguanas", "couva", "cunupia", "freeport", "riverview"]);
  for (const m of got) assert.equal(m.reasons[0].startsWith("Same area (Central)"), true, `${m.property_id}: ${m.reasons[0]}`);
});

test("'Central' does not match Fort George, St James, Cascade or Woodbrook, even with a neighbour list that names them", async () => {
  const ids = idsSorted(await regionMatches("Central"));
  for (const id of ["fort-george", "fort-george-central", "st-james", "cascade", "woodbrook", "port-of-spain", "westmoorings"]) {
    assert.equal(ids.includes(id), false, `${id} is not a Central listing`);
  }
});

test("'Central locations' still matches the Port of Spain group, and not the Central Trinidad places", async () => {
  const ids = idsSorted(await regionMatches("Central locations"));
  for (const id of ["st-james", "cascade", "woodbrook", "port-of-spain"]) assert.equal(ids.includes(id), true, `${id} is in the group`);
  for (const id of ["chaguanas", "cunupia", "couva", "freeport", "riverview", "brentwood", "tunapuna", "san-fernando"]) {
    assert.equal(ids.includes(id), false, `${id} is not in the group`);
  }
});

test("bare region names match their own region's listings cleanly", async () => {
  const cases: [string, string[]][] = [
    ["North West", ["fort-george", "fort-george-central", "westmoorings"]],
    ["Port of Spain", ["cascade", "port-of-spain", "st-james", "woodbrook"]],
    ["East-West Corridor", ["tunapuna"]],
    ["South", ["san-fernando"]],
    ["Tobago", ["scarborough"]],
  ];
  for (const [location, want] of cases) {
    assert.deepEqual(idsSorted(await regionMatches(location)), [...want].sort(), location);
  }
});

test("a 'Place, Region' location scores the same as the place alone: 'Chaguanas, Central' is 'Chaguanas'", async () => {
  const alone = await regionMatches("Chaguanas");
  const withRegion = await regionMatches("Chaguanas, Central");
  assert.deepEqual(withRegion, alone);
  // The place's own listing and its neighbours, the same as before the region was added.
  assert.deepEqual(idsSorted(alone), ["brentwood", "chaguanas", "riverview"]);
});

test("the region suffix is dropped only after a place name, and only for known Trinidad & Tobago regions", () => {
  assert.equal(placeWithoutRegion("Chaguanas, Central"), "Chaguanas");
  assert.equal(placeWithoutRegion("  chaguanas ,  central  "), "chaguanas");
  assert.equal(placeWithoutRegion("Woodbrook, Port of Spain, Trinidad & Tobago"), "Woodbrook");
  assert.equal(placeWithoutRegion("Tunapuna, East–West Corridor"), "Tunapuna");
  assert.equal(placeWithoutRegion("Scarborough, Tobago"), "Scarborough");
  assert.equal(placeWithoutRegion("Central"), "Central", "a region on its own has no place before it");
  assert.equal(placeWithoutRegion("Central locations"), "Central locations");
  assert.equal(placeWithoutRegion("La Fontaine, Westmoorings"), "La Fontaine, Westmoorings", "a place is not a region");
});

test("the Central group is only 'Central location(s)': bare 'Central' is the region, not the group", () => {
  assert.equal(isCentralAreaGroup("Central"), false);
  assert.equal(isCentralAreaGroup("central"), false);
  assert.equal(isCentralAreaGroup("Central locations"), true);
  assert.equal(isCentralAreaGroup("central  location"), true);
  assert.equal(areasForMatch("Central").same.includes("Cascade"), false, "bare Central expands to no places");
  assert.equal(areasForMatch("Central locations").same.includes("Cascade"), true);
});

/* ---------------- the gate sets ---------------- */

test("the path is open to the Google gate (a bearer check only) and listed as server-to-server in proxy.ts", () => {
  assert.equal(GATE_OPEN_PATHS.has("/api/realty/automatch-client"), true);
  assert.equal(GATE_OPEN_PATHS.has("/api/realty/automatch-client/extra"), false);
  const proxy = readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");
  const line = proxy.split("\n").find((l) => l.startsWith("const TAILNET_PATHS"));
  assert.ok(line, "TAILNET_PATHS is found");
  assert.ok(line.includes('"/api/realty/automatch-client"'));
});
