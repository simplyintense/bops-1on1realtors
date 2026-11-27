import type { AreaKnowledgeIndex } from "./area-knowledge.ts";
import { areaKey, parseRegion, type AreaResolver } from "./areas.ts";
import { isCentralAreaGroup } from "../extract.ts";
import { sameDemandAsk, type AskFacts } from "./ask-match.ts";
import { isUsd, moneyWithTtd, shortMoney, ttdValue } from "./fx.ts";
import { moneyLabel } from "./market-search.ts";
import { categoryOfListing, categoryOfRequest, fitsOurListing, listingTtd, ourAreaContext, ourAreaRelation, PRICE_BAND, type LiveRequest } from "./live-match.ts";
import { nearbyDriveLabel } from "./taught-areas.ts";
import type { Listing } from "./source.ts";

/**
 * 1on1 CRM Automatch: WhatsApp demand (people looking, from the search store) against our active CRM listings, each pair
 * scored 0–100. Read only: nothing here sends, writes or calls anything.
 *
 * Eligibility is the live matching rules, not a copy of them: fitsOurListing and the area tiers from live-match.ts. So every
 * pair here is one matchOurListings would also give. Money is compared in TTD at the fixed rate (fx.ts). The score is this file's:
 *   price 25    the listing at or under the budget is full (a range: anywhere from its floor to its ceiling); linear down to 0 at 20%
 *               past the edge (PRICE_BAND); a missing price or budget is 0
 *   area 30     same area 30, nearby 15
 *   beds 20     in the asked beds (a range: any in it) 20, one more than the most asked 10, else 0 (fewer than asked is out); missing 0
 *   type 10     sale/rent agrees (5; eligibility makes it agree) + kind of place agrees (5; no type asked is 5)
 *   recency 15  the ask's posted date (first seen, else last seen), by whole days old: 15 to 30 days, 12 to 60, 9 to 90, 6 to 120, 3 to 365, 0 after
 * The parts add up to at most 100 and the score is their rounded sum. Bands: 75+ strong, 50–74 fair, below 50 not shown.
 *
 * One sender's near-identical asks (sameDemandAsk) that hit the same listing are one row: the best score stands (tie: the newer
 * ask), and the posts add up (foldSameSenderPairs).
 *
 * Portable: no node:*, no next, no bare process.
 */

export const STRONG = 75;
export const FAIR = 50;

const WEIGHT = { price: 25, area: 30, beds: 20, saleRent: 5, kind: 5 } as const;
const DAY_MS = 86_400_000;
/** Recency by the ask's age in whole days: [the most days in the tier, its points]. Over the last tier is 0. */
const RECENCY_TIERS: readonly (readonly [number, number])[] = [
  [30, 15],
  [60, 12],
  [90, 9],
  [120, 6],
  [365, 3],
];

function recencyPoints(days: number): number {
  const whole = Math.floor(days);
  return RECENCY_TIERS.find(([most]) => whole <= most)?.[1] ?? 0;
}

/**
 * A demand record as the scorer reads it: one ask, and when it was last seen (ISO). `postedAt` is when the ask was first seen
 * (ISO), when the record has it: recency is measured from that, else from lastSeenAt. `sender` is the poster's number (used only to
 * fold one sender's near-identical asks) and `posts` how many posts the record folds (the store's count), both optional.
 */
export type AutomatchAsk = {
  id: string;
  area: string;
  /** The least beds asked (the one figure, or the low end of a range). */
  beds: number | null;
  /** The most beds of a range ("2 or 3 bed" is 2 to 3). Absent or null for a single figure. */
  bedsMax?: number | null;
  /** The budget in `currency`: the single figure, or the ceiling of a range. null when the ask gives none. */
  budget: number | null;
  /** The floor of a budget range, when the ask gives one. With `budget` null it is a floor with no ceiling. */
  budgetMin?: number | null;
  currency: "TTD" | "USD";
  /** The asked kind of place (house, apartment, land…), or null. */
  type: string | null;
  listingType: "sale" | "rent";
  lastSeenAt: string;
  postedAt?: string;
  sender?: string;
  posts?: number;
};

