import { join } from "node:path";
import { gazetteerPlaces } from "../extract.ts";
import { haversineKm, minutesFromKm, neighboursByDistance, KNOWLEDGE_SOURCE, type AreaKnowledge, type AreaKnowledgeIndex, type Coords, type KnowledgePoi } from "../flow/area-knowledge.ts";
import { knowledgePath, saveAreaKnowledge } from "../node/area-knowledge-store.ts";

/**
 * Build area knowledge from free OpenStreetMap data. Usage:
 *   node --experimental-strip-types realty/cli/area-knowledge-build.ts --out .data/realty/area-knowledge.json
 * Nominatim geocoding at most one request per 1.1s, Overpass for POIs. Never sends to users.
 * Cite: OpenStreetMap Nominatim and Overpass API.
 */

const UA = "Bops1on1Realtors/observation (https://bop.1on1realtors.com; area knowledge; no user-facing sends)";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const EXTRA = ["Palmiste", "Aranguez", "Kelly Village", "La Brea", "Fyzabad"];
const QUERY_HINTS: Record<string, string> = {
  "Petit Valley": "Petit Valley, Diego Martin, Trinidad and Tobago",
  "Palmiste": "Palmiste, San Fernando, Trinidad and Tobago",
  "Cocorite": "Cocorite, Diego Martin, Trinidad and Tobago",
};
const PARENT_FALLBACK: Record<string, string> = {
  "Victoria Keyes": "Westmoorings",
  "Goodwood Heights": "Goodwood Park",
};
const PREFER = new Set(["administrative", "suburb", "neighbourhood", "quarter", "city", "town", "village", "hamlet", "residential", "municipality", "locality", "borough", "apartment", "apartments", "housing"]);
const AVOID = new Set(["bus_stop", "peak", "wood", "river", "stream", "bay", "island", "islet", "waterfall", "cliff"]);
const PROXY = new Set(["school", "clinic", "hospital", "community_centre", "place_of_worship"]);
const NAMED_POIS: { kind: KnowledgePoi["kind"]; name: string; query: string }[] = [
  { kind: "school", name: "International School of Port of Spain", query: "International School of Port of Spain, Westmoorings, Trinidad and Tobago" },
  { kind: "school", name: "Petit Valley Girls RC School", query: "Petit Valley Girls RC School, Morne Coco Road, Trinidad and Tobago" },
  { kind: "school", name: "St. Mary's College", query: "St. Mary's College, Port of Spain, Trinidad and Tobago" },
  { kind: "school", name: "Queen's Royal College", query: "Queen's Royal College, Port of Spain, Trinidad and Tobago" },
  { kind: "mall", name: "Westmall", query: "Westmall, Westmoorings, Trinidad and Tobago" },
  { kind: "mall", name: "Long Circular Mall", query: "Long Circular Mall, Trinidad and Tobago" },
  { kind: "mall", name: "MovieTowne", query: "MovieTowne, Invaders Bay, Trinidad and Tobago" },
  { kind: "mall", name: "Trincity Mall", query: "Trincity Mall, Trinidad and Tobago" },
  { kind: "mall", name: "Gulf City Mall", query: "Gulf City Mall, La Romaine, Trinidad and Tobago" },
  { kind: "mall", name: "Price Plaza", query: "Price Plaza, Chaguanas, Trinidad and Tobago" },
  { kind: "supermarket", name: "Massy Stores Westmall", query: "Massy Stores, Westmall, Trinidad and Tobago" },
  { kind: "supermarket", name: "PriceSmart", query: "PriceSmart, Trinidad and Tobago" },
  { kind: "highway", name: "Audrey Jeffers Highway", query: "Audrey Jeffers Highway, Trinidad and Tobago" },
  { kind: "highway", name: "Western Main Road", query: "Western Main Road, Diego Martin, Trinidad and Tobago" },
  { kind: "highway", name: "Churchill Roosevelt Highway", query: "Churchill Roosevelt Highway, Trinidad and Tobago" },
  { kind: "highway", name: "Uriah Butler Highway", query: "Uriah Butler Highway, Trinidad and Tobago" },
  { kind: "highway", name: "Solomon Hochoy Highway", query: "Solomon Hochoy Highway, Trinidad and Tobago" },
  { kind: "hospital", name: "Port of Spain General Hospital", query: "Port of Spain General Hospital, Trinidad and Tobago" },
  { kind: "hospital", name: "West Shore Medical", query: "West Shore Medical, Cocorite, Trinidad and Tobago" },
  { kind: "hospital", name: "St. James Medical Complex", query: "St. James Medical Complex, Trinidad and Tobago" },
  { kind: "hospital", name: "Eric Williams Medical Sciences Complex", query: "Eric Williams Medical Sciences Complex, Mount Hope, Trinidad and Tobago" },
  { kind: "hospital", name: "San Fernando General Hospital", query: "San Fernando General Hospital, Trinidad and Tobago" },
  { kind: "airport", name: "Piarco International Airport", query: "Piarco International Airport, Trinidad and Tobago" },
  { kind: "airport", name: "A.N.R. Robinson International Airport", query: "A.N.R. Robinson International Airport, Crown Point, Tobago" },
];

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type NominatimHit = { lat?: string; lon?: string; type?: string; category?: string; class?: string; display_name?: string };

