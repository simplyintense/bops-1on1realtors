import type { AreaKnowledge, AreaKnowledgeIndex, Coords } from "./area-knowledge.ts";

/**
 * Taught nearby areas: the owner's map research (realty/data/area-nearby-ai-maps.json, taught_by "ai-maps"), kept in the search
 * store's area tables and read here by the matcher. Once both places are taught, the taught pair decides who is nearby, and it
 * overrides the gazetteer's neighbours, the 8 km crow-fly rule and the market resolver's neighbour lists. A place that isn't
 * taught leaves the other rules in charge, as before. Portable: no node:*, no next, no bare process.
 */

export type TaughtPlace = { name: string; market: string | null; lat: number | null; lon: number | null; note: string | null };
export type TaughtAlias = { alias: string; canonical: string };
/** One unordered pair of places. `nearby` is the rule's answer: same market and at most 15 min by road. Pairs not listed are not nearby. */
export type TaughtRelation = { a: string; b: string; nearby: boolean; minutes: number | null; km: number | null; note: string | null };
export type TaughtAreas = { places: TaughtPlace[]; aliases: TaughtAlias[]; relations: TaughtRelation[] };

/** What the taught data says about two areas: the same place, a taught neighbour (with its drive), or taught as not nearby. */
export type TaughtVerdict = { tier: "same" } | { tier: "nearby"; minutes: number | null; km: number | null } | { tier: "apart" };

/** A teaching file as parsed (realty/data/area-nearby-ai-maps.json): places, aliases and pairs, each with its note. */
export type AreaTeachFile = { source: string; places: TaughtPlace[]; aliases: TaughtAlias[]; relations: TaughtRelation[] };

/** Case, accents, apostrophes and punctuation ignored: "St. James", "St James" and "st  james" are one key; "St Ann's" is "st anns". */
export function placeKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

type Index = { known: Set<string>; alias: Map<string, string>; pairs: Map<string, TaughtRelation> };
const indexes = new WeakMap<TaughtAreas, Index>();

function indexOf(t: TaughtAreas): Index {
  let ix = indexes.get(t);
  if (!ix) {
    ix = {
      known: new Set(t.places.map((p) => placeKey(p.name))),
      alias: new Map(t.aliases.map((a) => [placeKey(a.alias), placeKey(a.canonical)] as const)),
      pairs: new Map(t.relations.map((r) => [pairKey(placeKey(r.a), placeKey(r.b)), r] as const)),
    };
    indexes.set(t, ix);
  }
  return ix;
}

/** The place's key when it is a taught place (through an alias if need be), else null. */
function taughtKey(ix: Index, name: string): string | null {
  const k = placeKey(name);
  const c = ix.alias.get(k) ?? k;
  return ix.known.has(c) ? c : null;
}

/**
 * What the taught data says about two areas. Null when either area isn't taught (the other rules decide, as before). Same name
 * is the same area. Otherwise the taught pair: listed nearby is a neighbour, anything else (listed or not) is apart.
 */
export function taughtVerdict(t: TaughtAreas | null | undefined, a: string | null | undefined, b: string | null | undefined): TaughtVerdict | null {
  if (!t || !a || !b) return null;
  const ix = indexOf(t);
  const ka = taughtKey(ix, a);
  const kb = taughtKey(ix, b);
  if (!ka || !kb) return null;
  if (ka === kb) return { tier: "same" };
  const r = ix.pairs.get(pairKey(ka, kb));
  return r?.nearby ? { tier: "nearby", minutes: r.minutes, km: r.km } : { tier: "apart" };
}

/** "Nearby (Woodbrook, ~3 min drive)": the reason a taught neighbour shows. Without minutes, just the name. */
export function nearbyDriveLabel(name: string, minutes: number | null | undefined): string {
  return minutes != null ? `Nearby (${name}, ~${Math.round(minutes)} min drive)` : `Nearby (${name})`;
}

