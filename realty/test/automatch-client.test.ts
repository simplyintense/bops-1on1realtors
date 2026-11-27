import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryAreaResolver, type Place, type ToolCaller } from "../flow/areas.ts";
import { FAIR } from "../flow/automatch.ts";
import { NOT_CONNECTED, type CrmSeam } from "../flow/crm-seam.ts";
import type { Listing } from "../flow/source.ts";
import { areasForMatch, isCentralAreaGroup } from "../extract.ts";
import { automatchClient, EXCERPT_MAX, excerptOf, placeWithoutRegion, type AutomatchClientOpts } from "../node/automatch-client.ts";
import type { AgentReply } from "../node/agent-search.ts";
import { GATE_OPEN_PATHS } from "../../lib/gate.ts";
import type { SearchRow } from "../node/search-store.ts";

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
  assert.deepEqual(r.body.meta, { total_candidates: 3, scored_at: NOW.toISOString(), sources: ["crm"] });
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

/* ---------------- sources: WhatsApp offers and other agencies' listings ---------------- */

type Meta = { total_candidates: number; scored_at: string; sources: string[]; whatsapp_candidates?: number; warnings?: string[] };
type WaMatch = { id: string; title: string; location: string | null; price: number | null; currency: string | null; listing_type: string | null; property_type: string | null; bedrooms: number | null; bathrooms: number | null; score: number; reasons: string[]; sender_name: string | null; sender_phone: string | null; posted_at: string | null; excerpt: string | null; post_url: string | null };
type OnlineMatch = { id: string | null; title: string | null; location: string | null; price: number | null; currency: string | null; listing_type: string | null; property_type: string | null; bedrooms: number | null; bathrooms: number | null; score: number | null; reasons: string[]; source_site: string | null; url: string | null };

const WA_KEYS = ["bathrooms", "bedrooms", "currency", "excerpt", "id", "listing_type", "location", "posted_at", "post_url", "price", "property_type", "reasons", "score", "sender_name", "sender_phone", "title"];
const ONLINE_KEYS = ["bathrooms", "bedrooms", "currency", "id", "listing_type", "location", "price", "property_type", "reasons", "score", "source_site", "title", "url"];

const metaOf = (r: AgentReply) => r.body.meta as Meta;
const waOf = (r: AgentReply) => (r.body.whatsapp_matches ?? []) as WaMatch[];
const onlineOf = (r: AgentReply) => (r.body.online_matches ?? []) as OnlineMatch[];
const waIds = (r: AgentReply) => waOf(r).map((m) => m.id);
const warningsOf = (r: AgentReply) => metaOf(r).warnings ?? [];

/** A store root with no files: the WhatsApp source reads nothing from it, so no test reads the real store. */
const EMPTY_ROOT = mkdtempSync(join(tmpdir(), "automatch-empty-store-"));
after(() => rmSync(EMPTY_ROOT, { recursive: true, force: true }));

const THROWS: CrmSeam = { connected: true, listings: async () => { throw new Error("invented CRM failure"); }, agents: async () => [] };

type RunOpts = {
  listings?: Listing[];
  seam?: CrmSeam;
  areas?: AutomatchClientOpts["areas"];
  supply?: SearchRow[];
  market?: ToolCaller | null;
  marketTimeoutMs?: number;
  root?: string;
  env?: Record<string, string | undefined>;
};

/** The handler with each source's seam injected: the CRM listings (or `seam`), the WhatsApp rows, the market. No network. */
async function run(brief: unknown, o: RunOpts = {}): Promise<AgentReply> {
  return automatchClient({ authorization: AUTH, body: JSON.stringify(brief) }, o.env ?? ENV, {
    seam: o.seam ?? seamOf(o.listings ?? []),
    areas: o.areas ?? AREAS,
    knowledge: null,
    now: NOW,
    root: o.root ?? EMPTY_ROOT,
    supply: o.supply,
    market: o.market ?? null,
    marketTimeoutMs: o.marketTimeoutMs,
  });
}

const SENDER = "+1 868 555 0142";
const GROUP_MARK = "Invented Co-Broke Group Zed";

