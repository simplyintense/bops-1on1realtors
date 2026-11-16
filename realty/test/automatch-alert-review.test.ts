import assert from "node:assert/strict";
import { test } from "node:test";
import { FIRST_REVIEW_SEEDS, resolveReviewSeeds, reviewFit, reviewKeysOf, type ReviewPair } from "../flow/automatch-alert-review.ts";

type Pair = ReviewPair<{ score: number }>;

const pair = (over: { url: string; postId: string; area: string; listingType: "sale" | "rent"; budget: number | null; listingKey?: string; score?: number }): Pair => ({
  score: over.score ?? 70,
  listingKey: over.listingKey ?? `url:${over.url}`,
  listing: { url: over.url },
  ask: { postId: over.postId, area: over.area, listingType: over.listingType, budget: over.budget },
});

test("the first-review seed list has the 16 feedback matches", () => {
  assert.equal(FIRST_REVIEW_SEEDS.length, 16);
  assert.equal(new Set(FIRST_REVIEW_SEEDS.map((s) => `${s.listingUrl}|${s.askArea}|${s.listingType}|${s.budget ?? ""}`)).size, 16, "no duplicate seeds");
  const urls = FIRST_REVIEW_SEEDS.map((s) => s.listingUrl);
  assert.equal(urls.filter((u) => u.includes("valsayn-3bed-residential-for-sale-1397")).length, 2, "Camelot is two different buyers");
});

test("review seeds resolve by listing URL, area, budget and sale or rent, and a pair is used only once", () => {
  const camelot = "https://1on1realtors.com/property/valsayn-3bed-residential-for-sale-1397";
  const valsayn = pair({ url: camelot, postId: "aaaaaaaaaaaaaaaaaaaaaaaa", area: "Valsayn", listingType: "sale", budget: 2_950_000, score: 74 });
  const tunapuna = pair({ url: camelot, postId: "bbbbbbbbbbbbbbbbbbbbbbbb", area: "Tunapuna", listingType: "sale", budget: 3_500_000, score: 69 });
  const seeds = FIRST_REVIEW_SEEDS.filter((s) => s.listingUrl === camelot);
  assert.equal(seeds.length, 2);
  const resolved = resolveReviewSeeds([tunapuna, valsayn], seeds);
  assert.equal(resolved[0].pair?.ask.postId, "aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(resolved[1].pair?.ask.postId, "bbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(reviewKeysOf(resolved).size, 2);
  assert.ok(reviewFit(seeds[0], valsayn) > reviewFit(seeds[0], tunapuna));
});

test("two listings sharing one budget-less rent ask resolve to two distinct pairs, per listing", () => {
  const westA = "https://1on1realtors.com/property/westmoorings-3bed-residential-for-rent-1358";
  const westB = "https://1on1realtors.com/property/westmoorings-3bed-residential-for-rent-1059";
  const sfA = "https://1on1realtors.com/property/san-fernando-3bed-residential-for-rent-1287";
  const sfB = "https://1on1realtors.com/property/san-fernando-3bed-residential-for-rent-1350";
  const westAsk = "cccccccccccccccccccccccc";
  const sfAsk = "dddddddddddddddddddddddd";
  const seeds = FIRST_REVIEW_SEEDS.slice(-4);
  assert.deepEqual(seeds.map((s) => s.listingUrl), [westA, westB, sfA, sfB]);
  assert.ok(seeds.every((s) => s.budget == null), "these four asks have no budget");

  // Same ask (postId) for each area, different listing per pair; supplied out of seed order.
  const pairs = [
    pair({ url: sfB, postId: sfAsk, area: "San Fernando", listingType: "rent", budget: null, score: 71 }),
    pair({ url: westB, postId: westAsk, area: "Westmoorings", listingType: "rent", budget: null, score: 72 }),
    pair({ url: sfA, postId: sfAsk, area: "San Fernando", listingType: "rent", budget: null, score: 73 }),
    pair({ url: westA, postId: westAsk, area: "Westmoorings", listingType: "rent", budget: null, score: 74 }),
  ];
  const resolved = resolveReviewSeeds(pairs, seeds);
  assert.ok(resolved.every((r) => r.pair !== null), "each seed resolves");
  assert.deepEqual(resolved.map((r) => r.pair?.listing.url), [westA, westB, sfA, sfB]);
  assert.equal(reviewKeysOf(resolved).size, 4, "four distinct request-and-listing keys");
  // With no budget on the ask, reviewFit scores listing (1) + sale/rent (4) + area (4) only.
  assert.equal(reviewFit(seeds[0], pairs[3]), 9);
});

test("a missing listing or a pair without a request id is left unresolved", () => {
  const url = "https://1on1realtors.com/property/missing";
  const seed = { listingUrl: url, askArea: "Maraval", listingType: "sale" as const, budget: 1 };
  assert.deepEqual(resolveReviewSeeds([], [seed]), [{ seed, pair: null }]);
  const noId = pair({ url, postId: "", area: "Maraval", listingType: "sale", budget: 1 });
  (noId.ask as { postId: string | null }).postId = null;
  assert.equal(resolveReviewSeeds([noId], [seed])[0].pair, null);
});
