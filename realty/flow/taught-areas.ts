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

/* ---------------- teaching from the desk (the Teach a place form) ---------------- */

/** The markets a taught place can sit in: the short names the teaching file uses. A place's market is its region for the matcher. */
export const TAUGHT_MARKETS = ["North West", "Port of Spain", "East–West Corridor", "Central", "South", "East", "Tobago"] as const;
export type TaughtMarket = (typeof TAUGHT_MARKETS)[number];

/** "North West" or "Trinidad North West" (case, dashes and spaces ignored): the short market name, else null. */
export function marketOf(raw: unknown): TaughtMarket | null {
  if (typeof raw !== "string") return null;
  const k = placeKey(raw).replace(/^trinidad /, "");
  return TAUGHT_MARKETS.find((m) => placeKey(m) === k) ?? null;
}

/** The label a form shows for a market: "Trinidad North West", "Tobago". */
export function marketLabel(m: TaughtMarket): string {
  return m === "Tobago" ? "Tobago" : `Trinidad ${m}`;
}

/** Tobago for the Tobago market, Trinidad for the other six, null when the market is unknown or absent. */
export function islandOfMarket(market: string | null | undefined): "Trinidad" | "Tobago" | null {
  const m = marketOf(market);
  return m == null ? null : m === "Tobago" ? "Tobago" : "Trinidad";
}

/** The taught place a name is (through an alias if need be), or null when it isn't taught. */
export function taughtPlaceOf(t: TaughtAreas | null | undefined, name: string | null | undefined): TaughtPlace | null {
  if (!t || !name) return null;
  const k = taughtKey(indexOf(t), name);
  return k ? (t.places.find((p) => placeKey(p.name) === k) ?? null) : null;
}

/** One place, its alias and its nearby / not-nearby pair from the Teach a place form. Shown back to the teacher as saved. */
export type PlaceTeach = { place: string; market: TaughtMarket; alias: string | null; pairs: { a: string; b: string; nearby: boolean }[] };

/**
 * The Teach a place form's body, checked and turned into a teaching file for SearchStore.teachAreas. A place needs a name and a
 * market. An alias is another name for the place. Coordinates come in pairs, and a place that isn't given them keeps its own. Each
 * pair (nearby, or not nearby) is one row, its partner named as taught (through an alias if it has one). A pair counts once both
 * places are taught. Returns { ok: false, error } on a bad field, never a throw.
 */
export function placeTeachOf(body: unknown, existing: TaughtAreas): { ok: true; file: AreaTeachFile; summary: PlaceTeach } | { ok: false; error: string } {
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send a JSON object.");
    const o = body as Record<string, unknown>;
    const text = (k: string, max: number): string | null => {
      const v = o[k];
      if (v == null) return null;
      if (typeof v !== "string") throw new Error(`${k} must be text.`);
      const s = v.replace(/\s+/g, " ").trim();
      if (s.length > max) throw new Error(`${k} is longer than ${max} characters.`);
      return s || null;
    };
    const name = text("name", 80);
    if (!name || name.length < 2) throw new Error("A place needs a name (2 to 80 characters).");
    const market = marketOf(o.market);
    if (!market) throw new Error(`Pick a market: ${TAUGHT_MARKETS.join(", ")}.`);
    const alias = text("alias", 80);
    if (alias && placeKey(alias) === placeKey(name)) throw new Error("The alias and the place need different names.");
    const note = text("note", 300);
    const lat: unknown = o.lat ?? null;
    const lon: unknown = o.lon ?? null;
    if ((lat == null) !== (lon == null)) throw new Error("Give both lat and lon, or neither.");
    const coords = lat == null ? null : { lat: lat as number, lon: lon as number };
    if (coords && (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)) {
      throw new Error("lat and lon must be real coordinates.");
    }

    // The alias resolves before the pairs are keyed, so a pair is stored under the place's own name.
    const canon = new Map([...existing.aliases, ...(alias ? [{ alias, canonical: name }] : [])].map((a) => [placeKey(a.alias), a.canonical] as const));
    const pairs = (
      [
        [text("nearby", 80), true],
        [text("notNearby", 80), false],
      ] as const
    ).flatMap(([partner, nearby]) => (partner ? [{ partner, nearby }] : []));
    const relations: TaughtRelation[] = pairs.map(({ partner, nearby }) => {
      const other = canon.get(placeKey(partner)) ?? partner;
      if (placeKey(other) === placeKey(name)) throw new Error("A pair needs two different places.");
      const [a, b] = placeKey(name) <= placeKey(other) ? [name, other] : [other, name];
      return { a, b, nearby, minutes: null, km: null, note: null };
    });

    const prev = existing.places.find((p) => placeKey(p.name) === placeKey(name));
    const place: TaughtPlace = {
      name,
      market,
      lat: coords?.lat ?? prev?.lat ?? null,
      lon: coords?.lon ?? prev?.lon ?? null,
      note: note ?? prev?.note ?? null,
    };
    const aliases: TaughtAlias[] = alias ? [{ alias, canonical: name }] : [];
    return {
      ok: true,
      file: { source: "teach page", places: [place], aliases, relations },
      summary: { place: name, market, alias: alias ?? null, pairs: relations.map((r) => ({ a: r.a, b: r.b, nearby: r.nearby })) },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
