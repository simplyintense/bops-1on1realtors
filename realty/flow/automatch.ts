import type { AreaKnowledgeIndex } from "./area-knowledge.ts";
import type { AreaResolver } from "./areas.ts";
import { categoryOfListing, categoryOfRequest, comparedPrice, fitsOurListing, ourAreaContext, ourAreaRelation, PRICE_BAND, type LiveRequest } from "./live-match.ts";
import type { Listing } from "./source.ts";

/**
 * 1on1 CRM Automatch: WhatsApp demand (people looking, from the search store) against our active CRM listings, each pair
 * scored 0–100. Read only: nothing here sends, writes or calls anything.
 *
 * Eligibility is the live matching rules, not a copy of them: fitsOurListing and the area tiers from live-match.ts. So every
 * pair here is one matchOurListings would also give. The score is this file's:
 *   price 35    the listing at or under the budget is full; linear down to 0 at 20% over (PRICE_BAND); a missing price or budget is 0
 *   area 30     same area 30, nearby 15
 *   beds 20     exact 20, one off 10, missing 0
 *   type 10     sale/rent agrees (5; eligibility makes it agree) + kind of place agrees (5; no type asked is 5)
 *   recency 5   the ask was seen within 3 days: 5, linear to 0 at 30 days
 * The parts add up to at most 100 and the score is their rounded sum. Bands: 75+ strong, 50–74 fair, below 50 not shown.
 *
 * Portable: no node:*, no next, no bare process.
 */

export const STRONG = 75;
export const FAIR = 50;

const WEIGHT = { price: 35, area: 30, beds: 20, saleRent: 5, kind: 5, recency: 5 } as const;
const DAY_MS = 86_400_000;
/** Recency: full within this many days, zero from RECENT_ZERO_DAYS on, linear between. */
const RECENT_FULL_DAYS = 3;
const RECENT_ZERO_DAYS = 30;

/** A demand record as the scorer reads it: one ask, and when it was last seen (ISO). */
export type AutomatchAsk = {
  id: string;
  area: string;
  beds: number | null;
  /** The budget as one figure, in `currency`. null when the ask gives none. */
  budget: number | null;
  currency: "TTD" | "USD";
  /** The asked kind of place (house, apartment, land…), or null. */
  type: string | null;
  listingType: "sale" | "rent";
  lastSeenAt: string;
};

export type AreaRelation = "same" | "nearby";
export type ScoreParts = { price: number; area: number; beds: number; saleRent: number; kind: number; recency: number };
export type Scored = { score: number; reason: string; parts: ScoreParts };
export type Band = "strong" | "fair";
export type AutomatchPair = Scored & { ask: AutomatchAsk; listing: Listing; areaRelation: AreaRelation };