/**
 * The index the matcher reads: the area knowledge with each taught place's coordinates in place of the snapshot's (Long Circular
 * and Bayshore were geocoded to the south in the snapshot), and the taught areas on it. Null when nothing is taught and there is
 * no knowledge file.
 */
export function withTaught(index: AreaKnowledgeIndex | null, taught: TaughtAreas | null): AreaKnowledgeIndex | null {
  if (!taught || (!taught.places.length && !taught.relations.length)) return index;
  const base: AreaKnowledgeIndex = index ?? { source: "taught areas", builtAt: "", places: [] };
  const places: AreaKnowledge[] = [...base.places];
  for (const p of taught.places) {
    if (p.lat == null || p.lon == null) continue;
    const coords: Coords = { lat: p.lat, lon: p.lon };
    const i = places.findIndex((x) => placeKey(x.name) === placeKey(p.name));
    if (i >= 0) places[i] = { ...places[i], coords };
    else places.push({ name: p.name, kind: "area", parent: null, coords, neighbours: [], pois: [], source: p.note ?? "taught" });
  }
  return { ...base, places, taught };
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} must be a name`);
  return v.trim();
};
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Parses a teaching file (the JSON shape of area-nearby-ai-maps.json). Throws a plain Error on a shape it can't use. Aliases are
 * resolved in the pairs, and each pair's two names are put in key order, so one pair is one row however it was written.
 */
export function parseAreaTeachFile(json: unknown): AreaTeachFile {
  const j = json as Record<string, unknown> | null;
  if (!j || typeof j !== "object") throw new Error("The teaching file must be a JSON object.");
  const source = typeof j.source === "string" ? j.source : "";
  const markets = (j.markets ?? {}) as Record<string, unknown>;
  const coords = (j.coords ?? {}) as Record<string, { lat?: unknown; lon?: unknown }>;
  const coordNotes = (j.coordNotes ?? {}) as Record<string, unknown>;
  const aliasMap = (j.aliases ?? {}) as Record<string, unknown>;
  if (typeof markets !== "object" || typeof coords !== "object") throw new Error("markets and coords must be objects.");
  if (!Array.isArray(j.pairs)) throw new Error("pairs must be a list.");

  const aliases: TaughtAlias[] = Object.entries(aliasMap).map(([alias, canonical]) => ({ alias: str(alias, "alias"), canonical: str(canonical, "alias target") }));
  const canon = new Map(aliases.map((a) => [placeKey(a.alias), a.canonical] as const));
  const named = (n: unknown) => {
    const s = str(n, "a place");
    return canon.get(placeKey(s)) ?? s;
  };

  const places = new Map<string, TaughtPlace>();
  for (const raw of new Set([...Object.keys(markets), ...Object.keys(coords)])) {
    const name = named(raw);
    const market = markets[raw];
    const c = coords[raw];
    const cNote = coordNotes[raw];
    const note = [source, typeof cNote === "string" ? cNote : ""].filter(Boolean).join(" · ");
    const prev = places.get(name);
    places.set(name, {
      name,
      market: typeof market === "string" ? market : (prev?.market ?? null),
      lat: numOrNull(c?.lat) ?? prev?.lat ?? null,
      lon: numOrNull(c?.lon) ?? prev?.lon ?? null,
      note: note || prev?.note || null,
    });
  }

  const relations: TaughtRelation[] = j.pairs.map((p: unknown, i: number) => {
    const r = p as Record<string, unknown>;
    if (!r || typeof r !== "object" || typeof r.nearby !== "boolean") throw new Error(`pair ${i + 1} needs a nearby flag`);
    const x = named(r.a);
    const y = named(r.b);
    const [a, b] = placeKey(x) <= placeKey(y) ? [x, y] : [y, x];
    const why = typeof r.why === "string" ? r.why : "";
    return { a, b, nearby: r.nearby, minutes: numOrNull(r.minutes), km: numOrNull(r.km), note: [source, why].filter(Boolean).join(" — ") || null };
  });
  return { source, places: [...places.values()], aliases, relations };
}
