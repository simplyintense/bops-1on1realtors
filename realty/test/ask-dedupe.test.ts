import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryAreaResolver } from "../flow/areas.ts";
import { askOf, automatchPairs, dedupeCounts, foldSameSenderPairs, scorePair, type AutomatchAsk } from "../flow/automatch.ts";
import { ASK_BUDGET_TOLERANCE, sameDemandAsk, type AskFacts } from "../flow/ask-match.ts";
import type { Listing } from "../flow/source.ts";
import { loadAutomatch } from "../node/automatch.ts";

/**
 * Duplicate asks: the same-ask rule (ask-match.ts), Automatch's one row per sender's near-identical asks on a listing, and the
 * before/after counts. Invented people, numbers and listings only.
 */

const NOW = new Date("2026-11-14T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const FACTS = (over: Partial<AskFacts> = {}): AskFacts => ({ category: "buyer_request", area: "Maraval", development: null, beds: 3, price: 2_500_000, currency: "TTD", type: "house", listingType: "sale", ...over });

test("the same-ask rule: same place, beds, type, sale or rent, budget within 10%", () => {
  assert.equal(sameDemandAsk(FACTS(), FACTS({ price: 2_600_000 })), true, "4% over is the same budget");
  assert.equal(sameDemandAsk(FACTS(), FACTS({ price: 2_750_000 })), true, "10% over is still the same");
  assert.equal(sameDemandAsk(FACTS(), FACTS({ price: 2_800_000 })), false, "past 10% is another budget");
  assert.equal(sameDemandAsk(FACTS({ price: null }), FACTS({ price: null })), true, "both budgets missing agree");
  assert.equal(sameDemandAsk(FACTS({ price: null }), FACTS()), false, "one budget missing doesn't");
  assert.equal(sameDemandAsk(FACTS(), FACTS({ beds: 4 })), false);
  assert.equal(sameDemandAsk(FACTS({ beds: null }), FACTS({ beds: null })), true, "no beds matches no beds");
  assert.equal(sameDemandAsk(FACTS({ beds: null }), FACTS()), false, "no beds doesn't match a set number");
  assert.equal(sameDemandAsk(FACTS({ type: null }), FACTS()), true, "no type matches a set type");
  assert.equal(sameDemandAsk(FACTS({ type: "land" }), FACTS()), false, "a different type doesn't");
  assert.equal(sameDemandAsk(FACTS({ listingType: "rent" }), FACTS()), false, "sale and rent never fold");
  assert.equal(sameDemandAsk(FACTS({ area: "Woodbrook" }), FACTS()), false, "another area doesn't");
  assert.equal(sameDemandAsk(FACTS({ currency: "USD", price: 2_500_000 / 6.78 }), FACTS()), true, "US$ at the fixed rate is the same TT$ budget");
  assert.ok(ASK_BUDGET_TOLERANCE === 0.1);
});

test("a house and a townhouse from one sender are the same ask; a house and an apartment are not", () => {
  assert.equal(sameDemandAsk(FACTS({ type: "house" }), FACTS({ type: "townhouse" })), true);
  assert.equal(sameDemandAsk(FACTS({ type: "house" }), FACTS({ type: "apartment" })), false);
  assert.equal(sameDemandAsk(FACTS({ type: null }), FACTS({ type: "apartment" })), true, "no type given agrees with any");
});

test("a development and its parent area are the same broad area; two different developments in one parent are not", () => {
  const parent = FACTS({ area: "Westmoorings", development: null });
  assert.equal(sameDemandAsk(FACTS({ area: "Westmoorings", development: "La Fontaine" }), parent), true, "a development and its parent");
  assert.equal(sameDemandAsk(FACTS({ area: "La Fontaine", development: null }), FACTS({ area: "Westmoorings", development: "La Fontaine" })), true, "the development named as the area");
  assert.equal(sameDemandAsk(FACTS({ area: "Westmoorings", development: "La Fontaine" }), FACTS({ area: "Westmoorings", development: "The Towers" })), false, "two developments are two places");
});

test("the Carnival case: two underspecified shortlet asks with no place, beds or budget are never the same ask", () => {
  const bare = FACTS({ area: null, development: null, beds: null, price: null, type: "carnival rental", listingType: "shortlet", category: "rental_request" });
  assert.equal(sameDemandAsk(bare, { ...bare }), false);
});

const ASK = (over: Partial<AutomatchAsk> = {}): AutomatchAsk => ({ id: "ask", area: "Westmoorings", beds: 2, budget: 9000, currency: "TTD", type: "apartment", listingType: "rent", lastSeenAt: ago(1), sender: "+18685550101", posts: 1, ...over });
const LISTING = (over: Partial<Listing> = {}): Listing => ({ id: "1", title: "Flat", listingType: "rent", area: "Westmoorings", price: 8500, currency: "TTD", beds: 2, baths: 1, agentId: 7, status: "active", url: "", ttdEquiv: null, ...over });
const AREAS = new MemoryAreaResolver([{ name: "Westmoorings", region: "North West", neighbours: [] }]);

test("one sender's near-identical asks on one listing are one row: the best score (tie: the newer ask), and the posts add up", async () => {
  const asks = [
    ASK({ id: "old", lastSeenAt: ago(9), posts: 2 }),
    ASK({ id: "new", lastSeenAt: ago(1), posts: 3 }),
    ASK({ id: "other-sender", sender: "+18685550102", lastSeenAt: ago(1), posts: 1 }),
  ];
  const pairs = await automatchPairs(asks, [LISTING({ id: "a" })], AREAS, NOW);
  assert.equal(pairs.length, 3, "before folding, one pair per ask and listing");
  const groups = foldSameSenderPairs(pairs);
  assert.equal(groups.length, 2, "the two of one sender are one row");
  const mine = groups.find((g) => g.ask.sender === "+18685550101");
  assert.ok(mine);
  assert.equal(mine.ask.id, "new", "the newer ask stands on a tie");
  assert.equal(mine.posts, 5, "2 + 3 posts");
  assert.equal(groups.find((g) => g.ask.sender === "+18685550102")?.posts, 1);
});

test("a better-scoring ask stands even when it is older; asks without a sender are never folded", async () => {
  const asks = [
    ASK({ id: "good", budget: 8500, lastSeenAt: ago(9), posts: 1 }),
    ASK({ id: "dear", budget: 8000, lastSeenAt: ago(1), posts: 1 }), // within 10%, so the same ask, but 6% over the listing: a lower score
    ASK({ id: "anon-1", sender: undefined, lastSeenAt: ago(1) }),
    ASK({ id: "anon-2", sender: undefined, lastSeenAt: ago(1) }),
  ];
  const pairs = await automatchPairs(asks, [LISTING({ id: "a" })], AREAS, NOW);
  const groups = foldSameSenderPairs(pairs);
  const mine = groups.find((g) => g.ask.sender === "+18685550101");
  assert.equal(mine?.ask.id, "good", "the higher score stands");
  assert.equal(mine?.posts, 2);
  assert.equal(groups.filter((g) => g.ask.sender == null).length, 2, "no sender, no folding");
});

test("a different listing is a different row, and a listing repeated in the CRM's list is counted once", async () => {
  const asks = [ASK({ id: "a1" })];
  const listings = [LISTING({ id: "L1" }), LISTING({ id: "L1" }), LISTING({ id: "L2", title: "Another flat" })];
  const pairs = await automatchPairs(asks, listings, AREAS, NOW);
  assert.deepEqual(pairs.map((p) => p.listing.id).sort(), ["L1", "L2"]);
  assert.equal(foldSameSenderPairs(pairs).length, 2);
});

test("dedupeCounts gives the pairs before and after folding, per band", async () => {
  const asks = [ASK({ id: "x", lastSeenAt: ago(1), posts: 1 }), ASK({ id: "y", lastSeenAt: ago(2), posts: 1, budget: 8500 }), ASK({ id: "z", sender: "+18685550102", posts: 1, budget: 9000 })];
  const pairs = await automatchPairs(asks, [LISTING({ id: "a" })], AREAS, NOW);
  const counts = dedupeCounts(pairs);
  assert.deepEqual(counts.strong, { before: 3, after: 2 }, "the sender's two strong pairs are one row");
  assert.deepEqual(counts.fair, { before: 0, after: 0 });
});

test("the same score through the price band still gives the same parts: a USD ask folds with its TT$ equivalent", () => {
  const usd = ASK({ budget: 1_300, currency: "USD" }); // about TT$8,814
  const ttd = ASK({ id: "t", budget: 8_814 });
  const same = sameDemandAsk(askFactsForTest(usd), askFactsForTest(ttd));
  assert.equal(same, true);
  const s = scorePair(usd, LISTING({}), { areaRelation: "same", now: NOW });
  assert.equal(s.parts.price, 35, "TT$8,500 is within US$1,300 (TT$8,814)");
});

test("askOf keeps the sender and the post count, and leaves them out when the record has none", () => {
  const row = { id: "r", area: "Westmoorings", development: null, beds: 2, price: 9000, currency: null, type: "apartment", listingType: "rent", lastSentAt: ago(1) };
  assert.deepEqual(askOf({ ...row, senderPhone: "+18685550101", timesSeen: 3 })?.sender, "+18685550101");
  assert.equal(askOf({ ...row, senderPhone: "+18685550101", timesSeen: 3 })?.posts, 3);
  assert.equal(askOf(row)?.sender, undefined);
});

test("loadAutomatch: one sender's posts that the store didn't fold show as one row with the posts counted", async () => {
  const root = mkdtempSync(join(tmpdir(), "ask-dedupe-"));
  const post = (messageId: string, sentAt: string, over: Record<string, unknown> = {}) => ({
    messageId, chatId: "chat-test@g.us", groupName: "Test Group A", sentAt, category: "buyer_request", senderPhone: "+18685550199", senderName: "Test Renter",
    area: "Westmoorings", price: 9000, currency: "TTD", beds: 2, type: "apartment", listingType: "rent", originalText: `wording ${messageId}`, ...over,
  });
  // Two asks, a month apart: the store's 14-day window keeps them apart, Automatch folds them on the listing.
  writeFileSync(join(root, "demand.jsonl"), [post("p-1", ago(40)), post("p-2", ago(1), { price: 9500 })].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const listing = { id: "1", title: "Test flat, Westmoorings", listingType: "rent", area: "Westmoorings", price: 8800, currency: "TTD", beds: 2, baths: 1, agentId: 7, status: "active", url: "" };
  const seam = { connected: true, async listings() { return { status: "ok" as const, listings: [listing as Listing] }; }, async agents() { return []; } };
  const view = await loadAutomatch({ root, seam, areas: AREAS, now: NOW });
  assert.equal(view.pairs.length, 1, "one row for the sender's asks on the listing");
  assert.equal(view.pairs[0].posts, 2, "the posts add up");
  assert.deepEqual(view.dedupe.strong, { before: 2, after: 1 });
  assert.equal(view.strong, 1);
});

function askFactsForTest(a: AutomatchAsk): AskFacts {
  return { area: a.area, development: null, beds: a.beds, price: a.budget, currency: a.currency, type: a.type, listingType: a.listingType };
}
