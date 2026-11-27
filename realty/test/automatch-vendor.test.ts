import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MemoryAreaResolver, type Place } from "../flow/areas.ts";
import { FAIR, STRONG } from "../flow/automatch.ts";
import type { CrmClientDemand } from "../crm.ts";
import type { AgentReply } from "../node/agent-search.ts";
import { automatchVendor } from "../node/automatch-vendor.ts";
import type { SearchRow } from "../node/search-store.ts";
import { GATE_OPEN_PATHS } from "../../lib/gate.ts";

/**
 * POST /api/realty/automatch-vendor: the bearer gate, the offer's validation (400), the buyers and tenants scored against the
 * offered property (eligibility, ranged budgets, island isolation, place parsing), the WhatsApp requests, the sources, and the
 * response shape. Invented data only: made-up people, places as the directory names them, test secrets. No network: the CRM is
 * injected, and the one test that reads the CRM's REST API uses a fake fetch.
 */

const NOW = new Date("2026-11-20T12:00:00.000Z");
const TOKEN = "invented-automatch-token-0001";
const WRONG = "invented-automatch-token-0002";
const ENV = { BOPS_AUTOMATCH_TOKEN: TOKEN };
const AUTH = `Bearer ${TOKEN}`;
const SENDER = "+1 868 555 0142";
const GROUP = "Invented Co-Broke Group Zed";
const CRM_URL = "https://invented-project-0001.supabase.co";
const CRM_ANON = "invented-anon-key-0001";
const CRM_PASSWORD = "invented-bot-password-0001";
const SESSION = "invented-session-token-0001";
const CRM_ENV = { ...ENV, ONEON1_CRM_URL: CRM_URL, ONEON1_CRM_ANON_KEY: CRM_ANON, ONEON1_CRM_BOT_EMAIL: "invented-bot@example.test", ONEON1_CRM_BOT_PASSWORD: CRM_PASSWORD };

const PLACES: Place[] = [
  { name: "Westmoorings", region: "North West", neighbours: ["Glencoe"] },
  { name: "Glencoe", region: "North West", neighbours: ["Westmoorings"] },
  { name: "West Hills", region: "North West" },
  { name: "Chaguanas", region: "Central" },
  // Goodwood Park (Trinidad) and Goodwood (Tobago) are neighbours on the directory's word, so only the island rule keeps them apart.
  { name: "Mt. Irvine", region: "Tobago", neighbours: ["Goodwood"] },
  { name: "Goodwood", region: "Tobago", neighbours: ["Goodwood Park", "Mt. Irvine"] },
  { name: "Goodwood Park", region: "North West", neighbours: ["Goodwood"] },
  { name: "Goodwood Gardens", region: "North West" },
];
const AREAS = new MemoryAreaResolver(PLACES);
const EMPTY_ROOT = mkdtempSync(join(tmpdir(), "automatch-vendor-empty-store-"));
after(() => rmSync(EMPTY_ROOT, { recursive: true, force: true }));

/** A buyer's place as the CRM stores it (preferred_locations is a jsonb array of these). */
const loc = (place: string, region: string) => ({ type: "city", value: place, city: place, region, displayPath: `${place}, ${region}` });

const CLIENT = (over: Partial<CrmClientDemand> = {}): CrmClientDemand => ({
  id: "client-1",
  agentId: 3,
  name: "Invented Buyer Ann",
  status: "active",
  isPurchaser: true,
  isVendor: false,
  listingType: "for-sale",
  budgetMin: 1_500_000,
  budgetMax: 2_200_000,
  budgetCurrency: "TTD",
  bedroomsMin: 2,
  bathroomsMin: null,
  preferredLocations: [loc("West Hills", "North West")],
  propertyTypes: ["apartment"],
  updatedAt: "2026-11-18T12:00:00.000Z",
  ...over,
});

/** The offer a vendor sends for a West Hills apartment at TT$1.85m: inside the 1.5m–2.2m buyer range the tests use. */
const WEST_HILLS_FLAT = { listing_type: "sale", location: "West Hills", property_type: "apartment", price: 1_850_000, bedrooms: 2, bathrooms: 2 };
const TOBAGO_HOUSE = { listing_type: "sale", location: "Mt. Irvine, Tobago", property_type: "house", price: 2_000_000, bedrooms: 3, bathrooms: 2 };