export type AreaRelation = "same" | "nearby";
export type ScoreParts = { price: number; area: number; beds: number; saleRent: number; kind: number; recency: number };
export type Scored = { score: number; reason: string; parts: ScoreParts };
export type Band = "strong" | "fair";
export type AutomatchPair = Scored & { ask: AutomatchAsk; listing: Listing; areaRelation: AreaRelation };
/** One row after folding: the best pair of one sender's near-identical asks on a listing, and the posts they add up to. */
export type AutomatchGroup = AutomatchPair & { posts: number };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The budget as a row shows it: TT$ as it is; a USD ask as "asked in US$ (US$650k ≈ TT$4.41m)". */
export function askBudgetLabel(budget: number, currency: string): string {
  return isUsd(currency) ? `asked in US$ (${moneyWithTtd(budget, "USD")})` : (moneyLabel(budget, "TTD") ?? String(budget));
}

/**
 * One ask against one listing: the score (an integer 0–100), its parts, and the one-line reason. `areaRelation` is the
 * listing's area against the ask's (null when it isn't checked: no points for area then). `driveMinutes` is the taught drive
 * time to a nearby listing's area, when there is one. Pure.
 */
export function scorePair(ask: Omit<AutomatchAsk, "id">, l: Listing, o: { areaRelation: AreaRelation | null; now: Date; driveMinutes?: number | null }): Scored {
  const cur = ask.currency;
  const askCategory = categoryOfRequest(ask.type);

  // Both prices in TTD (fx.ts), so a USD ask and a TTD listing compare, and the other way round.
  const lp = listingTtd(l);
  const shownListing = isUsd(l.currency) ? moneyWithTtd(l.price, "USD", l.ttdEquiv) : shortMoney(l.price, "TTD");
  // A range has a floor (budgetMin) and a ceiling (budget); a single figure is the ceiling, and a floor alone has no ceiling.
  const floor = ask.budgetMin ?? null;
  const ceiling = ask.budget ?? null;
  const shownCeiling = ceiling ? (isUsd(cur) ? moneyWithTtd(ceiling, "USD") : shortMoney(ceiling, "TTD")) : "";
  const label = floor && ceiling ? `${shortMoney(floor, cur)}–${shortMoney(ceiling, cur).replace(/^(TT|US)\$/, "")}` : floor ? `${shortMoney(floor, cur)} minimum` : shownCeiling;
  let price: { points: number; text: string };
  if (!floor && !ceiling) price = { points: 0, text: "no budget given" };
  else if (!lp) price = { points: 0, text: "no price listed" };
  else {
    const lowTtd = floor ? ttdValue(floor, cur) : null;
    const highTtd = ceiling ? ttdValue(ceiling, cur) : null;
    if (lowTtd !== null && lp < lowTtd) {
      const under = (lowTtd - lp) / lowTtd;
      price = { points: WEIGHT.price * Math.max(0, 1 - under / PRICE_BAND), text: `${shownListing}, ${Math.round(under * 100)}% under the ${label} budget` };
    } else if (highTtd !== null && lp > highTtd) {
      const over = (lp - highTtd) / highTtd;
      price = { points: WEIGHT.price * Math.max(0, 1 - over / PRICE_BAND), text: `${shownListing}, ${Math.round(over * 100)}% over the ${label} budget` };
    } else price = { points: WEIGHT.price, text: `${shownListing} ${floor ? "fits" : "within"} ${label} budget` };
  }

  let area: { points: number; text: string };
  if (o.areaRelation === "same") area = { points: WEIGHT.area, text: `Same area (${ask.area})` };
  else if (o.areaRelation === "nearby") area = { points: WEIGHT.area / 2, text: nearbyDriveLabel(l.area || "a neighbour", o.driveMinutes ?? null) };
  else area = { points: 0, text: "area not checked" };

  let beds: { points: number; text: string };
  if (ask.beds == null || !l.beds) beds = { points: 0, text: "beds unknown" };
  else {
    const least = ask.beds;
    const most = ask.bedsMax ?? ask.beds;
    const asked = least === most ? `${least}` : `${least}–${most}`;
    if (l.beds >= least && l.beds <= most) {
      beds = { points: WEIGHT.beds, text: least === most ? `${plural(l.beds, "bed")} as asked` : `${plural(l.beds, "bed")} (asked ${asked} beds)` };
    } else {
      // Fewer than the least asked is out (0 points); one more than the most asked is half.
      const gap = l.beds < least ? least - l.beds : l.beds - most;
      beds = { points: l.beds === most + 1 ? WEIGHT.beds / 2 : 0, text: `${plural(l.beds, "bed")}, ${gap === 1 ? "one" : gap} ${l.beds < least ? "fewer" : "more"} than the ${asked} asked` };
    }
  }

  const saleRent = ask.listingType === l.listingType ? WEIGHT.saleRent : 0;
  const kind = !askCategory || categoryOfListing(l) === askCategory ? WEIGHT.kind : 0;

  const posted = ask.postedAt ? Date.parse(ask.postedAt) : Number.NaN;
  const seen = Number.isFinite(posted) ? posted : Date.parse(ask.lastSeenAt);
  let recency: { points: number; text: string };
  if (!Number.isFinite(seen)) recency = { points: 0, text: "posted date unknown" };
  else {
    const days = Math.max(0, (o.now.getTime() - seen) / DAY_MS);
    recency = { points: recencyPoints(days), text: days < 1 ? "posted today" : `posted ${plural(Math.floor(days), "day")} ago` };
  }

  const parts: ScoreParts = { price: price.points, area: area.points, beds: beds.points, saleRent, kind, recency: recency.points };
  return {
    score: totalScore(parts),
    reason: [area.text, beds.text, price.text, recency.text].join(", "),
    parts,
  };
}

