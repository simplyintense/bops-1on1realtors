/**
 * Area knowledge for recommendations: coordinates, parent, nearest neighbours by distance or
 * approximate drive time, and nearby points of interest. Built from OpenStreetMap Nominatim
 * (geocoding) and Overpass (POIs), cited in the store. Portable: no node:*, no network here.
 *
 * Nearby matching uses this when both sides have coordinates. Very strong CRM alerts stay
 * exact same development or area only (observe.ts); Glencoe is still not a West Hills alert
 * until Miles confirms.
 */

export const KNOWLEDGE_SOURCE = "OpenStreetMap Nominatim (https://nominatim.openstreetmap.org) for coordinates and named points of interest (schools, malls and supermarkets, highways, hospitals, airports); drive times estimated at 35 km/h from great-circle distance unless an OSRM duration is stored.";

export type Coords = { lat: number; lon: number };

export type KnowledgePoi = {
  kind: "school" | "mall" | "supermarket" | "highway" | "hospital" | "airport";
  name: string;
  km: number;
};

export type KnowledgeNeighbour = {
  name: string;
  km: number;
  minutes: number;
};

export type AreaKnowledge = {
  name: string;
  kind: "area" | "development";
  parent: string | null;
  coords: Coords | null;
  neighbours: KnowledgeNeighbour[];
  pois: KnowledgePoi[];
  source: string;
};

export type AreaKnowledgeIndex = {
  source: string;
  builtAt: string;
  places: AreaKnowledge[];
};

export function knowledgeOf(index: AreaKnowledgeIndex | null | undefined, name: string | null | undefined): AreaKnowledge | null {
  if (!index || !name) return null;
  const k = keyOf(name);
  return index.places.find((p) => keyOf(p.name) === k) ?? null;
}

export function keyOf(name: string): string {
  return name.replace(/[–—]/g, "-").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: Coords, b: Coords): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Rough island driving time from a road distance, 35 km/h average unless a measured duration is given. */
export function minutesFromKm(km: number, osrmSeconds?: number | null): number {
  if (osrmSeconds != null && osrmSeconds > 0) return Math.max(1, Math.round(osrmSeconds / 60));
  return Math.max(1, Math.round((km / 35) * 60));
}

/** Places within maxKm, nearest first, excluding the place itself. */
export function neighboursByDistance(index: AreaKnowledgeIndex, name: string, maxKm = 8, limit = 6): KnowledgeNeighbour[] {
  const here = knowledgeOf(index, name);
  if (!here?.coords) return [];
  const out: KnowledgeNeighbour[] = [];
  for (const p of index.places) {
    if (!p.coords || keyOf(p.name) === keyOf(here.name)) continue;
    const km = Math.round(haversineKm(here.coords, p.coords) * 10) / 10;
    if (km <= maxKm) out.push({ name: p.name, km, minutes: minutesFromKm(km) });
  }
  out.sort((a, b) => a.km - b.km || a.minutes - b.minutes);
  return out.slice(0, limit);
}

export function nearbyByKnowledge(index: AreaKnowledgeIndex | null | undefined, requestArea: string, listingArea: string, maxKm = 8): KnowledgeNeighbour | null {
  if (!index) return null;
  const a = knowledgeOf(index, requestArea);
  const b = knowledgeOf(index, listingArea);
  if (!a?.coords || !b?.coords) return null;
  if (keyOf(a.name) === keyOf(b.name)) return null;
  const km = Math.round(haversineKm(a.coords, b.coords) * 10) / 10;
  if (km > maxKm) return null;
  return { name: b.name, km, minutes: minutesFromKm(km) };
}

/** Short reason for a nearby listing, e.g. "Glencoe, about 5 min from West Hills, in budget". */
export function nearbyReason(listingArea: string, requestArea: string, rel: KnowledgeNeighbour | null, inBudget: boolean): string {
  if (rel) return `${listingArea}, about ${rel.minutes} min from ${requestArea}${inBudget ? ", in budget" : ""}`;
  return inBudget ? `${listingArea}, near ${requestArea}, in budget` : `${listingArea}, near ${requestArea}`;
}