/** A supply row as the search store holds it: a Westmoorings two-bed rent at 9000 a month, unless `over` says otherwise. */
const supplyRow = (over: Partial<SearchRow> = {}): SearchRow => ({
  id: "W1",
  tab: "supply",
  kind: "supply",
  senderPhone: SENDER,
  senderName: "Invented Agent Zed",
  firm: null,
  category: "listing_for_rent",
  chatId: "invented-chat-0001",
  firstSentAt: "2026-11-18T12:00:00.000Z",
  lastSentAt: "2026-11-19T12:00:00.000Z",
  timesSeen: 1,
  groups: [GROUP_MARK],
  messageIds: ["invented-msg-1"],
  area: "Westmoorings",
  development: null,
  price: 9000,
  currency: "TTD",
  beds: 2,
  baths: 1,
  type: "apartment",
  listingType: "rent",
  intent: null,
  propertyClass: null,
  notes: null,
  originalText: "Two bed apartment in Westmoorings, 9000 a month. Call 555 0142.",
  status: null,
  ...over,
});

/** One match_buyer hit in the market's shape: the listing object, and the market's own 0 to 1 score. */
const HIT = (listing: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  listing: { id: "m-1", title: "Invented Market Flat", area: "Westmoorings", price: 9500, currency: "TTD", beds: 2, baths: 1, listing_type: "rent", property_class: "apartment", url: "https://market.example.test/listings/m-1", agency: "Invented Agency Zed", ...listing },
  reason: "Two beds in Westmoorings",
  score: 0.91,
  ...over,
});

type Call = { name: string; args: Record<string, unknown> };
const askedArea = (c: Call) => (c.args.buyer as { area?: string }).area;
/** The market's tools/call reply: a spoken line, then the JSON with the hits. */
const marketReply = (hits: unknown[]) => ({ content: [{ type: "text", text: "Found some listings." }, { type: "text", text: JSON.stringify({ total: hits.length, matches: hits }) }] });
/** A fake market: every match_buyer call answers `hits` in the market's shape, and each call is recorded in `calls`. */
function marketOf(hits: unknown[] = [HIT()], calls: Call[] = []): ToolCaller {
  return {
    callTool: async (name, args) => {
      calls.push({ name, args });
      return marketReply(hits);
    },
  };
}
const NEVER: ToolCaller = { callTool: () => new Promise<never>(() => {}) };
const BROKEN: ToolCaller = { callTool: async () => { throw new Error("invented market failure"); } };

/* ---------------- sources: validation and defaults ---------------- */

test("sources omitted or null means crm only, and the body has just matches and meta", async () => {
  for (const brief of [BRIEF, { ...BRIEF, sources: null }]) {
    const r = await run(brief, { listings: ALL });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["matches", "meta", "ok"]);
    assert.deepEqual(metaOf(r).sources, ["crm"]);
    assert.equal("whatsapp_candidates" in metaOf(r), false);
    assert.deepEqual(idsOf(r), ["A", "B"]);
  }
});

test("sources are trimmed, lower-cased and de-duplicated, in the order given", async () => {
  const r = await run({ ...BRIEF, sources: ["CRM", " whatsapp ", "CRM"] }, { listings: ALL });
  assert.equal(r.status, 200);
  assert.deepEqual(metaOf(r).sources, ["crm", "whatsapp"]);
});

test("400 for an empty list, a plain string, a blank or unknown source, or a non-string", async () => {
  for (const sources of [[], "crm", [""], ["crm", "twitter"], [1], [null], {}]) {
    const r = await run({ ...BRIEF, sources }, { listings: ALL });
    assert.equal(r.status, 400, JSON.stringify(sources));
    assert.equal(typeof r.body.error, "string");
  }
});

test("401 comes before the sources are read: a bad sources list with a wrong token is still 401", async () => {
  const r = await automatchClient({ authorization: `Bearer ${WRONG}`, body: JSON.stringify({ ...BRIEF, sources: ["twitter"] }) }, ENV, opts(ALL));
  assert.equal(r.status, 401);
});

/* ---------------- sources: the CRM is read only when asked for ---------------- */

