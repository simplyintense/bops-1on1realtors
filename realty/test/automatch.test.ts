import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryAreaResolver } from "../flow/areas.ts";
import { askOf, automatchPairs, bandOf, scorePair, widenSuggestions, type AutomatchAsk } from "../flow/automatch.ts";
import { CRM_NOT_CONNECTED_TEXT, CRM_UNREACHABLE_TEXT, liveCrmSeam, NOT_CONNECTED, type CrmSeam, type SeamAgent } from "../flow/crm-seam.ts";
import { matchOurListings, type LiveRequest } from "../flow/live-match.ts";
import type { Listing } from "../flow/source.ts";
import { loadAutomatch, staffAutomatch } from "../node/automatch.ts";
import { SEARCH_DB } from "../node/search-store.ts";

/**
 * 1on1 CRM Automatch: the score's parts, the bands, the pairing rules (which are live matching's), the owner gate, and the
 * honest CRM notices. Invented data only: made-up people, 555-style phone numbers, invented listings.
 */

const NOW = new Date("2026-11-14T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const ASK = (over: Partial<AutomatchAsk> = {}): AutomatchAsk => ({
  id: "ask-1",
  area: "Westmoorings",
  beds: 2,
  budget: 9000,
  currency: "TTD",
  type: "apartment",
  listingType: "rent",
  lastSeenAt: ago(0),
  ...over,
});

const LISTING = (over: Partial<Listing> = {}): Listing => ({
  id: "1",
  title: "Test flat, Westmoorings",
  listingType: "rent",
  area: "Westmoorings",
  price: 9000,
  currency: "TTD",
  beds: 2,
  baths: 1,
  agentId: 7,
  status: "active",
  url: "https://1on1realtors.com/property/test-flat-westmoorings",
  ...over,
});

/** Score one ask against one listing with everything else at its best, unless a part is overridden. */
const scoreOf = (ask: Partial<AutomatchAsk>, l: Partial<Listing>, areaRelation: "same" | "nearby" | null = "same", days = 0) =>
  scorePair(ASK({ lastSeenAt: ago(days), ...ask }), LISTING(l), { areaRelation, now: NOW });

const PLACES = [
  { name: "Westmoorings", region: "North West" as const, neighbours: ["Glencoe", "Diego Martin"] },
  { name: "Glencoe", region: "North West" as const, neighbours: ["Westmoorings"] },
  { name: "Diego Martin", region: "North West" as const, neighbours: ["Westmoorings"] },
  { name: "Chaguanas", region: "Central" as const },
];
const AREAS = new MemoryAreaResolver(PLACES);

test("price: full at or under the budget, linear to 0 at 20% over, and 0 when a price is missing (stated in the reason)", () => {
  assert.equal(scoreOf({ budget: 9000 }, { price: 9000 }).parts.price, 25, "exact");
  assert.equal(scoreOf({ budget: 9000 }, { price: 8000 }).parts.price, 25, "under budget");
  assert.ok(Math.abs(scoreOf({ budget: 9000 }, { price: 9900 }).parts.price - 12.5) < 1e-9, "10% over is half");
  assert.equal(scoreOf({ budget: 9000 }, { price: 10_800 }).parts.price, 0, "20% over is zero");
  assert.equal(scoreOf({ budget: 9000 }, { price: 12_000 }).parts.price, 0, "past 20% stays zero");
  const noPrice = scoreOf({ budget: 9000 }, { price: 0 });
  assert.equal(noPrice.parts.price, 0);
  assert.match(noPrice.reason, /no price listed/);
  const noBudget = scoreOf({ budget: null }, { price: 9000 });
  assert.equal(noBudget.parts.price, 0);
  assert.match(noBudget.reason, /no budget given/);
});

test("area: same area 30, nearby 15, not checked 0", () => {
  assert.equal(scoreOf({}, {}, "same").parts.area, 30);
  assert.equal(scoreOf({}, { area: "Glencoe" }, "nearby").parts.area, 15);
  assert.equal(scoreOf({}, {}, null).parts.area, 0);
});