/** Money the way the desk reads it in a reason: TT$1.75m, TT$8,500, US$2,000. */
function money(n: number, currency: string): string {
  const sym = currency.toUpperCase() === "USD" ? "US$" : "TT$";
  if (n >= 1_000_000) return `${sym}${Math.round((n / 1_000_000) * 100) / 100}m`;
  return `${sym}${n.toLocaleString("en-US")}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * One ask against one listing: the score (an integer 0–100), its parts, and the one-line reason. `areaRelation` is the
 * listing's area against the ask's (null when it isn't checked: no points for area then). Pure.
 */
export function scorePair(ask: Omit<AutomatchAsk, "id">, l: Listing, o: { areaRelation: AreaRelation | null; now: Date }): Scored {
  const cur = ask.currency;
  const askCategory = categoryOfRequest(ask.type);

  // The listing's price in the ask's currency (its TTD equivalent for a TTD ask), as live matching compares it. A price
  // that's only in another currency (a USD listing with no TTD equivalent, for a TTD ask) has nothing to compare, so 0.
  const cmp = comparedPrice(l, cur);
  const lp = cmp.currency === cur ? cmp.price : 0;
  let price: { points: number; text: string };
  if (!ask.budget) price = { points: 0, text: "no budget given" };
  else if (!lp) price = { points: 0, text: l.price ? `no ${cur === "USD" ? "US$" : "TT$"} price to compare` : "no price listed" };
  else if (lp <= ask.budget) price = { points: WEIGHT.price, text: `${money(lp, cur)} within ${money(ask.budget, cur)} budget` };
  else {
    const over = (lp - ask.budget) / ask.budget;
    price = { points: WEIGHT.price * Math.max(0, 1 - over / PRICE_BAND), text: `${money(lp, cur)}, ${Math.round(over * 100)}% over the ${money(ask.budget, cur)} budget` };
  }

  let area: { points: number; text: string };
  if (o.areaRelation === "same") area = { points: WEIGHT.area, text: `Same area (${ask.area})` };
  else if (o.areaRelation === "nearby") area = { points: WEIGHT.area / 2, text: `Nearby (${l.area || "a neighbour"})` };
  else area = { points: 0, text: "area not checked" };

  let beds: { points: number; text: string };
  if (ask.beds == null || !l.beds) beds = { points: 0, text: "beds unknown" };
  else if (l.beds === ask.beds) beds = { points: WEIGHT.beds, text: `${plural(l.beds, "bed")} as asked` };
  else if (Math.abs(l.beds - ask.beds) === 1) beds = { points: WEIGHT.beds / 2, text: `${plural(l.beds, "bed")}, one from the ${ask.beds} asked` };
  else beds = { points: 0, text: `${plural(l.beds, "bed")}, ${Math.abs(l.beds - ask.beds)} from the ${ask.beds} asked` };

  const saleRent = ask.listingType === l.listingType ? WEIGHT.saleRent : 0;
  const kind = !askCategory || categoryOfListing(l) === askCategory ? WEIGHT.kind : 0;

  const seen = Date.parse(ask.lastSeenAt);
  let recency: { points: number; text: string };
  if (!Number.isFinite(seen)) recency = { points: 0, text: "posted date unknown" };
  else {
    const days = Math.max(0, (o.now.getTime() - seen) / DAY_MS);
    const points = days <= RECENT_FULL_DAYS ? WEIGHT.recency : days >= RECENT_ZERO_DAYS ? 0 : (WEIGHT.recency * (RECENT_ZERO_DAYS - days)) / (RECENT_ZERO_DAYS - RECENT_FULL_DAYS);
    recency = { points, text: days < 1 ? "posted today" : `posted ${plural(Math.floor(days), "day")} ago` };
  }

  const parts: ScoreParts = { price: price.points, area: area.points, beds: beds.points, saleRent, kind, recency: recency.points };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    score: Math.min(100, Math.max(0, Math.round(total))),
    reason: [area.text, beds.text, price.text, recency.text].join(", "),
    parts,
  };
}

/** The band a score falls in, or null below FAIR (never shown). */
export function bandOf(score: number): Band | null {
  return score >= STRONG ? "strong" : score >= FAIR ? "fair" : null;
}

/** How many pairs fall in each band. */
export function bandCounts(pairs: readonly { score: number }[]): { strong: number; fair: number } {
  return { strong: pairs.filter((p) => bandOf(p.score) === "strong").length, fair: pairs.filter((p) => bandOf(p.score) === "fair").length };
}

/** The live matching request for one ask (the same shape matchOurListings takes). */
function requestOf(a: AutomatchAsk): LiveRequest {
  return { intent: a.listingType === "rent" ? "rent" : "buy", area: a.area, beds: a.beds, propertyType: a.type, priceMin: null, priceMax: a.budget, currency: a.currency, monthly: false };
}

/**
 * Every eligible pair, best first (score, then the newer ask, then the listing title). Eligibility and the area tiers are
 * live-match.ts's, so an ask never pairs with a listing of the other kind (sale vs rent), and the same listings come back
 * as matchOurListings would give. An ask with no area is never matched. Area lookups are once per distinct area.
 */
export async function automatchPairs(asks: readonly AutomatchAsk[], listings: readonly Listing[], areas: AreaResolver, now: Date, knowledge: AreaKnowledgeIndex | null = null): Promise<AutomatchPair[]> {
  const out: AutomatchPair[] = [];
  for (const ask of asks) {
    if (!ask.area) continue;
    const r = requestOf(ask);
    const fits = listings.filter((l) => fitsOurListing(r, l));
    if (!fits.length) continue;
    const ctx = await ourAreaContext(ask.area, fits, areas, knowledge);
    for (const l of fits) {
      const rel = ourAreaRelation(ctx, l);
      if (!rel) continue;
      const areaRelation: AreaRelation = rel.tier === "same-area" ? "same" : "nearby";
      out.push({ ...scorePair(ask, l, { areaRelation, now }), ask, listing: l, areaRelation });
    }
  }
  return out.sort((a, b) => b.score - a.score || Date.parse(b.ask.lastSeenAt) - Date.parse(a.ask.lastSeenAt) || a.listing.title.localeCompare(b.listing.title));
}

/** A stored demand record as the matcher reads it (SearchRow has all of these). */
export type DemandRow = {
  id: string;
  area: string | null;
  development: string | null;
  beds: number | null;
  price: number | null;
  currency: string | null;
  type: string | null;
  listingType: string | null;
  lastSentAt: string;
  status?: string | null;
};

/** Parked and ignored asks are left out of Automatch (the owner set them aside). */
export function excludedDemand(d: { status?: string | null }): boolean {
  return d.status === "ignored" || d.status === "parked";
}

/**
 * A demand record as an ask, or null when it can't be matched: parked or ignored, no sale or rent (a shortlet, or none), or
 * no place (area, else development). A price with no currency is read as TTD, as the matcher reads it.
 */
export function askOf(d: DemandRow): AutomatchAsk | null {
  if (excludedDemand(d)) return null;
  const area = (d.area || d.development || "").trim();
  const listingType = d.listingType === "rent" ? "rent" : d.listingType === "sale" ? "sale" : null;
  if (!area || !listingType) return null;
  return { id: d.id, area, beds: d.beds, budget: d.price, currency: d.currency?.toUpperCase() === "USD" ? "USD" : "TTD", type: d.type, listingType, lastSeenAt: d.lastSentAt };
}
