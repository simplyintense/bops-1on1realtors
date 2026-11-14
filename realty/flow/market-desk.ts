import { areaKey, type AreaLookup, type AreaResolver } from "./areas.ts";
import { hitsFromToolResult, MarketClient, type CoBrokeHit, type MarketConfig } from "./market-search.ts";

/**
 * The staff market search (app/realty/market and /api/realty/market/search): other agencies' listings for an area,
 * with filters. Read-only. It calls search_market_listings once for the resolved area, with area_scope "exact" or
 * "nearby", and resolve_area only through the resolver it's given. It never writes an alias, never calls a learn_
 * tool, and sends and writes nothing. The lead flow's five-hit cap (MarketSearch) doesn't apply here.
 *
 * The market applies every filter here (listing_type, area, area_scope, beds_min and beds_max, price_min and price_max,
 * property_type) in SQL before its limit, so this module must not apply them again: a listing the market returns is
 * shown as it is. area_scope is always sent: leaving it off defaults to "region" on the market. Nearby areas are
 * included by the market when area_scope is "nearby"; this module does not search neighbours itself. There is no
 * currency parameter; the market compares raw amounts, so `currency` is not sent. The page reads its filters from
 * query params, so no token reaches the browser.
 */

export type Currency = "TTD" | "USD" | "any";

export type PropertyType = "house" | "apartment" | "townhouse" | "land" | "commercial";
const PROPERTY_TYPES: readonly PropertyType[] = ["house", "apartment", "townhouse", "land", "commercial"];

export type DeskCriteria = {
  area: string;
  nearby: boolean;
  listingType: "sale" | "rent" | null;
  bedsMin: number | null;
  bedsMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  propertyType: PropertyType | null;
  currency: Currency;
};

/** What the resolver made of the typed area. `searched` is the area name sent to the market (one name; nearby is area_scope). */
export type DeskArea = { typed: string; mapped: boolean; canonical: string | null; neighbours: string[]; searched: string[] };

export type DeskResult =
  | { status: "not-configured" }
  | { status: "error"; reason: "timeout" | "unavailable" }
  | { status: "ok"; area: DeskArea | null; listings: CoBrokeHit[]; returned: number; failed: number };

export type DeskDeps = { config: MarketConfig | null; resolver: AreaResolver; fetcher?: typeof fetch };

const TOOL = "search_market_listings";
const LIMIT = 50;
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
  const propertyType = p.get("propertyType");
  return {
    area: (p.get("area") ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_AREA_CHARS),
    nearby: p.get("nearby") === "1",
    listingType: type === "sale" || type === "rent" ? type : null,
    bedsMin: beds("bedsMin"),
    bedsMax: beds("bedsMax"),
    priceMin: num("priceMin"),
    priceMax: num("priceMax"),
    propertyType: PROPERTY_TYPES.find((t) => t === propertyType) ?? null,
    currency: currency === "TTD" || currency === "USD" ? currency : "any",
  };
}

/** The arguments for one search_market_listings call. Every filter goes to the market, which applies it before the limit. area_scope is always sent. */
export function searchArgs(c: DeskCriteria, area: string | null): Record<string, string | number> {
  const args: Record<string, string | number> = { limit: LIMIT, area_scope: c.nearby ? "nearby" : "exact" };
  if (c.listingType) args.listing_type = c.listingType;
  if (area) args.area = area;
  if (c.bedsMin !== null) args.beds_min = c.bedsMin;
  if (c.bedsMax !== null) args.beds_max = c.bedsMax;
  if (c.priceMin !== null) args.price_min = c.priceMin;
  if (c.priceMax !== null) args.price_max = c.priceMax;
  if (c.propertyType) args.property_type = c.propertyType;
  return args;
}

/** The one area name to send: the canonical name when the resolver knows it, otherwise the text as typed. Nearby is area_scope, not extra names. */
async function planAreas(c: DeskCriteria, resolver: AreaResolver): Promise<{ area: DeskArea | null; names: (string | null)[] }> {
  if (!c.area) return { area: null, names: [null] };
  const found: AreaLookup | null = await resolver.lookup(c.area).catch(() => null);
  if (!found?.mapped || !found.canonical) {
    return { area: { typed: c.area, mapped: false, canonical: null, neighbours: [], searched: [c.area] }, names: [c.area] };
  }
  const neighbours = found.neighbours.map((n) => n.area);
  const searched = [found.canonical];
  return { area: { typed: c.area, mapped: true, canonical: found.canonical, neighbours, searched }, names: searched };
}

const timedOut = (err: unknown) => (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";

/**
 * The staff search. Never throws: no config is "not-configured"; every area failing is an error (a timeout or
 * unavailable). Duplicate hits in one reply are de-duplicated by url, or by title and source when there's no url.
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
  return { status: "ok", area, listings: hits, returned: hits.length, failed: failures.length };
}