test("beds: exact 20, one more than asked 10, fewer than asked or two more 0, unknown 0", () => {
  assert.equal(scoreOf({ beds: 2 }, { beds: 2 }).parts.beds, 20);
  assert.equal(scoreOf({ beds: 2 }, { beds: 3 }).parts.beds, 10);
  assert.equal(scoreOf({ beds: 2 }, { beds: 1 }).parts.beds, 0, "one fewer than asked is out");
  assert.equal(scoreOf({ beds: 2 }, { beds: 4 }).parts.beds, 0);
  assert.equal(scoreOf({ beds: 2 }, { beds: 0 }).parts.beds, 0, "the listing gives no beds");
  assert.equal(scoreOf({ beds: null }, { beds: 2 }).parts.beds, 0, "the ask gives no beds");
});

test("a bedroom range (2 to 3): either end and anything between is full; one more than the top is 10; fewer than the bottom is 0", () => {
  const range = { beds: 2, bedsMax: 3 };
  assert.equal(scoreOf(range, { beds: 2 }).parts.beds, 20);
  assert.equal(scoreOf(range, { beds: 3 }).parts.beds, 20);
  assert.equal(scoreOf(range, { beds: 4 }).parts.beds, 10);
  assert.equal(scoreOf(range, { beds: 1 }).parts.beds, 0);
  assert.equal(scoreOf(range, { beds: 5 }).parts.beds, 0);
  const inside = scoreOf(range, { beds: 2 }).reason;
  assert.match(inside, /2 beds \(asked 2–3 beds\)/);
  assert.doesNotMatch(inside, /fewer|one from|one more/, "a 2 inside 2 to 3 is not one fewer");
  assert.match(scoreOf(range, { beds: 4 }).reason, /4 beds, one more than the 2–3 asked/);
});

test("the beds rule in pairs: a strict 3-bed ask is not paired with a 2-bed at its price; 3 and one more (4) are, a range takes 2 to 3", async () => {
  const at = (beds: number) => LISTING({ id: `b${beds}`, title: `${beds} bed apartment, Westmoorings`, listingType: "rent", price: 11000, beds });
  const listings = [at(1), at(2), at(3), at(4), at(5)];
  const strict = await automatchPairs([ASK({ listingType: "rent", type: "apartment", budget: 11000, beds: 3 })], listings, AREAS, NOW);
  assert.deepEqual(strict.map((p) => p.listing.id).sort(), ["b3", "b4"]);
  assert.equal(strict.find((p) => p.listing.id === "b4")?.parts.beds, 10, "one more than asked is half the beds points");
  const range = await automatchPairs([ASK({ listingType: "rent", type: "apartment", budget: 11000, beds: 2, bedsMax: 3 })], listings, AREAS, NOW);
  assert.deepEqual(range.map((p) => p.listing.id).sort(), ["b2", "b3", "b4"]);
  assert.equal(range.find((p) => p.listing.id === "b2")?.parts.beds, 20);
  assert.equal(range.find((p) => p.listing.id === "b3")?.parts.beds, 20);
});

test("type and sale or rent: 5 each; no type asked gives the kind-of-place 5; a different kind gives 0", () => {
  assert.equal(scoreOf({ listingType: "rent" }, { listingType: "rent" }).parts.saleRent, 5);
  assert.equal(scoreOf({ listingType: "rent" }, { listingType: "sale" }).parts.saleRent, 0);
  assert.equal(scoreOf({ type: null }, {}).parts.kind, 5, "no type asked");
  assert.equal(scoreOf({ type: "apartment" }, {}).parts.kind, 5, "residential as residential");
  assert.equal(scoreOf({ type: "land" }, {}).parts.kind, 0, "land asked, residential listing");
});

