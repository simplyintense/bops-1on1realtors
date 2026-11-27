import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyKnownTerms, parseListingType } from "../flow/knowledge.ts";
import { applyKindOverride, interpret, looksLikeEmptyListingAsk, postRecordOf, reparsePost } from "../flow/periskope.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { isVague, syncFromJsonl, withSearchStore } from "../node/search-store.ts";

const AGENT = "+18685550101";

function msg(body: string, id = "m-1") {
  return { messageId: id, chatId: "chat-a@g.us", sender: "18685550101@c.us", senderName: "Test Agent", chatName: "Test Group A", body, hasText: true, textOnly: true, fromMe: false, mediaUrls: [], sentAt: "2026-11-12T13:40:14.000Z" as string | null };
}

function stored(body: string, id = "m-1") {
  return postRecordOf({ message: msg(body, id), phone: AGENT, interpretation: interpret(body), sentAt: "2026-11-12T13:40:14.000Z" });
}

test("parseListingType: short-let aliases become shortlet; anything else is rejected", () => {
  assert.equal(parseListingType("short-let"), "shortlet");
  assert.equal(parseListingType("short let"), "shortlet");
  assert.equal(parseListingType("sale"), "sale");
  assert.equal(parseListingType("lease"), undefined);
  assert.equal(parseListingType(""), null);
});

test("a shortlet term may refine rent and is not overwritten by a later rent term", () => {
  const terms = [
    { term: "carnival rental", area: null, development: null, type: "carnival rental", listingType: "shortlet" },
    { term: "rental", area: null, development: null, type: null, listingType: "rent" },
  ];
  const out = applyKnownTerms({ area: null, development: null, type: null, listingType: "rent" }, "Looking for Carnival rental for one person", terms);
  assert.equal(out.listingType, "shortlet");
  assert.equal(out.type, "carnival rental");
});

test("bare savannah is Queen's Park Savannah, but Savannah Mews and Grand Savannah are left alone", () => {
  const terms = [
    { term: "savannah mews", area: "Belmont", development: "Savannah Mews", type: null, listingType: null },
    { term: "grand savannah", area: "Grand Savannah", development: null, type: null, listingType: null },
    { term: "savannah", area: "Queen's Park Savannah", development: null, type: null, listingType: null },
  ];
  assert.equal(applyKnownTerms({ area: null, development: null, type: null, listingType: null }, "Rental close to the Savannah, 1-2 bed", terms).area, "Queen's Park Savannah");
  assert.equal(applyKnownTerms({ area: null, development: null, type: null, listingType: null }, "Savannah Mews 2 bed for rent", terms).area, "Belmont");
  assert.equal(applyKnownTerms({ area: null, development: null, type: null, listingType: null }, "Grand Savannah townhouse", terms).area, "Grand Savannah");
  assert.equal(applyKnownTerms({ area: null, development: null, type: null, listingType: null }, "Land on Caroni savannah road / Charlieville down to Perseverance", terms).area, null);
  assert.equal(applyKnownTerms({ area: null, development: null, type: null, listingType: null }, "FOR SALE SAVANNAH VILLAS BUILDING 5", terms).area, null);
});

test("a kind override moves a misfiled listing to supply, and a reparse does not put it back", () => {
  const root = mkdtempSync(join(tmpdir(), "kind-over-"));
  const store = new PeriskopeStore(root);
  const body = "SPACIOUS 3-BEDROOM HOME IN HERMITAGE VILLAGE. INVESTORS SEEKING ROOM TO GROW. Price: $1,800,000 TTD";
  const post = stored(body, "hermitage-1");
  assert.equal(post.set, "demand", "the classifier reads SEEKING and files it as demand");
  store.reprojectObservation([post]);
  assert.equal(store.demand().length, 1);
  store.setKindOverride({ messageId: "hermitage-1", set: "supply", by: "cli", reason: "it is a listing" });
  store.reprojectObservation(store.posts().map((p) => reparsePost(p)));
  assert.deepEqual(store.supply().map((p) => p.messageId), ["hermitage-1"]);
  assert.equal(store.demand().length, 0);
  assert.equal(store.posts()[0].set, "supply");
  assert.equal(store.posts()[0].category, "listing_for_sale");
  store.clearKindOverride("hermitage-1");
  store.reprojectObservation(store.posts().map((p) => reparsePost(p)));
  assert.deepEqual(store.demand().map((p) => p.messageId), ["hermitage-1"], "clearing the override is reversible");
});

