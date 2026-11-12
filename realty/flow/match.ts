import type { Inquiry } from "./engine.ts";
import type { MarketCriteria } from "./market-search.ts";
import type { Listing } from "./source.ts";

/**
 * Listings that fit a buyer's or renter's criteria: our own (from the CRM) here, other agencies' from
 * the market search (market-search.ts). Only what the inquiry actually asks for is checked; an inquiry
 * with no criteria (no type, area, budget or beds) gets no matches rather than every listing.
 */

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

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

export function matchOurListings(inq: Inquiry, listings: Listing[], limit = 5): Listing[] {
  if (!hasCriteria(inq)) return [];
  return listings
    .filter((l) => l.status === "active")
    .filter((l) => l.id !== inq.listingId)
    .filter((l) => !inq.listingType || l.listingType === inq.listingType)
    .filter((l) => !inq.area || sameText(l.area, inq.area))
    .filter((l) => !inq.budget || (l.currency === inq.budget.currency && l.price <= inq.budget.max))
    .filter((l) => !inq.beds || l.beds >= inq.beds)
    .sort((a, b) => a.price - b.price)
    .slice(0, limit);
}