test("recency: full 15 up to 30 days, then step down by tier, 0 after 365 days", () => {
  const recencyAt = (days: number) => scoreOf({}, {}, "same", days).parts.recency;
  assert.equal(recencyAt(0), 15);
  assert.equal(recencyAt(5), 15, "5 days");
  assert.equal(recencyAt(29), 15, "29 days");
  assert.equal(recencyAt(30), 15, "30 days is still full");
  assert.equal(recencyAt(31), 12, "31 days drops to 12");
  assert.match(scoreOf({}, {}, "same", 2).reason, /posted 2 days ago$/);
  assert.match(scoreOf({}, {}, "same", 0).reason, /posted today$/);
});

test("recency: the tier boundaries are 60, 90, 120, 365 and 366 days", () => {
  const recencyAt = (days: number) => scoreOf({}, {}, "same", days).parts.recency;
  assert.equal(recencyAt(31), 12);
  assert.equal(recencyAt(60), 12);
  assert.equal(recencyAt(61), 9);
  assert.equal(recencyAt(90), 9);
  assert.equal(recencyAt(91), 6);
  assert.equal(recencyAt(120), 6);
  assert.equal(recencyAt(121), 3);
  assert.equal(recencyAt(365), 3);
  assert.equal(recencyAt(366), 0);
});

test("recency: a newer ask outranks an otherwise identical older one (only the age differs)", async () => {
  const day29 = scoreOf({}, {}, "same", 29);
  const day31 = scoreOf({}, {}, "same", 31);
  const day61 = scoreOf({}, {}, "same", 61);
  assert.ok(day29.score > day31.score && day31.score > day61.score);
  assert.deepEqual({ ...day29.parts, recency: 0 }, { ...day31.parts, recency: 0 }, "everything but recency is the same");

  const pairs = await automatchPairs([ASK({ id: "old", lastSeenAt: ago(61) }), ASK({ id: "new", lastSeenAt: ago(0) })], [LISTING()], AREAS, NOW);
  assert.deepEqual(pairs.map((p) => p.ask.id), ["new", "old"]);
});

test("recency is measured from the posted date (firstSentAt) when the ask has one, else from last seen", () => {
  const posted = scorePair({ ...ASK({ lastSeenAt: ago(0) }), postedAt: ago(7) }, LISTING(), { areaRelation: "same", now: NOW });
  assert.equal(posted.parts.recency, 15, "posted a week ago is still full, seen today");
  assert.match(posted.reason, /posted 7 days ago$/);
  const unparsed = scorePair({ ...ASK({ lastSeenAt: ago(0) }), postedAt: "not a date" }, LISTING(), { areaRelation: "same", now: NOW });
  assert.equal(unparsed.parts.recency, 15, "an unreadable posted date falls back to last seen");
  const oldPost = scorePair({ ...ASK({ lastSeenAt: ago(0) }), postedAt: ago(40) }, LISTING(), { areaRelation: "same", now: NOW });
  assert.equal(oldPost.parts.recency, 12, "a posted date 40 days ago is tier 12, though seen today");
  const fallback = scorePair({ ...ASK({ lastSeenAt: ago(40) }), postedAt: "not a date" }, LISTING(), { areaRelation: "same", now: NOW });
  assert.equal(fallback.parts.recency, 12, "an unreadable posted date uses last seen (40 days, tier 12)");
});

test("the score is an integer from 0 to 100, the parts add up to it, and a perfect pair is 100", () => {
  const perfect = scoreOf({}, {});
  assert.equal(perfect.score, 100);
  assert.equal(perfect.parts.price + perfect.parts.area + perfect.parts.beds + perfect.parts.saleRent + perfect.parts.kind + perfect.parts.recency, 100);
  // Ten percent over with everything else at its best: 12.5 + 30 + 20 + 5 + 5 + 15 = 87.5, rounded to 88.
  assert.equal(scoreOf({}, { price: 9900 }).score, 88);
  for (const price of [0, 5000, 9000, 9900, 10_800, 30_000])
    for (const beds of [0, 1, 2, 3, 6])
      for (const areaRelation of ["same", "nearby", null] as const)
        for (const days of [0, 2.5, 10, 29, 400]) {
          const s = scoreOf({ type: "land" }, { price, beds, listingType: "sale" }, areaRelation, days).score;
          assert.ok(Number.isInteger(s) && s >= 0 && s <= 100, `score ${s} for ${price}/${beds}/${areaRelation}/${days}`);
        }
  assert.equal(scoreOf({ type: "land", beds: 2, listingType: "rent" }, { price: 30_000, beds: 9, listingType: "sale" }, null, 400).score, 0);
});