test("a buyer ask that says for sale reads as demand, and a staff supply override sticks after rebuild", () => {
  const root = mkdtempSync(join(tmpdir(), "kind-over-"));
  const store = new PeriskopeStore(root);
  const body = "Good Morning Any 2 bedroom Bayside Towers for sale.?";
  const post = stored(body, "bayside-1");
  post.area = "Cocorite";
  assert.equal(post.set, "demand", "'Any … for sale?' is a question about what is available, so it is an ask");
  store.reprojectObservation([post]);
  store.setKindOverride({ messageId: "bayside-1", set: "supply", area: "Cocorite", by: "cli", reason: "it is a listing" });
  store.reprojectObservation(store.posts().map((p) => reparsePost(p)));
  assert.deepEqual(store.supply().map((p) => p.messageId), ["bayside-1"]);
  assert.equal(store.demand().length, 0);
  const counts = syncFromJsonl(root, { force: true });
  assert.equal(counts.supply, 1);
  assert.equal(counts.demand, 0);
});

test("an ignored empty listing ask leaves the queue, and a parked no-area ask stays in demand as low priority", () => {
  const root = mkdtempSync(join(tmpdir(), "kind-over-"));
  const empty = stored("Does anyone have this house as a listing for sale?", "empty-1");
  const parked = stored("2 bed 2 bath unfurnished apt, gated, $5,000, parking for one", "parked-1");
  parked.set = "demand";
  parked.category = "rental_request";
  const store = new PeriskopeStore(root);
  store.reprojectObservation([empty, parked]);
  store.setKindOverride({ messageId: "empty-1", status: "ignored", by: "Miles", reason: "no details" });
  store.setKindOverride({ messageId: "parked-1", status: "parked", priority: "low", by: "Miles", reason: "no area" });
  store.reprojectObservation(store.posts());
  assert.equal(store.demand().some((p) => p.messageId === "empty-1"), false);
  const counts = syncFromJsonl(root, { force: true });
  const rows = withSearchStore(root, (s) => ({ vague: s.search({ kind: "vague", limit: 50 }).rows, demand: s.search({ kind: "demand", limit: 50 }).rows }));
  assert.equal(rows.vague.some((r) => r.messageIds.includes("empty-1")), false, "ignored items are not in the queue");
  const held = rows.demand.find((r) => r.messageIds.includes("parked-1"));
  assert.ok(held, "the parked ask stays in demand");
  assert.equal(held?.status, "parked");
  assert.equal(held?.priority, "low");
  assert.equal(looksLikeEmptyListingAsk(empty.originalText ?? "", {}), true);
  assert.equal(isVague({ area: null, development: null, price: 5000, type: "apartment", listingType: null }), false);
});

test("isVague: a shortlet tag is enough even with no place or price", () => {
  assert.equal(isVague({ area: null, development: null, price: null, type: "carnival rental", listingType: "shortlet" }), false);
  assert.equal(isVague({ area: null, development: null, price: null, type: "carnival rental" }), true);
});

test("applyKindOverride flips only the side and category, and is a no-op-safe copy", () => {
  const listing = applyKindOverride(stored("3 bed house in Maraval for sale $1,800,000", "x-1"), "supply");
  assert.equal(listing.set, "supply");
  const ask = applyKindOverride(stored("client looking for 2 bed in Maraval, budget 1.5m", "x-2"), "demand");
  assert.equal(ask.set, "demand");
  assert.equal(ask.category, "buyer_request");
});