function classOf(h: NominatimHit): string {
  return (h.type || h.category || h.class || "").toLowerCase();
}

function pickHit(hits: NominatimHit[]): NominatimHit | null {
  if (!hits.length) return null;
  const preferred = hits.filter((h) => PREFER.has(classOf(h)));
  if (preferred[0]) return preferred[0];
  const proxy = hits.filter((h) => PROXY.has(classOf(h)));
  if (proxy[0]) return proxy[0];
  const ok = hits.filter((h) => !AVOID.has(classOf(h)));
  return ok[0] ?? hits[0];
}

function coordsOf(hit: NominatimHit | null): Coords | null {
  const lat = hit?.lat ? Number(hit.lat) : NaN;
  const lon = hit?.lon ? Number(hit.lon) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

async function nominatim(q: string): Promise<NominatimHit[]> {
  const url = `${NOMINATIM}?format=jsonv2&limit=5&countrycodes=tt&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return [];
  const j = (await r.json()) as NominatimHit[];
  return Array.isArray(j) ? j : [];
}

async function geocode(name: string): Promise<Coords | null> {
  const q = QUERY_HINTS[name] ?? `${name}, Trinidad and Tobago`;
  const hit = pickHit(await nominatim(q));
  return coordsOf(hit);
}

async function geocodePois(): Promise<RawPoi[]> {
  const out: RawPoi[] = [];
  for (const p of NAMED_POIS) {
    const coords = coordsOf(pickHit(await nominatim(p.query)));
    await sleep(1100);
    if (coords) out.push({ kind: p.kind, name: p.name, coords });
  }
  return out;
}

type RawPoi = { kind: KnowledgePoi["kind"]; name: string; coords: Coords };

async function fetchPois(): Promise<RawPoi[]> {
  const q = `
[out:json][timeout:90];
(
  node["amenity"="school"](10.0,-61.95,11.4,-60.45);
  node["amenity"="hospital"](10.0,-61.95,11.4,-60.45);
  node["shop"="supermarket"](10.0,-61.95,11.4,-60.45);
  node["shop"="mall"](10.0,-61.95,11.4,-60.45);
  nwr["name"~"Westmall|West Mall|Gulf City|Price Plaza|Trincity Mall",i](10.0,-61.95,11.4,-60.45);
  node["aeroway"="aerodrome"](10.0,-61.95,11.4,-60.45);
  way["highway"~"^(motorway|trunk)$"](10.0,-61.95,11.4,-60.45);
);
out center tags;
`.trim();
  const r = await fetch(OVERPASS, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(q)}`,
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { elements?: { type: string; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] };
  const out: RawPoi[] = [];
  for (const el of j.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const tags = el.tags ?? {};
    const name = tags.name || tags.ref || "";
    if (!name) continue;
    let kind: KnowledgePoi["kind"] | null = null;
    if (tags.amenity === "school") kind = "school";
    else if (tags.amenity === "hospital") kind = "hospital";
    else if (tags.shop === "supermarket") kind = "supermarket";
    else if (tags.shop === "mall" || /mall/i.test(name)) kind = "mall";
    else if (tags.aeroway === "aerodrome") kind = "airport";
    else if (tags.highway === "motorway" || tags.highway === "trunk") kind = "highway";
    if (!kind) continue;
    out.push({ kind, name, coords: { lat, lon } });
  }
  return out;
}

function nearestPois(here: Coords, pois: RawPoi[]): KnowledgePoi[] {
  const best = new Map<KnowledgePoi["kind"], KnowledgePoi>();
  const maxKm: Record<KnowledgePoi["kind"], number> = { school: 8, mall: 12, supermarket: 8, highway: 8, hospital: 15, airport: 45 };
  for (const p of pois) {
    const km = Math.round(haversineKm(here, p.coords) * 10) / 10;
    if (km > maxKm[p.kind]) continue;
    const prev = best.get(p.kind);
    if (!prev || km < prev.km) best.set(p.kind, { kind: p.kind, name: p.name, km });
  }
  return [...best.values()].sort((a, b) => a.km - b.km);
}

const outPath = arg("out", join(process.cwd(), ".data", "realty", "area-knowledge.json"));
const places = gazetteerPlaces();
for (const name of EXTRA) {
  if (!places.some((p) => p.name.toLowerCase() === name.toLowerCase())) places.push({ name, kind: "area", parent: null });
}

const built: AreaKnowledge[] = [];
let geocoded = 0;
let missed: string[] = [];
for (const p of places) {
  const coords = await geocode(p.name);
  await sleep(1100);
  if (coords) geocoded += 1;
  else missed.push(p.name);
  built.push({ name: p.name, kind: p.kind, parent: p.parent, coords, neighbours: [], pois: [], source: "OpenStreetMap Nominatim" });
  if ((geocoded + missed.length) % 10 === 0) console.error(`geocoded ${geocoded}/${places.length}`);
}

for (const p of built) {
  if (p.coords) continue;
  const parent = PARENT_FALLBACK[p.name] ?? p.parent;
  const from = built.find((x) => x.name === parent && x.coords);
  if (from?.coords) {
    p.coords = { ...from.coords };
    p.source = `OpenStreetMap Nominatim (parent fallback: ${from.name}; no OSM point for ${p.name})`;
    geocoded += 1;
    missed = missed.filter((n) => n !== p.name);
  }
}

let pois: RawPoi[] = [];
try {
  pois = await geocodePois();
} catch {
  pois = [];
}

const index: AreaKnowledgeIndex = { source: KNOWLEDGE_SOURCE, builtAt: new Date().toISOString(), places: built };
for (const p of built) {
  p.neighbours = neighboursByDistance(index, p.name);
  if (p.coords) p.pois = nearestPois(p.coords, pois);
}
// minutes already set from km; leave as estimated
for (const p of built) {
  for (const n of p.neighbours) n.minutes = minutesFromKm(n.km);
}

saveAreaKnowledge(knowledgePath(outPath), { ...index, places: built });
console.log(JSON.stringify({
  out: knowledgePath(outPath),
  source: KNOWLEDGE_SOURCE,
  places: built.length,
  withCoords: built.filter((p) => p.coords).length,
  missed,
  poisIndexed: pois.length,
  sample: built.find((p) => p.name === "West Hills") ?? built.find((p) => p.coords) ?? null,
}, null, 2));