test("the reason is one plain line in the desk's words", () => {
  const s = scorePair(ASK({ budget: 1_800_000, beds: 2, type: "house", listingType: "sale", lastSeenAt: ago(2) }), LISTING({ price: 1_750_000, beds: 2, listingType: "sale", title: "Test house" }), { areaRelation: "same", now: NOW });
  assert.equal(s.reason, "Same area (Westmoorings), 2 beds as asked, TT$1.75m within TT$1.8m budget, posted 2 days ago");
  assert.doesNotMatch(s.reason, /\n/);
});

test("bands: 75 and above strong, 50 to 74 fair, below 50 none", () => {
  assert.equal(bandOf(100), "strong");
  assert.equal(bandOf(75), "strong");
  assert.equal(bandOf(74), "fair");
  assert.equal(bandOf(50), "fair");
  assert.equal(bandOf(49), null);
});

test("pairs are eligible only by live matching's rules: a rent ask never pairs with a sale listing, and results come back best first", async () => {
  const rentAsk = ASK({ id: "rent-ask" });
  const saleAsk = ASK({ id: "sale-ask", listingType: "sale", budget: 1_800_000, beds: 3, type: "house", lastSeenAt: ago(40) });
  const listings = [
    LISTING({ id: "same", title: "Same flat", price: 8500 }),
    LISTING({ id: "near", title: "Glencoe flat", area: "Glencoe", price: 9000 }),
    LISTING({ id: "rent-dear", title: "Too dear flat", price: 11_000 }),
    LISTING({ id: "sold", title: "Sold flat", status: "sold" }),
    LISTING({ id: "for-sale", title: "House for sale", listingType: "sale", price: 1_750_000, beds: 3 }),
  ];
  const pairs = await automatchPairs([rentAsk, saleAsk], listings, AREAS, NOW);
  const forRent = pairs.filter((p) => p.ask.id === "rent-ask").map((p) => p.listing.id);
  assert.deepEqual(forRent, ["same", "near"], "same area first, and the nearby one below it");
  assert.equal(pairs.find((p) => p.listing.id === "near")?.areaRelation, "nearby");
  assert.ok(pairs.every((p) => p.ask.listingType === p.listing.listingType), "sale vs rent is never crossed");
  assert.deepEqual(pairs.filter((p) => p.ask.id === "sale-ask").map((p) => p.listing.id), ["for-sale"]);
  assert.ok(pairs.every((p, i) => i === 0 || pairs[i - 1].score >= p.score), "best first");
  assert.ok(pairs.every((p) => Number.isInteger(p.score) && p.score >= 0 && p.score <= 100));
});

test("the pairs are exactly the listings matchOurListings gives the same ask (the rules are reused, not copied)", async () => {
  const listings = [
    LISTING({ id: "a", title: "Flat A", price: 8500 }),
    LISTING({ id: "b", title: "Flat B", area: "Glencoe", price: 10_000, beds: 3 }),
    LISTING({ id: "c", title: "Flat C", area: "Chaguanas", price: 9000 }),
    LISTING({ id: "d", title: "Flat D", price: 6000, beds: 4 }),
    LISTING({ id: "e", title: "Flat E", listingType: "sale", price: 9000 }),
  ];
  const ask = ASK({ id: "x" });
  const request: LiveRequest = { intent: "rent", area: "Westmoorings", beds: 2, propertyType: "apartment", priceMin: null, priceMax: 9000, currency: "TTD", monthly: true };
  const fromMatch = (await matchOurListings(request, listings, AREAS)).map((m) => m.title).sort();
  const fromAutomatch = (await automatchPairs([ask], listings, AREAS, NOW)).map((p) => p.listing.title).sort();
  assert.deepEqual(fromAutomatch, fromMatch);
  assert.ok(fromMatch.length >= 2, "the fixture has matches to compare");
});

