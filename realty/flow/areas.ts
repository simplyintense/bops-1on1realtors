/**
 * Geography for matching: which area names are the same place, which are neighbours, and which share a
 * region. Portable: no node:*, no next, no bare process. The place directory is Builder's (market-mcp's
 * resolve_area); this file holds no gazetteer of its own. Staff aliases are local (AliasTable) and go to
 * market-ingest, not here.
 *
 * Regions are the six strings in REGIONS. The island is the resolver's `island` ("Tobago" or "Trinidad"); only
 * when that's absent is it read from the region (region "Tobago" is Tobago, every other region is Trinidad).
 * A Tobago area never matches a Trinidad one, even when a neighbour list says it does (areaTier checks the
 * islands before anything else).
 *
 * Tiers, best first: same-area, neighbour, same-region. Anything else is excluded. A neighbour hit carries the
 * weight market-mcp gave that neighbour (0 when the list has only names), and the ranking sorts by it inside
 * the tier. A text the resolver doesn't map (resolve() is null) matches only identical text, so exact matching
 * still works when the directory is silent.
 *
 * Resolvers. Each has lookup(text) for the desk (the answer with suggestions and the original query) and
 * resolve(text) for matching (the canonical area, or null if empty, unmapped or low confidence):
 *   CompositeAreaResolver  production: local staff aliases first, then the market's resolve_area, then exact
 *                          text, which is used only when the market is down or unset. A working market's
 *                          "unmapped" answer stays unmapped.
 *   MarketAreaResolver     resolve_area on market-mcp, through a ToolCaller (MarketClient in market-search.ts).
 *   ExactAreaFallback      today's behaviour: case- and space-insensitive text, no region, no neighbours.
 *   MemoryAreaResolver     an in-memory place list, for tests.
 *   CachedAreaResolver     wraps any resolver and keeps the answers that came back (errors are not kept).
 *
 * market-mcp shapes (confirmed by Builder; see docs/1on1-realtors.md):
 *   resolve_area  args { text }
 *                 → { area, island, region, municipality, neighbours: [{ area, weight }], confidence: 0 to 1,
 *                     suggestions }
 *                 an unrecognised name: { area: null, unresolved: true, suggestions }
 */

export const REGIONS = ["Port of Spain", "North West", "East–West Corridor", "Central", "South", "Tobago"] as const;
export type Region = (typeof REGIONS)[number];
export type Island = "Trinidad" | "Tobago";

/** How well an inquiry area and a listing area fit. "any" is for an inquiry that names no area. */
export type MatchTier = "same-area" | "neighbour" | "same-region" | "any";
export const TIER_RANK: Record<MatchTier, number> = { "same-area": 0, neighbour: 1, "same-region": 2, any: 3 };

/** A numeric confidence below this is low, and low means unmapped. */
export const LOW_CONFIDENCE = 0.8;

/** A neighbouring area and the weight market-mcp gives it (0 when the list named it without one). */
export type Neighbour = { area: string; weight: number };

/** What matching uses: the canonical area, its region and island (either may be null) and its neighbours. */
export type AreaMatch = { canonical: string; region: Region | null; island: Island | null; neighbours: Neighbour[] };

/** What the desk uses: the answer for one query, with suggestions when the directory wasn't sure. */
export type AreaLookup = {
  /** The text asked about, as given. */
  query: string;
  /** True only for a mapping good enough to match on. */
  mapped: boolean;
  canonical: string | null;
  region: Region | null;
  island: Island | null;
  municipality: string | null;
  neighbours: Neighbour[];
  /** The confidence level the answer carried; null when there was no area to judge. */
  confidence: "high" | "low" | null;
  /** Other names the directory thinks may be meant (from an unmapped answer). */
  suggestions: string[];
  /** alias: a staff mapping. market: resolve_area. exact: text only. none: nothing to look up. */
  source: "alias" | "market" | "exact" | "none";
};

export interface AreaResolver {
  lookup(text: string): Promise<AreaLookup>;
  resolve(text: string): Promise<AreaMatch | null>;
}

/** Anything that can make one MCP tool call (MarketClient in market-search.ts; a fake in tests). */
export interface ToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** A local alias table: the canonical name staff mapped an alias to, or null. Checked before anything else. */
export interface AliasSource {
  canonicalFor(text: string): string | null;
}