test("without crm in sources the CRM is never read: a seam that is not connected or throws still gives 200", async () => {
  const wa = await run({ ...BRIEF, sources: ["whatsapp"] }, { seam: NOT_CONNECTED, supply: [supplyRow()] });
  assert.equal(wa.status, 200);
  assert.deepEqual(wa.body.matches, []);
  assert.equal(metaOf(wa).total_candidates, 0);
  assert.deepEqual(waIds(wa), ["W1"]);
  const online = await run({ ...BRIEF, sources: ["online"] }, { seam: THROWS, market: null });
  assert.equal(online.status, 200);
  assert.deepEqual(online.body.matches, []);
});

test("crm alone with the CRM down is still a 503, with or without sources given", async () => {
  for (const brief of [BRIEF, { ...BRIEF, sources: ["crm"] }]) {
    assert.equal((await run(brief, { seam: THROWS })).status, 503);
    assert.equal((await run(brief, { seam: NOT_CONNECTED })).status, 503);
  }
});

test("crm with another source and the CRM down: 200, no crm matches, a warning, and the other sources still scored", async () => {
  const r = await run({ ...BRIEF, sources: ["crm", "whatsapp"] }, { seam: THROWS, supply: [supplyRow()] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.matches, []);
  assert.equal(metaOf(r).total_candidates, 0);
  assert.equal(warningsOf(r).length, 1);
  assert.match(warningsOf(r)[0], /CRM/);
  assert.deepEqual(waIds(r), ["W1"]);
  assert.equal(JSON.stringify(r.body).includes("invented CRM failure"), false);
});

/* ---------------- sources: WhatsApp offers ---------------- */

test("a matching WhatsApp offer comes back with exactly the contract's fields, the poster's details and the post link", async () => {
  const r = await run({ ...BRIEF, sources: ["whatsapp"] }, { supply: [supplyRow()] });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["matches", "meta", "ok", "whatsapp_matches"]);
  assert.deepEqual(Object.keys(metaOf(r)).sort(), ["scored_at", "sources", "total_candidates", "whatsapp_candidates"]);
  assert.equal(metaOf(r).whatsapp_candidates, 1);
  const [m] = waOf(r);
  assert.deepEqual(Object.keys(m).sort(), [...WA_KEYS].sort());
  assert.deepEqual(
    { id: m.id, title: m.title, location: m.location, price: m.price, currency: m.currency, listing_type: m.listing_type, property_type: m.property_type, bedrooms: m.bedrooms, bathrooms: m.bathrooms, score: m.score },
    { id: "W1", title: "2 bed apartment", location: "Westmoorings", price: 9000, currency: "TTD", listing_type: "rent", property_type: "apartment", bedrooms: 2, bathrooms: 1, score: 100 },
  );
  assert.equal(m.reasons.length, 1);
  assert.equal(m.sender_name, "Invented Agent Zed");
  assert.equal(m.sender_phone, SENDER);
  assert.equal(m.posted_at, "2026-11-19T12:00:00.000Z");
  assert.equal(m.excerpt, "Two bed apartment in Westmoorings, 9000 a month. Call 555 0142.");
  assert.equal(m.post_url, "https://bop.1on1realtors.com/realty/posts/W1");
});

test("BOPS_PUBLIC_URL is the link's base, a trailing slash trimmed, and the post id is URL-encoded", async () => {
  const r = await run({ ...BRIEF, sources: ["whatsapp"] }, { supply: [supplyRow({ id: "W 2/x" })], env: { ...ENV, BOPS_PUBLIC_URL: " https://invented.example.test/ " } });
  assert.equal(waOf(r)[0].post_url, "https://invented.example.test/realty/posts/W%202%2Fx");
});

test("ignored and parked rows, sale rows for a rent brief, and asks (not offers) are never returned", async () => {
  const rows = [
    supplyRow({ id: "ok" }),
    supplyRow({ id: "ignored", status: "ignored" }),
    supplyRow({ id: "parked", status: "parked" }),
    supplyRow({ id: "sale", listingType: "sale", category: "listing_for_sale", price: 900000 }),
    supplyRow({ id: "ask", listingType: "wanted" }),
    supplyRow({ id: "no-kind", listingType: null }),
  ];
  const r = await run({ ...BRIEF, sources: ["whatsapp"] }, { supply: rows });
  assert.deepEqual(waIds(r), ["ok"]);
  assert.equal(metaOf(r).whatsapp_candidates, 1, "only the live offer is a candidate");
});