const DEMAND = (over: Partial<SearchRow> = {}): SearchRow => ({
  id: "D1",
  tab: "demand",
  kind: "demand",
  senderPhone: SENDER,
  senderName: "Invented Asker Zed",
  firm: null,
  category: "ask_for_sale",
  chatId: "invented-chat-0001",
  firstSentAt: "2026-11-18T12:00:00.000Z",
  lastSentAt: "2026-11-19T12:00:00.000Z",
  timesSeen: 1,
  groups: [GROUP],
  messageIds: ["invented-msg-0001"],
  area: "West Hills",
  development: null,
  price: 2_000_000,
  currency: "TTD",
  beds: 2,
  baths: null,
  type: "apartment",
  listingType: "sale",
  intent: "buy",
  propertyClass: null,
  notes: null,
  originalText: "Looking for a 2 bed apartment in West Hills, budget TT$2m",
  ...over,
});

type RunOpts = { clients?: CrmClientDemand[]; demand?: SearchRow[]; env?: Record<string, string | undefined>; fetcher?: typeof fetch };

/** The handler with the CRM rows and the demand rows injected (none by default). No network. */
async function run(body: unknown, o: RunOpts = {}): Promise<AgentReply> {
  return automatchVendor({ authorization: AUTH, body: typeof body === "string" ? body : JSON.stringify(body) }, o.env ?? ENV, {
    clients: o.clients,
    demand: o.demand,
    areas: AREAS,
    knowledge: null,
    now: NOW,
    root: EMPTY_ROOT,
    fetcher: o.fetcher,
  });
}

type ClientOut = { client_id: string; name: string | null; client_type: string; intent: string; locations: string[]; score: number; reasons: string[]; status: string | null };
type DemandOut = { id: string; title: string; score: number; reasons: string[]; excerpt: string | null; post_url: string | null; posted_at: string | null };
const clientsOf = (r: AgentReply) => r.body.client_matches as ClientOut[];
const demandOf = (r: AgentReply) => r.body.whatsapp_requests as DemandOut[];
const metaOf = (r: AgentReply) => r.body.meta as Record<string, unknown>;
const clientIds = (r: AgentReply) => clientsOf(r).map((m) => m.client_id);

/* ---------------- the bearer gate ---------------- */

test("503 when BOPS_AUTOMATCH_TOKEN is unset or blank, even with a bearer header (never a 401)", async () => {
  for (const env of [{}, { BOPS_AUTOMATCH_TOKEN: "" }, { BOPS_AUTOMATCH_TOKEN: "   " }]) {
    for (const auth of [AUTH, `Bearer ${WRONG}`, null]) {
      const r = await automatchVendor({ authorization: auth, body: JSON.stringify(WEST_HILLS_FLAT) }, env, { clients: [CLIENT()], areas: AREAS, knowledge: null, now: NOW, root: EMPTY_ROOT });
      assert.equal(r.status, 503);
      assert.equal(typeof r.body.error, "string");
    }
  }
});

test("401 for a missing, wrong or malformed bearer, with the same body, and before the body is read", async () => {
  for (const auth of [null, "", `Token ${TOKEN}`, "Bearer", `Bearer ${WRONG}`, `Basic ${TOKEN}`, `Bearer ${TOKEN} extra`]) {
    const r = await automatchVendor({ authorization: auth, body: "not json at all" }, ENV, { clients: [CLIENT()], areas: AREAS, knowledge: null, now: NOW, root: EMPTY_ROOT });
    assert.deepEqual(r, { status: 401, body: { error: "Unauthorized." } }, String(auth));
  }
});

test("the scheme is case-insensitive, and no reply ever echoes the token", async () => {
  const r = await automatchVendor({ authorization: `bearer ${TOKEN}`, body: JSON.stringify(WEST_HILLS_FLAT) }, ENV, { clients: [CLIENT()], areas: AREAS, knowledge: null, now: NOW, root: EMPTY_ROOT });
  assert.equal(r.status, 200);
  const bad = await automatchVendor({ authorization: `Bearer ${WRONG}`, body: "{}" }, ENV, { areas: AREAS, root: EMPTY_ROOT });
  for (const reply of [r, bad]) {
    const text = JSON.stringify(reply);
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes(WRONG), false);
  }
});

/* ---------------- the offer (400s and aliases) ---------------- */

test("400 for a body that isn't a JSON object", async () => {
  for (const body of ["{", "[]", "null", '"text"', "12"]) {
    const r = await run(body);
    assert.equal(r.status, 400, body);
  }
  assert.deepEqual(await run("{"), { status: 400, body: { error: "The body must be JSON." } });
  assert.deepEqual(await run("[]"), { status: 400, body: { error: "The body must be a JSON object." } });
});

