import assert from "node:assert/strict";
import test from "node:test";
import { haversineKm, islandOfPlace, minutesFromKm, nearbyByKnowledge, nearbyReason, neighboursByDistance, regionOfPlace, type AreaKnowledge, type AreaKnowledgeIndex } from "../flow/area-knowledge.ts";
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

/* Invented places. Trinidad coordinates are south of 10.95°N, Tobago's north of it. 0.05° of latitude is about 5.5 km. */
const ISLANDS: AreaKnowledgeIndex = {
  source: "test",
  builtAt: "",
  places: [
    place("Invented Heights", 10.66, -61.52),
    place("Invented Park", 10.71, -61.52),
    place("Invented Bay", 11.2, -60.6),
    place("Invented Cove", 11.25, -60.6),
    place("Goodwood Gardens", 11.21, -60.62),
    place("Goodwood", 11.2, -60.61),
  ],
};

test("nearby by coordinates: two places 5–7 km apart on the same island are nearby, in Trinidad or in Tobago", () => {
  const trinidad = nearbyByKnowledge(ISLANDS, "Invented Heights", "Invented Park");
  assert.ok(trinidad && trinidad.km > 5 && trinidad.km < 7, `km ${trinidad?.km}`);
  assert.equal(nearbyByKnowledge(ISLANDS, "Invented Bay", "Invented Cove")?.name, "Invented Cove");
});

test("nearby by coordinates never crosses the sea: a Trinidad place and a Tobago place 4 km apart are not nearby, whatever the caller checked", () => {
  const taught = { places: [{ name: "Invented Cove", market: "Tobago", lat: null, lon: null, note: null }], aliases: [], relations: [] };
  const withTaught: AreaKnowledgeIndex = { source: "test", builtAt: "", places: [place("Invented Heights", 10.66, -61.52), place("Invented Cove", 10.7, -61.52)], taught };
  assert.equal(nearbyByKnowledge(withTaught, "Invented Heights", "Invented Cove"), null, "about 4 km, taught Tobago, Trinidad coordinates");
  const bySide: AreaKnowledgeIndex = { source: "test", builtAt: "", places: [place("Invented Point", 10.94, -61.52), place("Invented Ridge", 10.96, -61.52)] };
  assert.equal(nearbyByKnowledge(bySide, "Invented Point", "Invented Ridge"), null, "either side of the 10.95° line");
});

test("a Trinidad compound on Tobago coordinates is not the Tobago village next door: 'Goodwood Gardens' is Trinidad, 'Goodwood' is not", () => {
  assert.equal(islandOfPlace(ISLANDS, "Goodwood Gardens"), "Trinidad");
  assert.equal(islandOfPlace(ISLANDS, "Goodwood"), "Tobago");
  assert.equal(nearbyByKnowledge(ISLANDS, "Goodwood", "Goodwood Gardens"), null);
});

test("islandOfPlace reads local data in order: taught market, compound name, a name that spells the island, parent, then coordinates", () => {
  const taught = { places: [{ name: "Invented Heights", market: "Tobago", lat: null, lon: null, note: null }], aliases: [], relations: [] };
  assert.equal(islandOfPlace({ ...ISLANDS, taught }, "Invented Heights"), "Tobago", "the taught market wins over coordinates");
  assert.equal(islandOfPlace(ISLANDS, "West Tobago"), "Tobago", "the name spells it");
  assert.equal(islandOfPlace({ source: "t", builtAt: "", places: [place("Invented Hill", 10.7, -61.5, "area", "Tobago")] }, "Invented Hill"), "Tobago", "the parent region");
  assert.equal(islandOfPlace(null, "Invented Heights"), null, "no data, no island");
});

test("regionOfPlace: a taught market is the region, a parent region is one, and a place on Tobago is Tobago", () => {
  const taught = { places: [{ name: "Invented Heights", market: "Central", lat: null, lon: null, note: null }], aliases: [], relations: [] };
  assert.equal(regionOfPlace({ ...ISLANDS, taught }, "Invented Heights"), "Central");
  assert.equal(regionOfPlace({ source: "t", builtAt: "", places: [place("Invented Hill", 10.7, -61.5, "area", "Port of Spain")] }, "Invented Hill"), "Port of Spain");
  assert.equal(regionOfPlace(ISLANDS, "Invented Bay"), "Tobago");
  assert.equal(regionOfPlace(ISLANDS, "Invented Heights"), null, "Trinidad coordinates alone don't name a region");
});