test("WhatsApp offers follow the CRM rules: area, bathrooms floor, best first, the FAIR band, and the limit cuts after the count", async () => {
  const rows = [
    supplyRow({ id: "near", area: "Glencoe", baths: 2 }),
    supplyRow({ id: "same", area: "Westmoorings", baths: 2 }),
    supplyRow({ id: "far", area: "Chaguanas", baths: 2 }),
    supplyRow({ id: "one-bath", area: "Westmoorings", baths: 1 }),
  ];
  const brief = { ...BRIEF, bathrooms_min: 2, sources: ["whatsapp"] };
  const r = await run(brief, { supply: rows });
  assert.deepEqual(waIds(r), ["same", "near"], "best first; the one-bath offer is out by the floor, the far area by the area rule");
  assert.deepEqual(waOf(r).map((m) => m.score), [100, 85]);
  assert.ok(waOf(r).every((m) => m.score >= FAIR));
  assert.equal(metaOf(r).whatsapp_candidates, 3, "the count is the offers that pass the hard rules, before the area and the limit");
  const cut = await run({ ...brief, limit: 1 }, { supply: rows });
  assert.deepEqual(waIds(cut), ["same"]);
  assert.equal(metaOf(cut).whatsapp_candidates, 3);
});

test("a 'Place, Region' offer or ask scores the same as the bare place", async () => {
  const bare = await run({ ...BRIEF, location: "Chaguanas", sources: ["whatsapp"] }, { supply: [supplyRow({ area: "Chaguanas" })] });
  const withRegion = await run({ ...BRIEF, location: "Chaguanas, Central", sources: ["whatsapp"] }, { supply: [supplyRow({ area: "Chaguanas, Central" })] });
  assert.equal(waOf(bare).length, 1);
  assert.deepEqual(waOf(withRegion).map((m) => [m.id, m.score, m.location]), [["W1", waOf(bare)[0].score, "Chaguanas"]]);
});

test("the Central region rule applies to offers too: 'Central' matches the Central Trinidad places, not Fort George", async () => {
  const rows = [supplyRow({ id: "chag", area: "Chaguanas" }), supplyRow({ id: "fort", area: "Fort George" })];
  const r = await run({ ...BRIEF, location: "Central", sources: ["whatsapp"] }, { supply: rows, areas: REGION_AREAS });
  assert.deepEqual(waIds(r), ["chag"]);
});

test("nothing from the group reaches the response: no group name, chat id, or internal product name, and the excerpt keeps the post's text", async () => {
  const row = supplyRow({
    originalText: `${GROUP_MARK} posts: two bed apartment in Westmoorings, 9000 a month. Bops and Periskope welcome. Call 555 0142.`,
  });
  const r = await run({ ...BRIEF, sources: ["crm", "whatsapp"] }, { listings: ALL, supply: [row] });
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.body);
  assert.equal(text.includes(GROUP_MARK), false, "the response has the group name");
  assert.equal(/periskope|bops/i.test(text), false, "the response names an internal tool");
  assert.equal(text.includes("invented-chat-0001"), false, "the response has the chat id");
  assert.equal(/"(groups|group_name|chatId|messageIds)"/.test(text), false, "the response has a group key");
  const excerpt = waOf(r)[0].excerpt ?? "";
  assert.match(excerpt, /two bed apartment in Westmoorings, 9000 a month\..*Call 555 0142\./);
});

test("an empty store gives no WhatsApp matches, a zero count and no warning", async () => {
  const r = await run({ ...BRIEF, sources: ["whatsapp"] }, {});
  assert.equal(r.status, 200);
  assert.deepEqual(waOf(r), []);
  assert.equal(metaOf(r).whatsapp_candidates, 0);
  assert.equal("warnings" in metaOf(r), false);
});