test("400 for a missing or unknown listing_type, and the aliases are accepted", async () => {
  const { listing_type: _drop, ...noType } = WEST_HILLS_FLAT;
  assert.deepEqual(await run(noType), { status: 400, body: { error: 'listing_type must be "sale" or "rent".' } });
  assert.equal((await run({ ...WEST_HILLS_FLAT, listing_type: "lend" })).status, 400);
  for (const t of ["sale", "buy", "for-sale", "SALE", " Buy "]) assert.equal((await run({ ...WEST_HILLS_FLAT, listing_type: t })).status, 200, t);
  for (const t of ["rent", "lease", "for-rent", "Rent"]) assert.equal((await run({ ...WEST_HILLS_FLAT, listing_type: t })).status, 200, t);
});

test("400 for a missing, empty or non-string location", async () => {
  const { location: _drop, ...noLocation } = WEST_HILLS_FLAT;
  assert.deepEqual(await run(noLocation), { status: 400, body: { error: "location must be a string or a list of strings." } });
  assert.deepEqual(await run({ ...WEST_HILLS_FLAT, location: "  ,  " }), { status: 400, body: { error: "location is required." } });
  assert.deepEqual(await run({ ...WEST_HILLS_FLAT, location: [] }), { status: 400, body: { error: "location is required." } });
  assert.equal((await run({ ...WEST_HILLS_FLAT, location: 5 })).status, 400);
  assert.equal((await run({ ...WEST_HILLS_FLAT, location: ["West Hills", 3] })).status, 400);
});

test("400 for a bad price, currency, beds, baths, property_type or title", async () => {
  const cases: [string, unknown][] = [
    ["price", "abc"],
    ["price", -1],
    ["currency", "EUR"],
    ["currency", ""],
    ["bedrooms", "lots"],
    ["bathrooms", -2],
    ["property_type", 3],
    ["title", ["West Hills"]],
  ];
  for (const [field, value] of cases) assert.equal((await run({ ...WEST_HILLS_FLAT, [field]: value })).status, 400, `${field}=${String(value)}`);
  assert.equal((await run({ ...WEST_HILLS_FLAT, price: null, bedrooms: null, bathrooms: null, property_type: null, title: null, currency: null })).status, 200);
});

test("currency is TTD by default and case-insensitive for USD", async () => {
  const usd = await run({ ...WEST_HILLS_FLAT, currency: "usd" }, { clients: [] });
  assert.equal(usd.status, 200);
  const usdDemand = await run({ ...WEST_HILLS_FLAT, currency: "usd" }, { demand: [DEMAND({ currency: "USD", price: 300_000 })] });
  assert.equal(usdDemand.status, 200);
});

test("400 for an empty sources list, an unknown source, or a non-list", async () => {
  assert.equal((await run({ ...WEST_HILLS_FLAT, sources: [] })).status, 400);
  assert.equal((await run({ ...WEST_HILLS_FLAT, sources: ["crm"] })).status, 400);
  assert.equal((await run({ ...WEST_HILLS_FLAT, sources: "crm_clients" })).status, 400);
  assert.deepEqual(await run({ ...WEST_HILLS_FLAT, sources: ["whatsapp"] }), { status: 400, body: { error: 'sources must be a non-empty list of "crm_clients" or "whatsapp_requests".' } });
});

test("400 for a limit that isn't a whole number of 1 or more; a limit above 50 is capped, not refused", async () => {
  for (const limit of [0, -3, 1.5, "lots"]) assert.equal((await run({ ...WEST_HILLS_FLAT, limit })).status, 400, String(limit));
  assert.equal((await run({ ...WEST_HILLS_FLAT, limit: 500 })).status, 200);
});

/* ---------------- sources ---------------- */

test("both sources by default, in the order given, with duplicates ignored", async () => {
  const r = await run(WEST_HILLS_FLAT);
  assert.deepEqual(metaOf(r).sources, ["crm_clients", "whatsapp_requests"]);
  assert.ok(Array.isArray(r.body.client_matches) && Array.isArray(r.body.whatsapp_requests));
  const dup = await run({ ...WEST_HILLS_FLAT, sources: ["whatsapp_requests", "crm_clients", "whatsapp_requests"] });
  assert.deepEqual(metaOf(dup).sources, ["whatsapp_requests", "crm_clients"]);
});

test("without whatsapp_requests the demand is not read: zero candidates, an empty list, and the clients still scored", async () => {
  const r = await run({ ...WEST_HILLS_FLAT, sources: ["crm_clients"] }, { clients: [CLIENT()], demand: [DEMAND()] });
  assert.deepEqual(r.body.whatsapp_requests, []);
  assert.equal(metaOf(r).whatsapp_candidates, 0);
  assert.deepEqual(clientIds(r), ["client-1"]);
});