test("askOf: a parked, ignored, short-let or placeless record is left out; the development stands in for a missing area; USD is kept", () => {
  const row = { id: "r", area: "Westmoorings", development: null, beds: 2, price: 9000, currency: null, type: "apartment", listingType: "rent", lastSentAt: ago(1) };
  assert.deepEqual(askOf(row), { id: "r", area: "Westmoorings", beds: 2, budget: 9000, currency: "TTD", type: "apartment", listingType: "rent", lastSeenAt: row.lastSentAt });
  assert.equal(askOf({ ...row, status: "parked" }), null, "parked is left out");
  assert.equal(askOf({ ...row, status: "ignored" }), null, "ignored is left out");
  assert.equal(askOf({ ...row, listingType: "shortlet" }), null, "a short let can't match");
  assert.equal(askOf({ ...row, listingType: null }), null, "no sale or rent");
  assert.equal(askOf({ ...row, area: null, development: null }), null, "no place");
  assert.equal(askOf({ ...row, area: null, development: "Test Development" })?.area, "Test Development");
  assert.equal(askOf({ ...row, currency: "USD" })?.currency, "USD");
  assert.equal(askOf({ ...row, firstSentAt: ago(5) })?.postedAt, ago(5), "the first sight is the posted date");
  assert.equal(askOf({ ...row, firstSentAt: null })?.postedAt, undefined);
});

/* ---- the node side: owner gate, the store, the CRM seam ---- */

const OWNER = "owner@1on1.example";
const AGENT = "agent@1on1.example";
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example", BOPS_OWNER_EMAILS: OWNER };

/** One demand post in the shape the Periskope intake writes (demand.jsonl). Made-up sender and text. */
const DEMAND_ROW = (over: Record<string, unknown> = {}) => ({
  messageId: "msg-demand-1",
  chatId: "chat-test@g.us",
  groupName: "Test Group A",
  sentAt: ago(2),
  category: "buyer_request",
  senderPhone: "+18685550199",
  senderName: "Test Renter",
  area: "Westmoorings",
  price: 9000,
  currency: "TTD",
  beds: 2,
  type: "apartment",
  listingType: "rent",
  originalText: "Looking to rent a 2 bed apartment in Westmoorings, up to TT$9,000",
  ...over,
});