/** A row's score from its parts: their sum, rounded and kept to 0–100. */
export function totalScore(parts: ScoreParts): number {
  return Math.min(100, Math.max(0, Math.round(Object.values(parts).reduce((a, b) => a + b, 0))));
}

/** The pairs' order: best score first, then the newer ask, then the listing's title. */
export function sortPairs<T extends AutomatchPair>(pairs: T[]): T[] {
  return pairs.sort((a, b) => b.score - a.score || Date.parse(b.ask.lastSeenAt) - Date.parse(a.ask.lastSeenAt) || a.listing.title.localeCompare(b.listing.title));
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
export function requestOf(a: AutomatchAsk): LiveRequest {
  return { intent: a.listingType === "rent" ? "rent" : "buy", area: a.area, beds: a.beds, bedsMax: a.bedsMax ?? null, propertyType: a.type, priceMin: a.budgetMin ?? null, priceMax: a.budget, currency: a.currency, monthly: false };
}

/** An ask as the duplicate rule reads it (sameDemandAsk, ask-match.ts). */
export function askFactsOf(a: AutomatchAsk): AskFacts {
  return { area: a.area, development: null, beds: a.beds, bedsMax: a.bedsMax ?? null, price: a.budget, currency: a.currency, type: a.type, listingType: a.listingType };
}

/**
 * Every eligible pair, best first (score, then the newer ask, then the listing title). Eligibility and the area tiers are
 * live-match.ts's, so an ask never pairs with a listing of the other kind (sale vs rent), and the same listings come back
 * as matchOurListings would give. An ask with no area is never matched. One pair per ask and listing: a listing that is
 * repeated in the CRM's list is counted once. Area lookups are once per distinct area.
 */
export async function automatchPairs(asks: readonly AutomatchAsk[], listings: readonly Listing[], areas: AreaResolver, now: Date, knowledge: AreaKnowledgeIndex | null = null): Promise<AutomatchPair[]> {
  const out: AutomatchPair[] = [];
  const onceById = [...new Map(listings.map((l) => [l.id, l] as const)).values()];
  const seenAsk = new Set<string>();
  for (const ask of asks) {
    if (!ask.area || seenAsk.has(ask.id)) continue;
    seenAsk.add(ask.id);
    const r = requestOf(ask);
    const fits = onceById.filter((l) => fitsOurListing(r, l));
    if (!fits.length) continue;
    const ctx = await ourAreaContext(ask.area, fits, areas, knowledge);
    for (const l of fits) {
      const rel = ourAreaRelation(ctx, l);
      if (!rel) continue;
      const areaRelation: AreaRelation = rel.tier === "same-area" ? "same" : "nearby";
      const driveMinutes = rel.via === "taught" ? (rel.relMin ?? null) : null;
      out.push({ ...scorePair(ask, l, { areaRelation, now, driveMinutes }), ask, listing: l, areaRelation });
    }
  }
  return sortPairs(out);
}

/**
 * Folds one sender's near-identical asks that hit the same listing into one row. Input is best first (automatchPairs order), so the
 * first pair of a group is the best score and, on a tie, the newer ask; its posts are the sum of the group's posts. Asks with no
 * sender are never folded.
 */
export function foldSameSenderPairs(pairs: readonly AutomatchPair[]): AutomatchGroup[] {
  const out: AutomatchGroup[] = [];
  for (const p of pairs) {
    const posts = p.ask.posts ?? 1;
    const hit = p.ask.sender
      ? out.find((g) => g.listing.id === p.listing.id && g.ask.sender === p.ask.sender && sameDemandAsk(askFactsOf(g.ask), askFactsOf(p.ask)))
      : undefined;
    if (hit) hit.posts += posts;
    else out.push({ ...p, posts });
  }
  return out;
}

/** Pairs in each band before and after folding one sender's near-identical asks (the CLI prints both). */
export function dedupeCounts(pairs: readonly AutomatchPair[]): { strong: { before: number; after: number }; fair: { before: number; after: number } } {
  const before = bandCounts(pairs);
  const after = bandCounts(foldSameSenderPairs(pairs));
  return { strong: { before: before.strong, after: after.strong }, fair: { before: before.fair, after: after.fair } };
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
  /** When the ask was first seen (ISO): the posted date recency is measured from. */
  firstSentAt?: string | null;
  /** The most beds of a range the ask gave (beds is the least). */
  bedsMax?: number | null;
  status?: string | null;
  senderPhone?: string | null;
  timesSeen?: number | null;
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
  return {
    id: d.id,
    area,
    beds: d.beds,
    ...(d.bedsMax != null ? { bedsMax: d.bedsMax } : {}),
    budget: d.price,
    currency: d.currency?.toUpperCase() === "USD" ? "USD" : "TTD",
    type: d.type,
    listingType,
    lastSeenAt: d.lastSentAt,
    ...(d.firstSentAt ? { postedAt: d.firstSentAt } : {}),
    ...(d.senderPhone ? { sender: d.senderPhone } : {}),
    ...(d.timesSeen != null ? { posts: d.timesSeen } : {}),
  };
}

/* ---------------- thin results: what to widen ---------------- */

/** A result is strong with WIDEN_COUNT matches at WIDEN_SCORE or more (so its top is at that too); otherwise it is thin. */
export const WIDEN_SCORE = 70;
export const WIDEN_COUNT = 3;

/** One change that would widen a brief: a stable id, staff-facing words, and the brief fields to merge on (`patch`). */
export type WidenSuggestion = { id: string; label: string; description: string; patch: Record<string, unknown> };

/**
 * The changes that would widen a thin brief, each ready to merge onto the brief, in this order: WhatsApp Inventory, Online Search, the
 * budget ceiling 15% higher (only when there is one), one bedroom fewer (from 2 beds up), and each region a specific place the brief names
 * sits in. Null when the result is strong. `scores` are the returned matches' scores (null where a market gave none). Pure: `regionOf`
 * is the caller's local lookup, and a region the brief already has is not suggested.
 */
export function widenSuggestions(b: {
  sources: readonly string[];
  locations: readonly string[];
  budgetMax: number | null;
  currency: "TTD" | "USD";
  bedrooms: number | null;
  scores: readonly (number | null)[];
  regionOf: (place: string) => string | null;
}): WidenSuggestion[] | null {
  if (b.scores.filter((s) => s != null && s >= WIDEN_SCORE).length >= WIDEN_COUNT) return null;
  const out: WidenSuggestion[] = [];
  if (!b.sources.includes("whatsapp")) out.push({ id: "include-whatsapp", label: "Add WhatsApp Inventory", description: "Also look at the offers posted to WhatsApp.", patch: { sources: [...b.sources, "whatsapp"] } });
  if (!b.sources.includes("online")) out.push({ id: "include-online", label: "Add Online Search", description: "Also look at other agencies' listings.", patch: { sources: [...b.sources, "online"] } });
  if (b.budgetMax != null) {
    const wider = Math.round(b.budgetMax * 1.15);
    out.push({ id: "widen-budget", label: "Raise the budget by 15%", description: `Look up to ${shortMoney(wider, b.currency)} instead of ${shortMoney(b.budgetMax, b.currency)}.`, patch: { budget_max: wider } });
  }
  if (b.bedrooms != null && b.bedrooms >= 2) out.push({ id: "relax-bedrooms", label: "Allow one bedroom fewer", description: `Also look at homes with ${b.bedrooms - 1} bedrooms.`, patch: { bedrooms_min: b.bedrooms - 1 } });
  const seen = new Set(b.locations.map(areaKey));
  for (const place of b.locations) {
    if (parseRegion(place) || isCentralAreaGroup(place) || /^(trinidad|tobago)$/i.test(place)) continue;
    const region = b.regionOf(place);
    if (!region || seen.has(areaKey(region))) continue;
    seen.add(areaKey(region));
    out.push({ id: `expand-region-${region.toLowerCase().replace(/[^a-z]+/g, "-")}`, label: `Add ${region} to the location`, description: `${place} is in ${region}: also look across ${region}.`, patch: { location: [...b.locations, region] } });
  }
  return out;
}