test("without crm_clients the clients are not read: zero candidates, an empty list, and the demand still scored", async () => {
  const r = await run({ ...WEST_HILLS_FLAT, sources: ["whatsapp_requests"] }, { clients: [CLIENT()], demand: [DEMAND()] });
  assert.deepEqual(r.body.client_matches, []);
  assert.equal(metaOf(r).crm_candidates, 0);
  assert.deepEqual(demandOf(r).map((m) => m.id), ["D1"]);
});

test("the CRM not set up is a 503 when it's the only source, and a warning with empty client matches otherwise", async () => {
  const only = await automatchVendor({ authorization: AUTH, body: JSON.stringify({ ...WEST_HILLS_FLAT, sources: ["crm_clients"] }) }, ENV, { areas: AREAS, knowledge: null, now: NOW, root: EMPTY_ROOT });
  assert.equal(only.status, 503);
  assert.equal(typeof only.body.error, "string");
  const both = await automatchVendor({ authorization: AUTH, body: JSON.stringify(WEST_HILLS_FLAT) }, ENV, { demand: [DEMAND()], areas: AREAS, knowledge: null, now: NOW, root: EMPTY_ROOT });
  assert.equal(both.status, 200);
  assert.deepEqual(clientsOf(both), []);
  assert.ok((metaOf(both).warnings as string[]).length >= 1);
  assert.deepEqual(demandOf(both).map((m) => m.id), ["D1"]);
});

test("a failed CRM read is a 503 when it's the only source, and a warning otherwise; the reply carries no secret", async () => {
  const failing = (async () => {
    throw new Error("invented network failure");
  }) as unknown as typeof fetch;
  const only = await run({ ...WEST_HILLS_FLAT, sources: ["crm_clients"] }, { env: CRM_ENV, fetcher: failing });
  assert.equal(only.status, 503);
  const both = await run(WEST_HILLS_FLAT, { env: CRM_ENV, fetcher: failing, demand: [DEMAND()] });
  assert.equal(both.status, 200);
  assert.deepEqual(clientsOf(both), []);
  assert.deepEqual(demandOf(both).map((m) => m.id), ["D1"]);
  const text = JSON.stringify(both);
  for (const secret of [CRM_ANON, CRM_PASSWORD, TOKEN]) assert.equal(text.includes(secret), false);
});

