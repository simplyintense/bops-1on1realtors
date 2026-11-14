import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setOf, unknownPlaceHints, isVeryStrongPlace, veryStrongOurListings, foldPrice, priceKey } from "../flow/observe.ts";
import type { LiveRequest } from "../flow/live-match.ts";
import type { Listing } from "../flow/source.ts";
import { interpret } from "../flow/periskope.ts";
import { postRecordOf } from "../flow/periskope.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";

const listing = (over: Partial<Listing>): Listing => ({
  id: "1",
  title: "A listing",
  listingType: "rent",
  area: "Westmoorings",
  price: 18000,
  currency: "TTD",
  beds: 3,
  baths: 2,
  agentId: 7,
  status: "active",
  url: "https://1on1realtors.com/property/x",
  ...over,
});

test("setOf splits supply from demand, and leaves chatter out", () => {
  assert.equal(setOf("listing_for_sale"), "supply");
  assert.equal(setOf("listing_for_rent"), "supply");
  assert.equal(setOf("cobroke"), "supply");
  assert.equal(setOf("buyer_request"), "demand");
  assert.equal(setOf("rental_request"), "demand");
  assert.equal(setOf("other"), null);
});

test("a very strong match is the same development or area, exact beds, in-band price; a neighbour is not enough", () => {
  const req: LiveRequest = { intent: "rent", area: "La Fontaine", beds: 3, propertyType: "apartment", priceMin: null, priceMax: 20_000, currency: "TTD", monthly: true };
  const listings = [
    listing({ id: "lf", title: "La Fontaine, Columbus Circle", area: "Westmoorings", price: 18_000, beds: 3 }),
    listing({ id: "wm", title: "Westmoorings 2-bed apartment", area: "Westmoorings", price: 17_000, beds: 2 }),
    listing({ id: "vk", title: "Victoria Keyes, Diego Martin", area: "Diego Martin", price: 18_000, beds: 3 }),
    listing({ id: "beds", title: "La Fontaine 2 bed", area: "Westmoorings", price: 18_000, beds: 2 }),
    listing({ id: "dear", title: "La Fontaine penthouse", area: "Westmoorings", price: 30_000, beds: 3 }),
    listing({ id: "usd", title: "La Riviera, Westmoorings", area: "Westmoorings", price: 7000, currency: "USD", beds: 3 }),
  ];
  assert.equal(isVeryStrongPlace("La Fontaine", listings[0]), true);
  assert.equal(isVeryStrongPlace("La Fontaine", listings[2]), false);
  const got = veryStrongOurListings(req, listings);
  assert.deepEqual(got.map((m) => m.title), ["La Fontaine, Columbus Circle"]);
  assert.match(got[0].reason ?? "", /very strong/);

  const hills: LiveRequest = { intent: "rent", area: "West Hills", beds: 3, propertyType: "apartment", priceMin: 7000, priceMax: 7500, currency: "TTD", monthly: true };
  const glencoe = listing({ id: "gl", title: "NEWBURY HILL EXTENSION, GLENCOE - FOR RENT", area: "Glencoe", price: 8500, beds: 3 });
  const parent = listing({ id: "pv", title: "Petit Valley 3-bed apartment", area: "Petit Valley", price: 8000, beds: 3 });
  const same = listing({ id: "wh", title: "West Hills building 10", area: "Petit Valley", price: 7500, beds: 3 });
  assert.deepEqual(veryStrongOurListings(hills, [glencoe, parent, same]).map((m) => m.title), ["West Hills building 10"]);
});

test("unknown place hints skip gazetteer names and record only a leftover place", () => {
  assert.deepEqual(unknownPlaceHints("Any La Fontaine units for rent up to $20,000."), []);
  assert.deepEqual(unknownPlaceHints("search for a 3 bedroom unit in Westhills"), []);
  assert.deepEqual(unknownPlaceHints("Client looking for a 2 bed in Palmiste, budget 1.2m"), ["Palmiste"]);
});

test("the store projects supply and demand sets, folds price ranges once, and records unknown places", () => {
  const root = mkdtempSync(join(tmpdir(), "observe-"));
  const store = new PeriskopeStore(root);
  const i = interpret("3 bed apartment at La Fontaine Westmoorings for rent TT$18,000 available");
  const post = postRecordOf({
    message: { messageId: "m1", chatId: "120363139007270954@g.us", sender: "18685550111@c.us", senderName: "Dana", chatName: "R. E. SEARCHES ONLY", body: "3 bed apartment at La Fontaine Westmoorings for rent TT$18,000 available", hasText: true, textOnly: true, fromMe: false, mediaUrls: [], sentAt: null },
    phone: "+18685550111",
    interpretation: i,
    sentAt: "2026-11-14T14:00:00.000Z",
  });
  assert.equal(post.set, "supply");
  assert.equal(post.development, "La Fontaine");
  assert.equal(store.upsertPost(post), "added");
  assert.equal(store.supply().length, 1);
  assert.equal(store.demand().length, 0);
  assert.equal(store.priceRanges().length, 1);
  assert.equal(store.priceRanges()[0].min, 18000);
  assert.equal(store.priceRanges()[0].area, "La Fontaine");
  assert.equal(store.upsertPost(post), "unchanged");
  assert.equal(store.priceRanges()[0].count, 1, "a second pass does not double-count the range");

  const demand = postRecordOf({
    message: { messageId: "m2", chatId: "120363139007270954@g.us", sender: "18685550112@c.us", senderName: "Lee", chatName: "R. E. SEARCHES ONLY", body: "search for a 2 bed apartment in Palmiste, budget $7000 for rent", hasText: true, textOnly: true, fromMe: false, mediaUrls: [], sentAt: null },
    phone: "+18685550112",
    interpretation: interpret("search for a 2 bed apartment in Palmiste, budget $7000 for rent"),
    sentAt: "2026-11-14T14:05:00.000Z",
  });
  assert.equal(demand.set, "demand");
  assert.equal(demand.area, null);
  assert.equal(store.upsertPost(demand), "added");
  assert.equal(store.demand().length, 1);
  assert.deepEqual(store.unknownPlaces().map((u) => u.name), ["Palmiste"]);
  assert.equal(priceKey(store.priceRanges()[0]).includes("supply"), true);
  assert.equal(foldPrice(null, 10, "t", { area: "X", development: null, beds: 1, listingType: "rent", currency: "TTD", side: "supply" }).count, 1);
});