function storeRoot(rows: Record<string, unknown>[], overrides: Record<string, unknown>[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "automatch-"));
  writeFileSync(join(root, "demand.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (overrides.length) writeFileSync(join(root, "kind-overrides.jsonl"), overrides.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return root;
}

function fakeSeam(listings: Listing[], agents: SeamAgent[] = []) {
  const calls = { listings: 0, agents: 0 };
  const seam: CrmSeam = {
    connected: true,
    async listings() {
      calls.listings++;
      return { status: "ok", listings };
    },
    async agents() {
      calls.agents++;
      return agents;
    },
  };
  return { seam, calls };
}

const DANA: SeamAgent = { id: 7, name: "Dana Holder", email: null, phone: null };

test("automatch is read by any signed-in staff member (owner: false for an agent); signed out reads neither the store nor the CRM", async () => {
  const root = storeRoot([DEMAND_ROW()]);
  const { seam, calls } = fakeSeam([LISTING()], [DANA]);
  assert.deepEqual(await staffAutomatch({ email: null, env: GATE, root, seam, now: NOW }), { owner: false });
  assert.deepEqual(calls, { listings: 0, agents: 0 }, "signed out: the CRM isn't read");
  assert.equal(existsSync(join(root, SEARCH_DB)), false, "signed out: the search store isn't opened");

  const agent = await staffAutomatch({ email: AGENT, env: GATE, root, seam, areas: AREAS, now: NOW });
  assert.ok("pairs" in agent && agent.owner === false && agent.demand === 1, "an agent gets the same read-only data, owner false");
  assert.equal(calls.listings, 1, "the CRM is read for a signed-in agent, as for an owner");

  const view = await staffAutomatch({ email: OWNER, env: GATE, root, seam, areas: AREAS, now: NOW });
  assert.ok("pairs" in view && view.owner === true);
  assert.equal(view.demand, 1);
  assert.equal(calls.listings, 2, "one CRM read for the agent, one for the owner");
});

test("an owner sees the same-area pair with the holder's name, the stored post, and the score", async () => {
  const root = storeRoot([DEMAND_ROW()]);
  const { seam } = fakeSeam([LISTING()], [DANA]);
  const view = await loadAutomatch({ root, seam, areas: AREAS, now: NOW });
  assert.equal(view.crmText, null);
  assert.equal(view.listings, 1);
  assert.equal(view.pairs.length, 1);
  const [row] = view.pairs;
  // Posted 2 days ago: recency is full 15, so 25 + 30 + 20 + 10 + 15 is 100.
  assert.equal(row.score, 100);
  assert.equal(row.band, "strong");
  assert.equal(row.listing.agentName, "Dana Holder");
  assert.equal(row.listing.url, "https://1on1realtors.com/property/test-flat-westmoorings");
  assert.equal(row.ask.senderName, "Test Renter");
  assert.equal(row.ask.originalText, "Looking to rent a 2 bed apartment in Westmoorings, up to TT$9,000", "the contact's message is threaded through for the alert and the reply");
  assert.equal("groupName" in row.ask || "chatName" in row.ask, false, "no group name on the row");
  assert.match(row.ask.postId ?? "", /^[0-9a-f]{24}$/);
  assert.deepEqual([view.strong, view.fair], [1, 0]);
});

test("parked and ignored demand is left out of the count and the pairs", async () => {
  // Different senders, so the store's cross-post folding can't merge these into the open ask.
  const root = storeRoot(
    [
      DEMAND_ROW(),
      DEMAND_ROW({ messageId: "msg-demand-2", senderPhone: "+18685550198", senderName: "Parked Person" }),
      DEMAND_ROW({ messageId: "msg-demand-3", senderPhone: "+18685550197", senderName: "Ignored Person" }),
    ],
    [
      { messageId: "msg-demand-2", status: "parked", at: ago(1) },
      { messageId: "msg-demand-3", status: "ignored", at: ago(1) },
    ],
  );
  const { seam } = fakeSeam([LISTING()], [DANA]);
  const view = await loadAutomatch({ root, seam, areas: AREAS, now: NOW });
  assert.equal(view.demand, 1, "only the open ask is considered");
  assert.equal(view.pairs.length, 1);
  assert.equal(view.pairs[0].ask.senderName, "Test Renter");
});

test("a CRM that isn't connected gives the honest notice and no pairs; an unreachable one says so", async () => {
  const root = storeRoot([DEMAND_ROW()]);
  const notConnected = await loadAutomatch({ root, seam: NOT_CONNECTED, now: NOW });
  assert.equal(notConnected.crmText, CRM_NOT_CONNECTED_TEXT);
  assert.deepEqual(notConnected.pairs, []);
  assert.equal(notConnected.listings, 0);
  assert.equal(notConnected.demand, 1, "the demand is still counted");

  const down = liveCrmSeam({ listings: () => Promise.reject(new Error("down")), agents: () => Promise.reject(new Error("down")) });
  const unreachable = await loadAutomatch({ root, seam: down, now: NOW });
  assert.equal(unreachable.crmText, CRM_UNREACHABLE_TEXT);
  assert.deepEqual(unreachable.pairs, []);
});

test("the CLI prints the counts and the top pairs, and never a phone number or an email", () => {
  const root = storeRoot([DEMAND_ROW()]);
  const cli = new URL("../cli/automatch.ts", import.meta.url).pathname;
  // A bare environment: no CRM settings, so the CLI reads no listings and must say so.
  const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "--root", root], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
  assert.match(out, /Demand considered: 1 /);
  assert.match(out, /Active CRM listings: 0/);
  assert.match(out, /CRM not connected/);
  assert.doesNotMatch(out, /868|555|@/, "no phone number or email");
  assert.doesNotMatch(out, /Test Renter/, "the sender's name isn't printed either");
});