test("the CRM read asks the view first, then the table, with only the columns it needs (no notes, contact details or requirements)", async () => {
  const urls: string[] = [];
  const row = {
    id: "client-row-0001",
    agent_id: 3,
    name: "Invented Buyer Ann",
    status: "active",
    is_purchaser: true,
    is_vendor: false,
    listing_type: "for-sale",
    budget_min: 1_500_000,
    budget_max: "2200000",
    budget_currency: "TTD",
    bedrooms_min: 2,
    bathrooms_min: null,
    preferred_locations: [loc("West Hills", "North West")],
    property_types: ["apartment"],
    updated_at: "2026-11-18T12:00:00.000Z",
    notes: "invented note that must never leave",
    email: "invented-buyer@example.test",
    phone: "+1 868 555 0199",
    additional_requirements: "invented requirement text",
  };
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/auth/v1/token")) return Response.json({ access_token: SESSION, expires_in: 3600 });
    if (url.includes("/rest/v1/bops_crm_clients")) return new Response("not found", { status: 404 });
    if (url.includes("/rest/v1/crm_clients")) return Response.json([row]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const r = await run(WEST_HILLS_FLAT, { env: CRM_ENV, fetcher, demand: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(clientIds(r), ["client-row-0001"]);
  const view = urls.findIndex((u) => u.includes("/rest/v1/bops_crm_clients"));
  const table = urls.findIndex((u) => u.includes("/rest/v1/crm_clients"));
  assert.ok(view >= 0 && table > view, "the view is tried first, then the table");
  const select = new URL(urls[table]).searchParams.get("select") ?? "";
  for (const col of ["id", "agent_id", "name", "status", "is_purchaser", "is_vendor", "listing_type", "budget_min", "budget_max", "budget_currency", "bedrooms_min", "bathrooms_min", "preferred_locations", "property_types"]) {
    assert.ok(select.split(",").includes(col), col);
  }
  for (const col of ["notes", "email", "phone", "additional_requirements"]) assert.equal(select.split(",").includes(col), false, col);
  const text = JSON.stringify(r);
  for (const leak of ["invented note", "invented-buyer@example.test", "555 0199", "invented requirement", CRM_ANON, CRM_PASSWORD, SESSION]) assert.equal(text.includes(leak), false, leak);
});

/* ---------------- CRM eligibility ---------------- */

test("only active buyers and tenants with a matching intent and a place are eligible", async () => {
  const clients = [
    CLIENT({ id: "good" }),
    CLIENT({ id: "inactive", status: "inactive" }),
    CLIENT({ id: "closed", status: "closed" }),
    CLIENT({ id: "lost", status: "lost" }),
    CLIENT({ id: "no-status", status: null }),
    CLIENT({ id: "vendor", isVendor: true }),
    CLIENT({ id: "not-purchaser", isPurchaser: false }),
    CLIENT({ id: "no-intent", listingType: null }),
    CLIENT({ id: "rent-tenant", listingType: "for-rent" }),
    CLIENT({ id: "no-place", preferredLocations: [] }),
  ];
  const r = await run(WEST_HILLS_FLAT, { clients });
  assert.deepEqual(clientIds(r), ["good"]);
  assert.equal(metaOf(r).crm_candidates, 1);
});

test("a rent tenant is matched to a rent property, and a buyer to a sale one", async () => {
  const tenant = CLIENT({ id: "tenant", listingType: "for-rent", budgetMin: null, budgetMax: 9_000, budgetCurrency: "TTD", bedroomsMin: 2 });
  const rent = await run({ ...WEST_HILLS_FLAT, listing_type: "rent", price: 8_500, bedrooms: 2 }, { clients: [tenant] });
  assert.deepEqual(clientIds(rent), ["tenant"]);
  assert.equal(clientsOf(rent)[0].client_type, "tenant");
  assert.equal(clientsOf(rent)[0].intent, "rent");
  const sale = await run(WEST_HILLS_FLAT, { clients: [tenant] });
  assert.deepEqual(clientIds(sale), []);
});

test("an active buyer with a ranged budget fits a West Hills apartment at TT$1.85m, with a 'fits … budget' reason", async () => {
  const r = await run(WEST_HILLS_FLAT, { clients: [CLIENT()] });
  assert.equal(clientsOf(r).length, 1);
  const m = clientsOf(r)[0];
  assert.ok(m.score >= STRONG, `score ${m.score}`);
  assert.ok(m.reasons[0].includes("fits"), m.reasons[0]);
  assert.equal(m.client_type, "buyer");
  assert.equal(m.intent, "buy");
  assert.deepEqual(m.locations, ["West Hills"]);
  assert.equal(m.status, "active");
});

test("a buyer whose range is far from the price is not a candidate", async () => {
  const far = CLIENT({ id: "far", budgetMin: 3_000_000, budgetMax: 4_000_000 });
  const r = await run(WEST_HILLS_FLAT, { clients: [far] });
  assert.deepEqual(clientIds(r), []);
  assert.equal(metaOf(r).crm_candidates, 0);
});

test("a client who could take the property but whose place isn't related is a candidate, not a match", async () => {
  const chag = CLIENT({ id: "chag", preferredLocations: [loc("Chaguanas", "Central")] });
  const r = await run(WEST_HILLS_FLAT, { clients: [chag] });
  assert.equal(metaOf(r).crm_candidates, 1);
  assert.deepEqual(clientIds(r), []);
});

test("bathrooms_min is a floor: a known count below it is out, an unknown count passes", async () => {
  const picky = CLIENT({ id: "picky", bathroomsMin: 3 });
  assert.deepEqual(clientIds(await run(WEST_HILLS_FLAT, { clients: [picky] })), []);
  const fine = CLIENT({ id: "fine", bathroomsMin: 2 });
  assert.deepEqual(clientIds(await run(WEST_HILLS_FLAT, { clients: [fine] })), ["fine"]);
  const unknown = CLIENT({ id: "unknown", bathroomsMin: 3 });
  assert.deepEqual(clientIds(await run({ ...WEST_HILLS_FLAT, bathrooms: null }, { clients: [unknown] })), ["unknown"]);
});

test("the best place per client is kept, and a client appears once", async () => {
  const twoPlaces = CLIENT({ id: "two", preferredLocations: [loc("Chaguanas", "Central"), loc("West Hills", "North West")] });
  const r = await run(WEST_HILLS_FLAT, { clients: [twoPlaces] });
  assert.deepEqual(clientIds(r), ["two"]);
  assert.deepEqual(clientsOf(r)[0].locations, ["Chaguanas", "West Hills"]);
});

/* ---------------- island isolation and place parsing ---------------- */

/** A buyer whose budget and beds fit the Tobago house, asking for one place: only the place decides the match. */
const HOUSE_BUYER = (id: string, place: string, region: string) =>
  CLIENT({ id, preferredLocations: [loc(place, region)], propertyTypes: ["house"], budgetMin: 1_500_000, budgetMax: 2_500_000, bedroomsMin: 3 });

test("a Trinidad buyer next door to a Tobago house is a candidate but not a match: the island keeps the neighbours apart", async () => {
  const r = await run({ ...TOBAGO_HOUSE, location: "Goodwood, Tobago" }, { clients: [HOUSE_BUYER("goodwood-park", "Goodwood Park", "North West")] });
  assert.equal(metaOf(r).crm_candidates, 1);
  assert.deepEqual(clientIds(r), []);
});

test("a Tobago buyer next door to a Trinidad house is a candidate but not a match", async () => {
  const r = await run({ ...TOBAGO_HOUSE, location: "Goodwood Park" }, { clients: [HOUSE_BUYER("goodwood-tobago", "Goodwood", "Tobago")] });
  assert.equal(metaOf(r).crm_candidates, 1);
  assert.deepEqual(clientIds(r), []);
});

test("the Goodwood Gardens compound is Trinidad, whatever the Tobago village is called", async () => {
  const r = await run({ ...TOBAGO_HOUSE, location: ["Goodwood", "Tobago"] }, { clients: [HOUSE_BUYER("gardens", "Goodwood Gardens", "North West")] });
  assert.deepEqual(clientIds(r), []);
});

test("controls: a Mt. Irvine buyer matches the Tobago house, and a Goodwood (Tobago) neighbour of it matches too", async () => {
  const r = await run(TOBAGO_HOUSE, { clients: [HOUSE_BUYER("mt-irvine", "Mt. Irvine", "Tobago"), HOUSE_BUYER("goodwood-tobago", "Goodwood", "Tobago")] });
  assert.deepEqual(clientIds(r).sort(), ["goodwood-tobago", "mt-irvine"]);
  for (const m of clientsOf(r)) assert.ok(m.score >= FAIR, `${m.client_id} ${m.score}`);
});

test("a Tobago region buyer does not match a West Hills (Trinidad) apartment", async () => {
  const tobagoRegion = CLIENT({ id: "tobago-region", preferredLocations: [{ type: "region", value: "Tobago", region: "Tobago", displayPath: "Tobago" }] });
  assert.deepEqual(clientIds(await run(WEST_HILLS_FLAT, { clients: [tobagoRegion] })), []);
});

test("a Tobago region buyer matches a Tobago vendor house in a Tobago place", async () => {
  const tobagoRegion = CLIENT({ id: "tobago-region", preferredLocations: [{ type: "region", value: "Tobago", region: "Tobago", displayPath: "Tobago" }], propertyTypes: ["house"], budgetMin: 1_500_000, budgetMax: 2_500_000, bedroomsMin: 3 });
  assert.deepEqual(clientIds(await run(TOBAGO_HOUSE, { clients: [tobagoRegion] })), ["tobago-region"]);
});

test("a West Hills vendor does not match a Tobago buyer or a Tobago WhatsApp ask", async () => {
  const tobago = CLIENT({ id: "tobago", preferredLocations: [loc("Mt. Irvine", "Tobago")] });
  const tobagoAsk = DEMAND({ id: "T1", area: "Mt. Irvine", development: null, type: "apartment", listingType: "sale", price: 2_000_000, beds: 2, originalText: "2 bed apartment Mt. Irvine Tobago for sale" });
  const r = await run(WEST_HILLS_FLAT, { clients: [tobago], demand: [tobagoAsk] });
  assert.deepEqual(clientIds(r), []);
  assert.deepEqual(demandOf(r), []);
});

test("a Goodwood Gardens (Trinidad compound) buyer does not match a Tobago Goodwood house, and a Tobago buyer does not match Goodwood Gardens", async () => {
  const gardensBuyer = CLIENT({ id: "gardens", preferredLocations: [loc("Goodwood Gardens", "North West")], propertyTypes: ["house"], budgetMin: 1_500_000, budgetMax: 2_500_000, bedroomsMin: 3 });
  const goodwoodOffer = { ...TOBAGO_HOUSE, location: ["Goodwood", "Tobago"] };
  assert.deepEqual(clientIds(await run(goodwoodOffer, { clients: [gardensBuyer] })), []);
  const tobagoBuyer = CLIENT({ id: "goodwood-tobago", preferredLocations: [loc("Goodwood", "Tobago")], propertyTypes: ["house"], budgetMin: 1_500_000, budgetMax: 2_500_000, bedroomsMin: 3 });
  const gardensOffer = { ...TOBAGO_HOUSE, location: "Goodwood Gardens" };
  assert.deepEqual(clientIds(await run(gardensOffer, { clients: [tobagoBuyer] })), []);
});

test("a place object is read by its value, and a plain-string place as itself", async () => {
  const withRegion = CLIENT({ id: "obj", preferredLocations: [{ type: "city", value: "Mt. Irvine", region: "Tobago" }], propertyTypes: ["house"], budgetMin: 1_500_000, budgetMax: 2_500_000, bedroomsMin: 3 });
  const plain = CLIENT({ id: "plain", preferredLocations: ["Mt. Irvine"], propertyTypes: ["house"], budgetMin: 1_500_000, budgetMax: 2_500_000, bedroomsMin: 3 });
  const r = await run(TOBAGO_HOUSE, { clients: [withRegion, plain] });
  assert.deepEqual(clientsOf(r).map((m) => m.locations), [["Mt. Irvine"], ["Mt. Irvine"]]);
  assert.deepEqual(clientIds(r).sort(), ["obj", "plain"]);
});

/* ---------------- the offer's listing ---------------- */

test("a comma-separated location is split: the area is the place, and the region words stay on the title", async () => {
  // A Tobago house listed as "Mt. Irvine, Tobago" matches a Mt. Irvine buyer: the area is "Mt. Irvine", the island is on the title.
  const tobago = CLIENT({ id: "tobago-buyer", preferredLocations: [loc("Mt. Irvine", "Tobago")], propertyTypes: ["house"], budgetMin: 1_500_000, budgetMax: 2_500_000, bedroomsMin: 3 });
  assert.deepEqual(clientIds(await run({ ...TOBAGO_HOUSE, location: "Mt. Irvine, Tobago" }, { clients: [tobago] })), ["tobago-buyer"]);
  assert.deepEqual(clientIds(await run({ ...TOBAGO_HOUSE, location: ["Mt. Irvine", "Tobago"] }, { clients: [tobago] })), ["tobago-buyer"]);
});

test("a listing with no price can still be matched (its price part is 0)", async () => {
  const noPrice = { ...WEST_HILLS_FLAT, price: null };
  const r = await run(noPrice, { clients: [CLIENT()] });
  assert.deepEqual(clientIds(r), ["client-1"]);
  assert.ok(clientsOf(r)[0].reasons[0].includes("no price listed"), clientsOf(r)[0].reasons[0]);
});

/* ---------------- WhatsApp requests ---------------- */

test("a WhatsApp ask for the same place and budget scores, with its sender and link but no group name", async () => {
  const r = await run(WEST_HILLS_FLAT, { demand: [DEMAND()] });
  const [m] = demandOf(r);
  assert.equal(m.id, "D1");
  assert.ok(m.score >= FAIR);
  assert.equal(m.title, "2 bed apartment");
  assert.equal(m.posted_at, "2026-11-18T12:00:00.000Z");
  assert.equal(m.post_url, "https://bop.1on1realtors.com/realty/posts/D1");
  assert.equal(m.excerpt, "Looking for a 2 bed apartment in West Hills, budget TT$2m");
  assert.equal(metaOf(r).whatsapp_candidates, 1);
});

test("a single price is a ceiling: at or under it is full price points, a dearer one falls below FAIR", async () => {
  const under = await run(WEST_HILLS_FLAT, { demand: [DEMAND({ price: 2_000_000 })] });
  assert.ok(demandOf(under)[0].reasons[0].includes("within"), demandOf(under)[0].reasons[0]);
  const low = await run(WEST_HILLS_FLAT, { demand: [DEMAND({ id: "low", price: 1_000_000 })] });
  assert.deepEqual(demandOf(low).map((m) => m.id), []);
  assert.equal(metaOf(low).whatsapp_candidates, 0);
});

test("a WhatsApp ask whose single figure is under the property's price is not a candidate, while a buyer on the same property is", async () => {
  const low = DEMAND({ id: "low", price: 1_000_000 });
  const r = await run(WEST_HILLS_FLAT, { clients: [CLIENT()], demand: [low] });
  assert.deepEqual(clientIds(r), ["client-1"]);
  assert.deepEqual(demandOf(r), []);
  assert.equal(metaOf(r).whatsapp_candidates, 0);
});

test("ignored, parked, rent-only, placeless and non-sale-or-rent asks are left out", async () => {
  const rows = [
    DEMAND({ id: "ignored", status: "ignored" }),
    DEMAND({ id: "parked", status: "parked" }),
    DEMAND({ id: "rent", listingType: "rent" }),
    DEMAND({ id: "noplace", area: null, development: null }),
    DEMAND({ id: "shortlet", listingType: "shortlet" }),
  ];
  const r = await run(WEST_HILLS_FLAT, { demand: rows });
  assert.deepEqual(demandOf(r), []);
  assert.equal(metaOf(r).whatsapp_candidates, 0);
});

test("a demand store with no files is zero candidates and no warning", async () => {
  const r = await run(WEST_HILLS_FLAT, { clients: [] });
  assert.equal(metaOf(r).whatsapp_candidates, 0);
  assert.equal(metaOf(r).warnings, undefined);
});

test("the WhatsApp excerpt and body carry no group name and no internal product name", async () => {
  const dirty = DEMAND({
    id: "dirty",
    groups: [GROUP],
    originalText: `Periskope test: looking for a 2 bed apartment in West Hills, budget TT$2m. Bops ask. ${GROUP} says hello.`,
  });
  const r = await run(WEST_HILLS_FLAT, { demand: [dirty] });
  const [m] = demandOf(r);
  assert.ok(m);
  assert.equal(m.excerpt?.includes(GROUP), false);
  const text = JSON.stringify(r);
  for (const banned of ["group_name", GROUP, "Periskope", "periskope", "Bops", "BOPS"]) assert.equal(text.includes(banned), false, banned);
});

test("two near-identical asks from one sender fold into one row, the best score standing", async () => {
  const a = DEMAND({ id: "a", timesSeen: 1 });
  const b = DEMAND({ id: "b", timesSeen: 1, firstSentAt: "2026-11-19T12:00:00.000Z", lastSentAt: "2026-11-19T13:00:00.000Z" });
  const r = await run(WEST_HILLS_FLAT, { demand: [a, b] });
  assert.equal(demandOf(r).length, 1);
});

/* ---------------- limit, shape and the gate ---------------- */

test("limit caps each list, and the default is 15", async () => {
  const many = Array.from({ length: 20 }, (_, i) => CLIENT({ id: `c${i}`, updatedAt: "2026-11-18T12:00:00.000Z" }));
  const all = await run(WEST_HILLS_FLAT, { clients: many });
  assert.equal(clientsOf(all).length, 15);
  const two = await run({ ...WEST_HILLS_FLAT, limit: 2 }, { clients: many });
  assert.equal(clientsOf(two).length, 2);
  const demand = Array.from({ length: 4 }, (_, i) => DEMAND({ id: `d${i}`, senderPhone: `+1 868 555 00${i}0`, firstSentAt: "2026-11-18T12:00:00.000Z" }));
  const limitedDemand = await run({ ...WEST_HILLS_FLAT, limit: 3 }, { demand });
  assert.equal(demandOf(limitedDemand).length, 3);
});

test("a 200 body carries both lists, the candidate counts, the scored time and the sources", async () => {
  const r = await run(WEST_HILLS_FLAT, { clients: [CLIENT()], demand: [DEMAND()] });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(Object.keys(r.body).sort(), ["client_matches", "meta", "ok", "whatsapp_requests"]);
  const meta = metaOf(r);
  assert.equal(meta.scored_at, NOW.toISOString());
  assert.equal(meta.crm_candidates, 1);
  assert.equal(meta.whatsapp_candidates, 1);
  assert.deepEqual(meta.sources, ["crm_clients", "whatsapp_requests"]);
  assert.equal(meta.widen_suggestions, undefined);
});

test("the client's contact details and notes are not in the reply", async () => {
  const withContacts = CLIENT({ id: "contact" });
  const r = await run(WEST_HILLS_FLAT, { clients: [withContacts] });
  assert.equal(clientsOf(r).length, 1);
  assert.deepEqual(Object.keys(clientsOf(r)[0]).sort(), ["agent_id", "budget_max", "budget_min", "bedrooms_min", "client_id", "client_type", "currency", "intent", "locations", "name", "property_type", "reasons", "score", "status"].sort());
});

test("the gate lists the vendor path as open and as a tailnet path", () => {
  assert.equal(GATE_OPEN_PATHS.has("/api/realty/automatch-vendor"), true);
  assert.equal(GATE_OPEN_PATHS.has("/api/realty/automatch-vendor/"), false);
  const proxy = readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");
  const line = proxy.split("\n").find((l) => l.startsWith("const TAILNET_PATHS"));
  assert.ok(line?.includes('"/api/realty/automatch-vendor"'));
});
