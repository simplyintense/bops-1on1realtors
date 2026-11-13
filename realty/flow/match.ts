import { areaTier, ExactAreaFallback, exactRef, refFor, TIER_RANK, type AreaResolver, type MatchTier } from "./areas.ts";
import type { Inquiry } from "./engine.ts";
import type { CoBrokeHit, MarketCriteria } from "./market-search.ts";
import type { Listing } from "./source.ts";

/**
 * Listings that fit a buyer's or renter's criteria: our own (from the CRM) and other agencies' (co-broke,
 * from the market search, market-search.ts). Budget, beds, type, status and "not the listing asked about"
 * are checked as before. Area is now a tier (areas.ts): same area, then a neighbour, then the same region.
 * Excluded areas (Tobago vs Trinidad, or anything unrelated) are dropped. Co-broke hits get the same
 * treatment here, client-side: the search server's area filter is not trusted as geography.
 *
 * Inside the neighbour tier, the higher market weight comes first; then price. Other tiers are tier, then price.
 *
 * With no resolver, the area check is today's exact text. An inquiry with no criteria (no type, area,
 * budget or beds) gets no matches rather than every listing.
 */

/** weight is the neighbour weight from market-mcp (0 for every other tier, and for a neighbour named without one). */
export type Ranked<T> = { item: T; tier: MatchTier; reason: string; weight: number };

const DEFAULT_LIMIT = 5;

export function hasCriteria(inq: Inquiry): boolean {
  return Boolean(inq.listingType || inq.area || inq.budget || inq.beds);
}

export function marketCriteria(inq: Inquiry): MarketCriteria {
  return {
    listingType: inq.listingType,
    area: inq.area,
    maxPrice: inq.budget ? { amount: inq.budget.max, currency: inq.budget.currency } : null,
    beds: inq.beds,
  };
}

/** Our listing against the inquiry, with the area left out (that's the tier). */
function fitsOurs(inq: Inquiry, l: Listing): boolean {
  return (
    l.status === "active" &&
    l.id !== inq.listingId &&
    (!inq.listingType || l.listingType === inq.listingType) &&
    (!inq.budget || (l.currency === inq.budget.currency && l.price <= inq.budget.max)) &&
    (!inq.beds || l.beds >= inq.beds)
  );
}

/**
 * A co-broke hit against the inquiry, with the area left out. A field the hit doesn't give can't be checked,
 * so it passes; a field it does give must fit (a price in another currency can't be compared, so it doesn't).
 */
function fitsHit(inq: Inquiry, h: CoBrokeHit): boolean {
  if (inq.listingType && h.listingType && h.listingType !== inq.listingType) return false;
  if (inq.budget && h.price !== null && h.currency !== null && (h.currency !== inq.budget.currency || h.price > inq.budget.max)) return false;
  if (inq.beds && h.beds !== null && h.beds < inq.beds) return false;
  return true;
}

function cmpPrice(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function sortRanked<T>(rows: Ranked<T>[], price: (item: T) => number | null, limit: number): Ranked<T>[] {
  return rows
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.weight - a.weight || cmpPrice(price(a.item), price(b.item)))
    .slice(0, limit);
}

/** Our listings that fit, best tier first, then cheapest. Async: the resolver may ask the market. */
export async function rankOurListings(inq: Inquiry, listings: Listing[], areas: AreaResolver = new ExactAreaFallback(), limit = DEFAULT_LIMIT): Promise<Ranked<Listing>[]> {
  if (!hasCriteria(inq)) return [];
  const inqRef = inq.area ? await refFor(areas, inq.area) : null;
  const out: Ranked<Listing>[] = [];
  for (const l of listings) {
    if (!fitsOurs(inq, l)) continue;
    const v = areaTier(inqRef, await refFor(areas, l.area));
    if (v.tier !== "excluded") out.push({ item: l, tier: v.tier, reason: v.reason, weight: v.weight ?? 0 });
  }
  return sortRanked(out, (l) => l.price, limit);
}

/** Other agencies' hits that fit, ranked the same way. A hit with no area can't be placed, so it's dropped when the inquiry names one. */
export async function rankCoBroke(inq: Inquiry, hits: CoBrokeHit[], areas: AreaResolver = new ExactAreaFallback(), limit = DEFAULT_LIMIT): Promise<Ranked<CoBrokeHit>[]> {
  if (!hasCriteria(inq)) return [];
  const inqRef = inq.area ? await refFor(areas, inq.area) : null;
  const out: Ranked<CoBrokeHit>[] = [];
  for (const h of hits) {
    if (!fitsHit(inq, h)) continue;
    if (inqRef && !h.area) continue;
    const v = areaTier(inqRef, await refFor(areas, h.area ?? ""));
    if (v.tier !== "excluded") out.push({ item: h, tier: v.tier, reason: v.reason, weight: v.weight ?? 0 });
  }
  return sortRanked(out, (h) => h.price, limit);
}

/**
 * Our listings that fit, with exact-text areas, synchronously. The original helper: kept for callers that
 * don't have a resolver. Same rules as rankOurListings with ExactAreaFallback.
 */
export function matchOurListings(inq: Inquiry, listings: Listing[], limit = DEFAULT_LIMIT): Listing[] {
  if (!hasCriteria(inq)) return [];
  const inqRef = inq.area ? exactRef(inq.area) : null;
  const out: Ranked<Listing>[] = [];
  for (const l of listings) {
    if (!fitsOurs(inq, l)) continue;
    const v = areaTier(inqRef, exactRef(l.area));
    if (v.tier !== "excluded") out.push({ item: l, tier: v.tier, reason: v.reason, weight: 0 });
  }
  return sortRanked(out, (l) => l.price, limit).map((r) => r.item);
}