/* ---------------- ranged budgets (budget_min to budget_max) ---------------- */

/** A sale house with a budget range: the ceiling in `budget`, the floor in `budgetMin`. Invented listings only. */
const RANGE_ASK = (over: Partial<AutomatchAsk> = {}) => ASK({ listingType: "sale", type: "house", beds: 4, budget: 6_500_000, budgetMin: 3_000_000, ...over });
const HOUSE_AT = (price: number, over: Partial<Listing> = {}) => LISTING({ listingType: "sale", beds: 4, title: "Test house", price, ...over });
const priceScore = (ask: Partial<AutomatchAsk>, price: number) => scorePair(RANGE_ASK(ask), HOUSE_AT(price), { areaRelation: "same", now: NOW });

test("a range: anywhere from the floor to the ceiling, the ends included, is full price points", () => {
  for (const price of [3_000_000, 3_500_000, 5_000_000, 6_500_000]) assert.equal(priceScore({}, price).parts.price, 25, `TT$${price}`);
  assert.match(priceScore({}, 3_500_000).reason, /TT\$3\.5m fits TT\$3m–6\.5m budget/);
});

test("a range: under the floor or over the ceiling is linear to 0 at 20% past the edge, and the reason says how far", () => {
  const under = priceScore({}, 2_700_000);
  assert.ok(Math.abs(under.parts.price - 12.5) < 1e-9, "10% under the floor is half");
  assert.match(under.reason, /10% under the TT\$3m–6\.5m budget/);
  assert.equal(priceScore({}, 2_400_000).parts.price, 0, "20% under the floor is zero");
  assert.equal(priceScore({}, 2_000_000).parts.price, 0, "past 20% under stays zero");

  const over = priceScore({}, 7_000_000);
  assert.ok(Math.abs(over.parts.price - 25 * (1 - (0.5 / 6.5) / 0.2)) < 1e-9, "about 8% over the ceiling keeps part of the points");
  assert.match(over.reason, /8% over the TT\$3m–6\.5m budget/);
  assert.equal(priceScore({}, 7_800_000).parts.price, 0, "20% over the ceiling is zero");
  assert.equal(priceScore({}, 8_500_000).parts.price, 0);
});

test("a floor with no ceiling: full at or above it, 20% tolerance below, and no ceiling at all", () => {
  const minOnly = { budget: null, budgetMin: 3_000_000 };
  assert.equal(priceScore(minOnly, 3_000_000).parts.price, 25);
  assert.equal(priceScore(minOnly, 20_000_000).parts.price, 25, "no ceiling");
  assert.ok(Math.abs(priceScore(minOnly, 2_700_000).parts.price - 12.5) < 1e-9);
  assert.match(priceScore(minOnly, 2_700_000).reason, /10% under the TT\$3m minimum budget/);
  assert.match(priceScore(minOnly, 4_000_000).reason, /fits TT\$3m minimum budget/);
});

test("a single budget has no floor: under the figure is full, however far under (the eligibility band is the only floor)", () => {
  const single = ASK({ listingType: "sale", budget: 6_500_000 });
  assert.equal(scorePair(single, HOUSE_AT(1_000_000), { areaRelation: "same", now: NOW }).parts.price, 25);
  assert.match(scorePair(single, HOUSE_AT(1_000_000), { areaRelation: "same", now: NOW }).reason, /within TT\$6\.5m budget/);
});