/** Case, spacing and dash style don't matter: "East-West Corridor" and "east–west  corridor" are one key. */
export function areaKey(text: string): string {
  return text.replace(/[–—]/g, "-").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The exact region string for a name (any case), or null if it isn't one of the six. */
export function parseRegion(value: unknown): Region | null {
  if (typeof value !== "string") return null;
  const k = areaKey(value);
  return REGIONS.find((r) => areaKey(r) === k) ?? null;
}

/** "Tobago" for the Tobago region, "Trinidad" for the other five, null when there's no known region. */
export function islandOf(region: string | null | undefined): Island | null {
  const r = parseRegion(region);
  if (!r) return null;
  return r === "Tobago" ? "Tobago" : "Trinidad";
}

/** The island as market-mcp names it ("Tobago" or "Trinidad", any case), or null. */
export function parseIsland(value: unknown): Island | null {
  const k = typeof value === "string" ? areaKey(value) : "";
  return k === "tobago" ? "Tobago" : k === "trinidad" ? "Trinidad" : null;
}

export function blankLookup(query: string, over: Partial<AreaLookup> = {}): AreaLookup {
  return { query, mapped: false, canonical: null, region: null, island: null, municipality: null, neighbours: [], confidence: null, suggestions: [], source: "none", ...over };
}

/** The thin form matching uses: the canonical area, or null when it isn't mapped. */
export function matchOf(l: AreaLookup): AreaMatch | null {
  return l.mapped && l.canonical ? { canonical: l.canonical, region: l.region, island: l.island, neighbours: l.neighbours } : null;
}

/** One side of a tier check: the text (as entered or as in the CRM) and what the resolver made of it. */
export type AreaRef = { text: string; match: AreaMatch | null };

/** The tier, or "excluded", with the reason the agent sees. weight is set only for a neighbour hit. */
export type AreaVerdict = { tier: MatchTier | "excluded"; reason: string; weight?: number };

/** The weight a neighbour list gives an area (by key), or null when the list doesn't name it. */
function weightTo(list: Neighbour[], key: string): number | null {
  return list.find((n) => areaKey(n.area) === key)?.weight ?? null;
}

/**
 * How a listing's area fits the inquiry's. Order of checks:
 *  1. Islands: both known and different is excluded (listing first: "excluded: Tobago vs Trinidad").
 *  2. Same canonical area: "same area: Westmoorings".
 *  3. Neighbours, on one island only, either list (the higher weight when both name each other):
 *     "nearby: Glencoe for Westmoorings" (listing named first).
 *  4. Same region, on one island: "same region: North West".
 *  5. Unmapped on either side: identical text is the same area; anything else is excluded.
 */
export function areaTier(inquiry: AreaRef | null, listing: AreaRef): AreaVerdict {
  if (!inquiry) return { tier: "any", reason: "no area asked for" };
  const a = inquiry.match;
  const b = listing.match;
  if (a && b) {
    if (a.island && b.island && a.island !== b.island) return { tier: "excluded", reason: `excluded: ${b.island} vs ${a.island}` };
    const ka = areaKey(a.canonical);
    const kb = areaKey(b.canonical);
    if (ka === kb) return { tier: "same-area", reason: `same area: ${a.canonical}` };
    const sameIsland = a.island !== null && a.island === b.island;
    if (sameIsland) {
      const weights = [weightTo(b.neighbours, ka), weightTo(a.neighbours, kb)].filter((w): w is number => w !== null);
      if (weights.length) return { tier: "neighbour", reason: `nearby: ${b.canonical} for ${a.canonical}`, weight: Math.max(...weights) };
      if (a.region && a.region === b.region) return { tier: "same-region", reason: `same region: ${a.region}` };
    }
    return { tier: "excluded", reason: "excluded" };
  }
  if (areaKey(inquiry.text) === areaKey(listing.text)) return { tier: "same-area", reason: `same area: ${inquiry.text.trim()}` };
  return { tier: "excluded", reason: "excluded" };
}

/** Today's exact text, synchronously: no region, no island, no neighbours. Empty text has no match. */
export function exactRef(text: string): AreaRef {
  const canonical = text.trim().replace(/\s+/g, " ");
  return { text, match: areaKey(text) ? { canonical, region: null, island: null, neighbours: [] } : null };
}

async function safeResolve(resolver: AreaResolver, text: string): Promise<AreaMatch | null> {
  try {
    return await resolver.resolve(text);
  } catch {
    return null;
  }
}

/** The matching side for a text, through a resolver. A resolver that throws counts as unmapped. */
export async function refFor(resolver: AreaResolver, text: string): Promise<AreaRef> {
  return { text, match: await safeResolve(resolver, text) };
}

/**
 * The desk's lookups for a set of texts, once each (by areaKey). A text whose lookup throws is left out,
 * so the desk doesn't flag what it couldn't check.
 */
export async function lookupAll(resolver: AreaResolver, texts: string[]): Promise<AreaLookup[]> {
  const tried = new Set<string>();
  const out: AreaLookup[] = [];
  for (const t of texts) {
    const k = areaKey(t);
    if (!k || tried.has(k)) continue;
    tried.add(k);
    try {
      out.push(await resolver.lookup(t));
    } catch {
      // No answer: not flagged.
    }
  }
  return out;
}

/** Today's behaviour as a resolver: any non-empty text is its own canonical area, with no region and no neighbours. */
export class ExactAreaFallback implements AreaResolver {
  async lookup(text: string): Promise<AreaLookup> {
    if (!areaKey(text)) return blankLookup(text);
    return blankLookup(text, { mapped: true, canonical: text.trim().replace(/\s+/g, " "), source: "exact" });
  }

  async resolve(text: string): Promise<AreaMatch | null> {
    return matchOf(await this.lookup(text));
  }
}

/** A place for MemoryAreaResolver. Neighbours may be plain names (weight 0) or { area, weight }. */
export type Place = { name: string; region: Region | null; municipality?: string | null; neighbours?: (string | Neighbour)[] };

/** An in-memory place list (tests). A name that isn't in the list is unmapped. */
export class MemoryAreaResolver implements AreaResolver {
  private readonly places: Map<string, Place>;

  constructor(places: Place[]) {
    this.places = new Map(places.map((p) => [areaKey(p.name), p]));
  }

  async lookup(text: string): Promise<AreaLookup> {
    if (!areaKey(text)) return blankLookup(text);
    const p = this.places.get(areaKey(text));
    if (!p) return blankLookup(text, { source: "market" });
    return blankLookup(text, {
      mapped: true,
      canonical: p.name,
      region: p.region,
      island: islandOf(p.region),
      municipality: p.municipality ?? null,
      neighbours: neighbourList(p.neighbours),
      confidence: "high",
      source: "market",
    });
  }

  async resolve(text: string): Promise<AreaMatch | null> {
    return matchOf(await this.lookup(text));
  }
}

/** Staff aliases (local). Alias keys are areaKey'd; a later mapping for the same alias wins. */
export class AliasTable implements AliasSource {
  private readonly map = new Map<string, string>();

  constructor(rows: { alias: string; canonical: string }[] = []) {
    for (const r of rows) {
      const k = areaKey(r.alias);
      const c = r.canonical.trim();
      if (k && c) this.map.set(k, c);
    }
  }

  canonicalFor(text: string): string | null {
    return this.map.get(areaKey(text)) ?? null;
  }
}

/** The keys that mark resolve_area's answer (its JSON block): an answer names an area, or says it's unresolved. */
const AREA_KEYS = ["area", "unresolved"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function findAreaObject(result: unknown): Record<string, unknown> | null {
  const r = isObject(result) ? result : {};
  const candidates: unknown[] = [r.structuredContent, result];
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      const text = isObject(block) ? block.text : undefined;
      if (typeof text !== "string") continue;
      try {
        candidates.push(JSON.parse(text));
      } catch {
        // The spoken summary, not JSON.
      }
    }
  }
  return candidates.find((c): c is Record<string, unknown> => isObject(c) && AREA_KEYS.some((k) => k in c)) ?? null;
}

const strOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ") : null);

/** The suggestions: a list of names, de-duplicated. */
const listOf = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = strOf(x);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
};

/**
 * resolve_area's neighbours as { area, weight }. A plain name is weight 0 (fixtures may use names only). A list
 * that isn't a list is no neighbours. Duplicates by area are merged, keeping the higher weight.
 */
export function neighbourList(v: unknown): Neighbour[] {
  if (!Array.isArray(v)) return [];
  const out: Neighbour[] = [];
  for (const x of v) {
    const area = strOf(isObject(x) ? x.area : x);
    if (!area) continue;
    const weight = isObject(x) && typeof x.weight === "number" && Number.isFinite(x.weight) ? x.weight : 0;
    const seen = out.find((n) => areaKey(n.area) === areaKey(area));
    if (seen) seen.weight = Math.max(seen.weight, weight);
    else out.push({ area, weight });
  }
  return out;
}

/** "high" or "low" from a numeric confidence (0 to 1, at or above LOW_CONFIDENCE is high). Anything else is low. */
function confidenceLevel(v: unknown): "high" | "low" {
  if (typeof v === "number") return Number.isFinite(v) && v >= LOW_CONFIDENCE ? "high" : "low";
  return typeof v === "string" && v.trim().toLowerCase() === "high" ? "high" : "low";
}

