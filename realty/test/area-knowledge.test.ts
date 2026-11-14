import assert from "node:assert/strict";
import test from "node:test";
import { haversineKm, minutesFromKm, nearbyByKnowledge, nearbyReason, neighboursByDistance, type AreaKnowledge, type AreaKnowledgeIndex } from "../flow/area-knowledge.ts";
import { matchOurListings, type LiveRequest } from "../flow/live-match.ts";
import { veryStrongOurListings } from "../flow/observe.ts";
import { ExactAreaFallback } from "../flow/areas.ts";
import type { Listing } from "../flow/source.ts";

function place(name: string, lat: number, lon: number, kind: AreaKnowledge["kind"] = "area", parent: string | null = null): AreaKnowledge {
  return { name, kind, parent, coords: { lat, lon }, neighbours: [], pois: [], source: "test" };
}

const INDEX: AreaKnowledgeIndex = {
  source: "test",
  builtAt: "2026-11-14T14:21:00.000Z",
  places: [
    place("West Hills", 10.68, -61.55, "development", "Petit Valley"),
    place("Glencoe", 10.67, -61.54),
    place("Petit Valley", 10.69, -61.55),
    place("Arima", 10.64, -61.28),
  ],
};

test("haversine and drive-time neighbours are computed, not hand-picked", () => {
  const km = haversineKm({ lat: 10.68, lon: -61.55 }, { lat: 10.67, lon: -61.54 });
  assert.ok(km > 1 && km < 3, `expected ~2 km, got ${km}`);
  assert.equal(minutesFromKm(2.9), 5);
  const near = neighboursByDistance(INDEX, "West Hills", 8, 6);
  assert.deepEqual(near.map((n) => n.name), ["Petit Valley", "Glencoe"]);
  assert.equal(nearbyByKnowledge(INDEX, "West Hills", "Arima"), null, "Arima is too far");
});

test("nearby reason is short and plain", () => {
  assert.equal(nearbyReason("Glencoe", "West Hills", { name: "Glencoe", km: 2.9, minutes: 5 }, true), "Glencoe, about 5 min from West Hills, in budget");
});

const RENT: LiveRequest = { intent: "rent", area: "West Hills", beds: 3, propertyType: "apartment", priceMin: 7500, priceMax: 7500, currency: "TTD", monthly: true };

function listing(p: Partial<Listing> & { id: string; area: string }): Listing {
  return {
    id: p.id,
    title: p.title ?? p.id,
    url: p.url ?? `https://1on1realtors.com/property/${p.id}`,
    area: p.area,
    price: p.price ?? 8500,
    currency: p.currency ?? "TTD",
    beds: p.beds ?? 3,
    baths: p.baths ?? 2,
    listingType: p.listingType ?? "rent",
    status: "active",
    agentId: 1,
  };
}

test("nearby matching uses knowledge distance, and Glencoe can be a recommendation but not a very-strong alert", async () => {
  const listings = [
    listing({ id: "wh", title: "WEST HILLS 3BR", area: "West Hills", price: 8000 }),
    listing({ id: "gl", title: "NEWBURY HILL EXTENSION", area: "Glencoe", price: 8500 }),
    listing({ id: "ar", title: "ARIMA HOUSE", area: "Arima", price: 8000 }),
  ];
  const got = await matchOurListings(RENT, listings, new ExactAreaFallback(), 5, INDEX);
  assert.deepEqual(got.map((m) => m.area), ["West Hills", "Glencoe"]);
  const gl = got.find((m) => m.area === "Glencoe");
  assert.match(gl?.reason ?? "", /^Glencoe, about \d+ min from West Hills, in budget$/);
  const strong = veryStrongOurListings(RENT, listings);
  assert.deepEqual(strong.map((m) => m.area), ["West Hills"]);
});