test("automatchPairs gives a range's listings the range: 3.5M and 5M in, 7M in with a lower price score, 2M and 8.5M out", async () => {
  const listings = [3_500_000, 5_000_000, 2_000_000, 7_000_000, 8_500_000].map((price) => HOUSE_AT(price, { id: `p${price}` }));
  const pairs = await automatchPairs([RANGE_ASK({ id: "ask", area: "Westmoorings" })], listings, AREAS, NOW);
  assert.deepEqual(pairs.map((p) => p.listing.id).sort(), ["p3500000", "p5000000", "p7000000"]);
  const seven = pairs.find((p) => p.listing.id === "p7000000");
  assert.ok(seven && seven.parts.price > 0 && seven.parts.price < 25);
});

/* ---------------- thin results: widen suggestions ---------------- */

const THIN = { sources: ["crm"], locations: ["Chaguanas"], budgetMax: 9000, currency: "TTD" as const, bedrooms: 3, scores: [82, 74], regionOf: (p: string) => (p === "Chaguanas" ? "Central" : null) };

test("a thin CRM-only brief: suggestions to add WhatsApp and Online, a 15% higher budget, one bedroom fewer, and the parent region, in that order", () => {
  const s = widenSuggestions(THIN);
  assert.deepEqual(s?.map((x) => x.id), ["include-whatsapp", "include-online", "widen-budget", "relax-bedrooms", "expand-region-central"]);
  const patch = (id: string) => s?.find((x) => x.id === id)?.patch;
  assert.deepEqual(patch("include-whatsapp"), { sources: ["crm", "whatsapp"] });
  assert.deepEqual(patch("include-online"), { sources: ["crm", "online"] });
  assert.deepEqual(patch("widen-budget"), { budget_max: 10_350 });
  assert.deepEqual(patch("relax-bedrooms"), { bedrooms_min: 2 });
  assert.deepEqual(patch("expand-region-central"), { location: ["Chaguanas", "Central"] });
});

test("a strong result (three matches at 70 or more) has no suggestions; two at 70 or more and a 69 is still thin", () => {
  assert.equal(widenSuggestions({ ...THIN, scores: [90, 80, 70] }), null);
  assert.notEqual(widenSuggestions({ ...THIN, scores: [90, 80, 69] }), null);
  assert.notEqual(widenSuggestions({ ...THIN, scores: [] }), null, "no matches at all is thin");
});

test("a source already asked for, no budget, a bedroom count under 2, a region the brief has, and a region or island give no suggestion", () => {
  const ids = (o: Partial<Parameters<typeof widenSuggestions>[0]>) => widenSuggestions({ ...THIN, ...o })?.map((x) => x.id);
  assert.deepEqual(ids({ sources: ["crm", "whatsapp", "online"], budgetMax: null, bedrooms: 1 }), ["expand-region-central"]);
  assert.deepEqual(ids({ locations: ["Chaguanas", "Central"] }), ["include-whatsapp", "include-online", "widen-budget", "relax-bedrooms"]);
  assert.deepEqual(ids({ locations: ["Tobago"], regionOf: () => "Tobago" }), ["include-whatsapp", "include-online", "widen-budget", "relax-bedrooms"], "a region or island is not expanded");
  assert.deepEqual(ids({ locations: ["Central locations"], regionOf: () => "Central" }), ["include-whatsapp", "include-online", "widen-budget", "relax-bedrooms"], "the Central group is not expanded");
});

test("two places in one region give one region suggestion; a USD budget is labelled in US$; nothing names the internal tools", () => {
  const s = widenSuggestions({ ...THIN, locations: ["Chaguanas", "Couva"], regionOf: () => "Central", budgetMax: 500_000, currency: "USD" });
  assert.equal(s?.filter((x) => x.id.startsWith("expand-region")).length, 1);
  assert.deepEqual(s?.find((x) => x.id === "expand-region-central")?.patch, { location: ["Chaguanas", "Couva", "Central"] });
  assert.equal(s?.find((x) => x.id === "widen-budget")?.description, "Look up to US$575k instead of US$500k.");
  assert.doesNotMatch(JSON.stringify(s), /periskope|bops/i);
});
