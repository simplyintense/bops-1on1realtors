import { areaKey, type AreaLookup, type AreaResolver } from "./areas.ts";
import { hitsFromToolResult, MarketClient, type CoBrokeHit, type MarketConfig } from "./market-search.ts";

/**
 * The staff market search (app/realty/market and /api/realty/market/search): other agencies' listings for an area,
 * with filters. Read-only. It calls search_market_listings once per area searched, and resolve_area only through the
 * resolver it's given. It never writes an alias, never calls a learn_ tool, and sends and writes nothing. The lead
 * flow's five-hit cap (MarketSearch) doesn't apply here.
 *
 * The market gets listing_type, area, beds_min, and price_max only when the cap is TTD (an "any" currency is read as
 * TTD, the same as toolArguments). Everything else is checked here: beds_max, price_min, and any price bound for a
 * currency the market doesn't cap (USD). The page reads its filters from query params, so no token reaches the browser.
 */

export type Currency = "TTD" | "USD" | "any";

export type DeskCriteria = {
  area: string;
  nearby: boolean;
  listingType: "sale" | "rent" | null;
  bedsMin: number | null;
  bedsMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: Currency;
};

/** What the resolver made of the typed area. `searched` is the area names sent to the market. */
export type DeskArea = { typed: string; mapped: boolean; canonical: string | null; neighbours: string[]; searched: string[] };

export type DeskResult =
  | { status: "not-configured" }
  | { status: "error"; reason: "timeout" | "unavailable" }
  | { status: "ok"; area: DeskArea | null; listings: CoBrokeHit[]; returned: number; failed: number };

export type DeskDeps = { config: MarketConfig | null; resolver: AreaResolver; fetcher?: typeof fetch };

const TOOL = "search_market_listings";
const LIMIT = 50;
/** The canonical area and up to eight neighbours. */
const MAX_AREAS = 9;
const MAX_AREA_CHARS = 80;

/** The filters from a query string (the page's form, or the API). Anything unreadable is "not set". */
export function criteriaFromParams(p: URLSearchParams): DeskCriteria {
  const num = (k: string): number | null => {
    const t = (p.get(k) ?? "").trim();
    const n = Number(t);
    return t && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const beds = (k: string) => {
    const n = num(k);
    return n === null ? null : Math.floor(n);
  };
  const type = p.get("type");
  const currency = p.get("currency");
  return {
    area: (p.get("area") ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_AREA_CHARS),
    nearby: p.get("nearby") === "1",
    listingType: type === "sale" || type === "rent" ? type : null,
    bedsMin: beds("bedsMin"),
    bedsMax: beds("bedsMax"),
    priceMin: num("priceMin"),
    priceMax: num("priceMax"),
    currency: currency === "TTD" || currency === "USD" ? currency : "any",
  };
}

/** The arguments for one search_market_listings call. price_max goes only as a TTD cap. */
export function searchArgs(c: DeskCriteria, area: string | null): Record<string, string | number> {
  const args: Record<string, string | number> = { limit: LIMIT };
  if (c.listingType) args.listing_type = c.listingType;
  if (area) args.area = area;
  if (c.bedsMin !== null) args.beds_min = c.bedsMin;
  if (c.priceMax !== null && c.currency !== "USD") args.price_max = c.priceMax;
  return args;
}

/**
 * The filters the market doesn't apply, here. A bound a listing can't meet (no beds or no price to check) drops it.
 * A listing with no currency stated passes the currency check; one in another currency is dropped. With "any",
 * the bounds compare the raw amounts (the same reading as the TTD cap).
 */
export function keep(h: CoBrokeHit, c: DeskCriteria): boolean {
  if (c.bedsMin !== null && (h.beds === null || h.beds < c.bedsMin)) return false;
  if (c.bedsMax !== null && (h.beds === null || h.beds > c.bedsMax)) return false;
  if (c.priceMin === null && c.priceMax === null) return true;
  if (h.price === null) return false;
  if (c.currency !== "any" && h.currency && h.currency.toUpperCase() !== c.currency) return false;
  return (c.priceMin === null || h.price >= c.priceMin) && (c.priceMax === null || h.price <= c.priceMax);
}

/** The area names to search: the canonical area, then (with nearby on) its neighbours, each once. */
async function planAreas(c: DeskCriteria, resolver: AreaResolver): Promise<{ area: DeskArea | null; names: (string | null)[] }> {
  if (!c.area) return { area: null, names: [null] };
  const found: AreaLookup | null = await resolver.lookup(c.area).catch(() => null);
  if (!found?.mapped || !found.canonical) {
    return { area: { typed: c.area, mapped: false, canonical: null, neighbours: [], searched: [c.area] }, names: [c.area] };
  }
  const neighbours = found.neighbours.map((n) => n.area);
  const seen = new Set([areaKey(found.canonical)]);
  const searched = [found.canonical];
  if (c.nearby) {
    for (const n of neighbours) {
      if (!seen.has(areaKey(n))) {
        seen.add(areaKey(n));
        searched.push(n);
      }
    }
  }
  const names = searched.slice(0, MAX_AREAS);
  return { area: { typed: c.area, mapped: true, canonical: found.canonical, neighbours, searched: names }, names };
}

const timedOut = (err: unknown) => (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";

/**
 * The staff search. Never throws: no config is "not-configured"; every area failing is an error (a timeout or
 * unavailable); some failing still shows the rest, with `failed` counted. Listings from several areas are de-duplicated
 * by url, or by title and source when there's no url.
 */
export async function marketDeskSearch(c: DeskCriteria, deps: DeskDeps): Promise<DeskResult> {
  if (!deps.config) return { status: "not-configured" };
  const client = new MarketClient(deps.config, deps.fetcher);
  const { area, names } = await planAreas(c, deps.resolver);
  const outcomes = await Promise.allSettled(names.map((n) => client.callTool(TOOL, searchArgs(c, n)).then((r) => hitsFromToolResult(r, LIMIT))));
  const answered = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value] : []));
  const failures = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason as unknown] : []));
  if (!answered.length && failures.length) return { status: "error", reason: failures.every(timedOut) ? "timeout" : "unavailable" };

  const seen = new Set<string>();
  const hits: CoBrokeHit[] = [];
  for (const h of answered.flat()) {
    const k = h.url ? `u:${h.url}` : `t:${areaKey(h.title)}|${h.source.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    hits.push(h);
  }
  return { status: "ok", area, listings: hits.filter((h) => keep(h, c)), returned: hits.length, failed: failures.length };
}
