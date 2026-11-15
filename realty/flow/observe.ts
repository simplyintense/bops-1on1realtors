import { AREAS, developmentOf, findAreas, findDevelopments } from "../extract.ts";
import { PRICE_BAND, type LiveRequest } from "./live-match.ts";
import { moneyLabel } from "./market-search.ts";
import type { MatchItem } from "./recommendations.ts";
import type { PostCategory } from "./periskope.ts";
import type { Listing } from "./source.ts";

/**
 * Weekend observation mode: classify stored posts as supply or demand, record price ranges, note
 * unknown place names, and flag only a very strong CRM match as an alert. Never sends a reply or DM.
 */

export type ObserveSet = "supply" | "demand";

export function setOf(category: PostCategory): ObserveSet | null {
  if (category === "buyer_request" || category === "rental_request") return "demand";
  if (category === "listing_for_sale" || category === "listing_for_rent" || category === "cobroke") return "supply";
  return null;
}

export function developmentNameOf(area: string | null | undefined): string | null {
  return developmentOf(area)?.name ?? null;
}

export type PriceRangeRow = {
  area: string;
  development: string | null;
  beds: number | null;
  listingType: "sale" | "rent";
  currency: string;
  side: ObserveSet;
  min: number;
  max: number;
  count: number;
  updatedAt: string;
};

export function priceKey(r: Pick<PriceRangeRow, "area" | "development" | "beds" | "listingType" | "currency" | "side">): string {
  return [r.side, r.listingType, r.currency, r.area, r.development ?? "", r.beds ?? ""].join("|");
}

export function foldPrice(existing: PriceRangeRow | null, price: number, at: string, base: Omit<PriceRangeRow, "min" | "max" | "count" | "updatedAt">): PriceRangeRow {
  if (!existing) return { ...base, min: price, max: price, count: 1, updatedAt: at };
  return { ...existing, min: Math.min(existing.min, price), max: Math.max(existing.max, price), count: existing.count + 1, updatedAt: at };
}

export type UnknownPlace = { name: string; count: number; firstSeenAt: string; lastSeenAt: string };

const SKIP_HINTS = new Set(
  [
    "Search", "Budget", "Trinidad", "Tobago", "WhatsApp", "Anyone", "Someone", "Please", "Hello", "Good", "Hi",
    "Need", "Looking", "Client", "Agent", "Agents", "Thanks", "Thank", "Available", "Listing", "Price", "Contact",
    "Call", "Today", "Tomorrow", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "Sale", "Rent", "Bedroom", "Bedrooms", "Apartment", "House", "Townhouse", "Unit", "Units", "Ttd", "Usd",
  ].map((s) => s.toLowerCase()),
);

const areaLookup = new Set(
  [...AREAS, ...AREAS.map((a) => a.replace(/\./g, ""))].map((a) => a.toLowerCase()),
);

function alreadyKnown(name: string): boolean {
  const k = name.replace(/[–—]/g, "-").trim().replace(/\s+/g, " ").toLowerCase();
  if (areaLookup.has(k) || developmentOf(name)) return true;
  return false;
}

/** Place-like names after in/at/near/around that are not in the gazetteer. Never returns message text. */
export function unknownPlaceHints(text: string): string[] {
  const known = new Set([...findAreas(text), ...findDevelopments(text).map((d) => d.name)].map((s) => s.toLowerCase()));
  const out: string[] = [];
  const re = /\b(?:in|at|near|around)\s+([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,3})/g;
  for (const m of text.matchAll(re)) {
    const name = (m[1] ?? "").replace(/[.,;:!?]+$/g, "").trim();
    if (!name || name.length < 3 || name.length > 40) continue;
    if (known.has(name.toLowerCase()) || alreadyKnown(name) || SKIP_HINTS.has(name.toLowerCase())) continue;
    if (/\d/.test(name) || /^(TT|US)\$/i.test(name)) continue;
    if (!out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

const areaTextKey = (s: string) => s.replace(/[–—]/g, "-").trim().replace(/\s+/g, " ").toLowerCase();
const mentionsName = (hay: string, name: string) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(hay);

/** Same named development, or the same area — not a neighbour, and not Glencoe-for-West-Hills. */
export function isVeryStrongPlace(requestArea: string, l: Pick<Listing, "area" | "title">): boolean {
  const d = developmentOf(requestArea);
  const hay = `${l.area ?? ""} ${l.title ?? ""}`;
  if (d) return mentionsName(hay, d.name) || d.aliases.some((a) => mentionsName(hay, a));
  const areaK = areaTextKey(l.area ?? "");
  return areaK === areaTextKey(requestArea) || mentionsName(hay, requestArea);
}

/**
 * A very strong CRM match: same development or area, sale vs rent, same currency, price inside the
 * 20% band, and exact beds. Neighbours (including Glencoe next to West Hills) are not enough.
 */
export function veryStrongOurListings(r: LiveRequest, listings: readonly Listing[]): MatchItem[] {
  if (!r.intent || !r.area || r.beds == null) return [];
  const type = r.intent === "rent" ? "rent" : "sale";
  const top = r.priceMax ?? r.priceMin;
  const bottom = r.priceMin ?? r.priceMax;
  if (top == null || bottom == null) return [];
  const hi = top * (1 + PRICE_BAND);
  const lo = bottom * (1 - PRICE_BAND);
  const currency = r.currency ?? "TTD";
  const budget = top;
  const hits = listings.filter(
    (l) =>
      l.status === "active" &&
      l.listingType === type &&
      l.price > 0 &&
      l.currency === currency &&
      l.price >= lo &&
      l.price <= hi &&
      l.beds === r.beds &&
      isVeryStrongPlace(r.area!, l),
  );
  hits.sort((a, b) => Math.abs(a.price - budget) - Math.abs(b.price - budget));
  return hits.map((l) => ({
    title: l.title || "1on1 Realtors listing",
    url: /^https?:\/\//i.test(l.url) ? l.url : null,
    area: l.area || null,
    price: l.price ? moneyLabel(l.price, l.currency) : null,
    beds: l.beds || null,
    source: "1on1 Realtors",
    reason: `very strong: ${l.area || r.area}, exact ${l.beds} bed, ${moneyLabel(l.price, l.currency)} in band`,
    holder: l.agentId > 0 ? l.agentId : null,
  }));
}

export type StrongAlert = {
  at: string;
  messageId: string;
  chatId: string;
  groupName: string | null;
  requestArea: string;
  requestBeds: number | null;
  requestBudget: number | null;
  currency: string | null;
  listingType: "sale" | "rent";
  listingTitle: string;
  listingArea: string | null;
  listingPrice: string | null;
  listingBeds: number | null;
  listingUrl: string | null;
  reason: string;
};