/**
 * resolve_area's answer as a lookup. The one place that reads the market-mcp shape (see the header of this file).
 * The island is the answer's `island`, or the region's when that's absent. A confident answer with an area is
 * mapped. A low confidence, or `area: null` (unresolved), is unmapped: it keeps its suggestions for the desk.
 */
export function areaFromToolResult(query: string, result: unknown): AreaLookup {
  const o = findAreaObject(result);
  if (!o) return blankLookup(query, { source: "market" });
  const canonical = strOf(o.area);
  const region = parseRegion(o.region);
  const level = confidenceLevel(o.confidence);
  return blankLookup(query, {
    mapped: canonical !== null && level === "high",
    canonical,
    region,
    island: parseIsland(o.island) ?? islandOf(region),
    municipality: strOf(o.municipality),
    neighbours: neighbourList(o.neighbours),
    confidence: canonical ? level : null,
    suggestions: listOf(o.suggestions),
    source: "market",
  });
}

/**
 * resolve_area on market-mcp. A failure (timeout, HTTP, tool error) throws, and the composite falls back to
 * exact text. After a failure, lookups are refused for cooldownMs, so one slow market doesn't stall every
 * area in an alert.
 */
export class MarketAreaResolver implements AreaResolver {
  private readonly caller: ToolCaller;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private downUntil = 0;

  constructor(caller: ToolCaller, o: { now?: () => number; cooldownMs?: number } = {}) {
    this.caller = caller;
    this.now = o.now ?? (() => Date.now());
    this.cooldownMs = o.cooldownMs ?? 60_000;
  }

  async lookup(text: string): Promise<AreaLookup> {
    if (!areaKey(text)) return blankLookup(text);
    if (this.now() < this.downUntil) throw new Error("resolve_area is cooling down after a failure");
    let result: unknown;
    try {
      result = await this.caller.callTool("resolve_area", { text: text.trim() });
    } catch (err) {
      this.downUntil = this.now() + this.cooldownMs;
      throw err;
    }
    return areaFromToolResult(text, result);
  }

  async resolve(text: string): Promise<AreaMatch | null> {
    return matchOf(await this.lookup(text));
  }
}

async function tryLookup(resolver: AreaResolver, text: string): Promise<AreaLookup | null> {
  try {
    return await resolver.lookup(text);
  } catch {
    return null;
  }
}

/**
 * Production resolution: local aliases first (the alias's canonical name, with the market's region, island and
 * neighbours for it if the market knows it), then the market, then exact text if the market is down or unset.
 * Never throws.
 */
export class CompositeAreaResolver implements AreaResolver {
  private readonly aliases: AliasSource | null;
  private readonly market: AreaResolver | null;
  private readonly fallback: AreaResolver;

  constructor(o: { aliases?: AliasSource | null; market?: AreaResolver | null; fallback?: AreaResolver } = {}) {
    this.aliases = o.aliases ?? null;
    this.market = o.market ?? null;
    this.fallback = o.fallback ?? new ExactAreaFallback();
  }

  async lookup(text: string): Promise<AreaLookup> {
    if (!areaKey(text)) return blankLookup(text);
    const canonical = this.aliases?.canonicalFor(text) ?? null;
    if (canonical) {
      const known = this.market ? await tryLookup(this.market, canonical) : null;
      if (known?.mapped) return { ...known, query: text, source: "alias" };
      return blankLookup(text, { mapped: true, canonical, confidence: "high", source: "alias" });
    }
    if (this.market) {
      const answer = await tryLookup(this.market, text);
      if (answer) return answer;
    }
    return this.fallback.lookup(text);
  }

  async resolve(text: string): Promise<AreaMatch | null> {
    return matchOf(await this.lookup(text));
  }
}

/** Keeps the answers that came back, by areaKey, up to `max` (the oldest goes first). Errors are passed on, not kept. */
export class CachedAreaResolver implements AreaResolver {
  private readonly inner: AreaResolver;
  private readonly max: number;
  private readonly cache = new Map<string, AreaLookup>();

  constructor(inner: AreaResolver, max = 500) {
    this.inner = inner;
    this.max = max;
  }

  async lookup(text: string): Promise<AreaLookup> {
    const key = areaKey(text);
    const hit = this.cache.get(key);
    if (hit) return { ...hit, query: text };
    const got = await this.inner.lookup(text);
    if (this.cache.size >= this.max) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, got);
    return got;
  }

  async resolve(text: string): Promise<AreaMatch | null> {
    return matchOf(await this.lookup(text));
  }
}