test("a WhatsApp store that can't be read is a warning, never a failed request: the CRM matches still come back", async () => {
  const root = mkdtempSync(join(tmpdir(), "automatch-bad-store-"));
  try {
    mkdirSync(join(root, "supply.jsonl")); // the store reads this as a file, so the read throws
    const r = await run({ ...BRIEF, sources: ["crm", "whatsapp"] }, { listings: ALL, root });
    assert.equal(r.status, 200);
    assert.deepEqual(idsOf(r), ["A", "B"]);
    assert.deepEqual(waOf(r), []);
    assert.equal(metaOf(r).whatsapp_candidates, 0);
    assert.equal(warningsOf(r).length, 1);
    assert.match(warningsOf(r)[0], /WhatsApp/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("excerptOf: whitespace collapsed, null for no text, group and internal names taken out, cut at the limit with an ellipsis", () => {
  assert.equal(excerptOf("Two  bed\napartment.\n\n Call 555 0142. "), "Two bed apartment. Call 555 0142.");
  assert.equal(excerptOf(null), null);
  assert.equal(excerptOf("   \n "), null);
  assert.equal(excerptOf(`${GROUP_MARK} Periskope BOPS`, [GROUP_MARK]), null);
  assert.equal(excerptOf("Bops tips: 2 bed flat, Westmoorings."), "tips: 2 bed flat, Westmoorings.");
  assert.equal(excerptOf("Two bed in Invented Co-Broke Group Zed Westmoorings", [GROUP_MARK]), "Two bed in Westmoorings");
  assert.equal(excerptOf("Groupie post", ["Group"]), "Groupie post", "a group name is only taken out as a whole word");
  const long = excerptOf("a".repeat(300));
  assert.equal(long, `${"a".repeat(EXCERPT_MAX - 1)}…`);
  assert.equal(long?.length, EXCERPT_MAX);
  assert.equal(excerptOf("a".repeat(EXCERPT_MAX)), "a".repeat(EXCERPT_MAX), "exactly the limit is not cut");
  const words = excerptOf("word ".repeat(100));
  assert.ok(words !== null && words.length <= EXCERPT_MAX && words.endsWith("…"));
});

/* ---------------- sources: other agencies' listings (online) ---------------- */

test("online matches come back with the contract's fields, one per listing, each location asked once", async () => {
  const calls: Call[] = [];
  const r = await run({ ...BRIEF, location: ["Westmoorings", "Glencoe"], sources: ["online"] }, { market: marketOf([HIT()], calls) });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["matches", "meta", "ok", "online_matches"]);
  assert.deepEqual(r.body.matches, []);
  assert.deepEqual(calls.map((c) => c.name), ["match_buyer", "match_buyer"]);
  assert.deepEqual(calls.map(askedArea).sort(), ["Glencoe", "Westmoorings"]);
  assert.equal(calls[0].args.limit, 10);
  const got = onlineOf(r);
  assert.equal(got.length, 1, "the same listing from both locations comes back once");
  assert.deepEqual(Object.keys(got[0]).sort(), [...ONLINE_KEYS].sort());
  assert.deepEqual(got[0], {
    id: "m-1",
    title: "Invented Market Flat",
    location: "Westmoorings",
    price: 9500,
    currency: "TTD",
    listing_type: "rent",
    property_type: "apartment",
    bedrooms: 2,
    bathrooms: 1,
    score: 91,
    reasons: ["Two beds in Westmoorings"],
    source_site: "Invented Agency Zed",
    url: "https://market.example.test/listings/m-1",
  });
  assert.deepEqual(metaOf(r).sources, ["online"]);
  assert.equal("whatsapp_candidates" in metaOf(r), false);
});

test("online: one per listing (its url, else its title, place and price), best score first, capped at the brief's limit", async () => {
  const noLink = { url: undefined, title: "Invented No-Link Flat", area: "Glencoe", price: 8000 };
  const hits = [
    HIT({ url: "https://market.example.test/u1" }, { score: 0.7 }),
    HIT({ url: "https://market.example.test/u1" }, { score: 0.9 }),
    HIT(noLink, { score: 0.95 }),
    HIT(noLink, { score: 0.5 }),
    HIT({ url: "https://market.example.test/u3", title: "Invented Third Flat" }, { score: 0.6 }),
  ];
  const calls: Call[] = [];
  const r = await run({ ...BRIEF, limit: 2, sources: ["online"] }, { market: marketOf(hits, calls) });
  assert.deepEqual(onlineOf(r).map((m) => m.score), [95, 90]);
  assert.deepEqual(onlineOf(r).map((m) => m.title), ["Invented No-Link Flat", "Invented Market Flat"]);
  assert.equal(calls[0].args.limit, 2);
});

test("online: our own listings are dropped, by the market's oneonone source or our agency's name in any case", async () => {
  const hits = [
    { ...HIT({ url: "https://market.example.test/own-1" }), source: "oneonone" },
    HIT({ url: "https://market.example.test/own-2", agency: "1on1 realtors" }),
    HIT({ url: "https://market.example.test/other", agency: "Invented Agency Zed" }),
  ];
  const r = await run({ ...BRIEF, sources: ["online"] }, { market: marketOf(hits) });
  assert.deepEqual(onlineOf(r).map((m) => m.url), ["https://market.example.test/other"]);
});

test("no market set up: online matches are empty with a warning, and the CRM matches still come back", async () => {
  const r = await run({ ...BRIEF, sources: ["crm", "online"] }, { listings: ALL, market: null });
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r), ["A", "B"]);
  assert.deepEqual(onlineOf(r), []);
  assert.match(warningsOf(r).join(" "), /isn't set up/);
  // With no market injected and no market settings in env, the online source is off: no network is tried.
  const noEnv = await automatchClient({ authorization: AUTH, body: JSON.stringify({ ...BRIEF, sources: ["online"] }) }, ENV, { seam: NOT_CONNECTED, areas: AREAS, knowledge: null, now: NOW, root: EMPTY_ROOT });
  assert.equal(noEnv.status, 200);
  assert.deepEqual(onlineOf(noEnv), []);
  assert.match(warningsOf(noEnv).join(" "), /isn't set up/);
});

test("a market search that never answers is cut off at marketTimeoutMs: online empty with a timeout warning, the other sources still come back", async () => {
  const r = await run({ ...BRIEF, sources: ["crm", "whatsapp", "online"] }, { listings: ALL, supply: [supplyRow()], market: NEVER, marketTimeoutMs: 20 });
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r), ["A", "B"]);
  assert.deepEqual(waIds(r), ["W1"]);
  assert.deepEqual(onlineOf(r), []);
  assert.match(warningsOf(r).join(" "), /timed out/);
});

test("a market search that throws is unavailable, not a failed request; one location failing leaves the others' results", async () => {
  const r = await run({ ...BRIEF, sources: ["crm", "online"] }, { listings: ALL, market: BROKEN });
  assert.equal(r.status, 200);
  assert.deepEqual(idsOf(r), ["A", "B"]);
  assert.deepEqual(onlineOf(r), []);
  assert.match(warningsOf(r).join(" "), /unavailable/);
  assert.equal(JSON.stringify(r.body).includes("invented market failure"), false);

  const partial: ToolCaller = {
    callTool: async (name, args) => {
      if (askedArea({ name, args }) === "Glencoe") throw new Error("invented market failure");
      return marketReply([HIT()]);
    },
  };
  const some = await run({ ...BRIEF, location: ["Westmoorings", "Glencoe"], sources: ["online"] }, { market: partial });
  assert.equal(onlineOf(some).length, 1);
  assert.match(warningsOf(some).join(" "), /1 of 2/);
});

test("all three sources: the three lists are there, and meta has the sources and counts, with no warnings when none apply", async () => {
  const r = await run({ ...BRIEF, sources: ["crm", "whatsapp", "online"] }, { listings: ALL, supply: [supplyRow()], market: marketOf() });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["matches", "meta", "ok", "online_matches", "whatsapp_matches"]);
  assert.deepEqual(Object.keys(metaOf(r)).sort(), ["scored_at", "sources", "total_candidates", "whatsapp_candidates"]);
  assert.deepEqual(metaOf(r).sources, ["crm", "whatsapp", "online"]);
  assert.equal(metaOf(r).total_candidates, 3);
  assert.equal(metaOf(r).whatsapp_candidates, 1);
  assert.deepEqual(idsOf(r), ["A", "B"]);
  assert.deepEqual(waIds(r), ["W1"]);
  assert.equal(onlineOf(r).length, 1);
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
