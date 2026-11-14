import type { ToolCaller } from "./areas.ts";
import { moneyLabel } from "./market-search.ts";
import { listingTypeOf, type Facts } from "./periskope.ts";
import { parseMatch, type MatchItem } from "./recommendations.ts";
import { jsonHits, readOnlyCall, timedOut } from "./requests.ts";

/**
 * Real-time matching for a buyer request that arrives from the agents' WhatsApp group (Periskope intake,
 * realty/node/periskope-intake.ts). When a request is taken, it is matched once against other agencies' market
 * listings with the market's match_buyer tool, and the top few are stored with the market's short reason line.
 *
 * The co-broke rules are the market's (tt-market-search src/match/score.ts): same island, same or neighbouring
 * area, price within 20% of the budget, beds within one, sale vs rent, compatible type. 1on1 scoring is not
 * decided yet, so nothing is scored here: scores and grades are dropped (parseMatch), only the listing and the
 * reason are kept. Our own CRM listings are not part of this until the CRM is connected (crm-seam.ts).
 *
 * Read only: match_buyer is on the desk's read-only list (DESK_TOOLS). Nothing is sent to anyone.
 * Portable: no node:*, no next, no bare process.
 */

/** How many matches are kept per request. */
export const LIVE_LIMIT = 5;

/** The market's property_type values. Other kinds of place are sent as free text (the tool accepts it). */
const MARKET_TYPES: Record<string, string> = { house: "house", townhouse: "townhouse", apartment: "apartment", condo: "apartment", land: "land", commercial: "commercial" };

/** A WhatsApp buyer request as stored and shown: structured facts only, never the message text. */
export type LiveRequest = {
  intent: "buy" | "rent" | null;
  area: string | null;
  beds: number | null;
  propertyType: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: "TTD" | "USD" | null;
  monthly: boolean;
};

export type LiveMatchStatus =
  | "matched" // match_buyer answered (the list may be empty)
  | "no-intent" // the message didn't say buy or rent, and the budget didn't tell us either, so match_buyer can't take it
  | "not-configured" // market search isn't set up on this server
  | "timeout"
  | "unavailable";

export type LiveMatchResult = { status: LiveMatchStatus; matches: MatchItem[] };

/** The request from the parser's facts. Intent falls back to sale/rent from the budget (listingTypeOf). */
export function liveRequestOf(f: Facts): LiveRequest {
  const type = listingTypeOf(f);
  return {
    intent: type === "rent" ? "rent" : type === "sale" ? "buy" : null,
    area: f.area,
    beds: f.beds,
    propertyType: f.type,
    priceMin: f.budget?.min ?? null,
    priceMax: f.budget?.max ?? null,
    currency: f.budget?.currency ?? null,
    monthly: f.budget?.monthly ?? false,
  };
}

/** match_buyer's arguments: a buyer with only the fields the request has. beds_min alone: the market allows one either way. */
export function liveBuyerArgs(r: LiveRequest, ref: string, postedAt: string): Record<string, unknown> {
  const buyer: Record<string, unknown> = { intent: r.intent, ref, posted_at: postedAt };
  if (r.area) buyer.area = r.area;
  if (r.priceMin !== null) buyer.price_min = r.priceMin;
  if (r.priceMax !== null) buyer.price_max = r.priceMax;
  if (r.currency) buyer.currency = r.currency;
  if (r.beds !== null) buyer.beds_min = r.beds;
  if (r.propertyType) buyer.property_type = MARKET_TYPES[r.propertyType] ?? r.propertyType;
  return { buyer, limit: LIVE_LIMIT };
}

/** One match_buyer call. Never throws: a failure is a status. */
export async function matchOnArrival(r: LiveRequest, ref: string, postedAt: string, caller: ToolCaller | null): Promise<LiveMatchResult> {
  if (!r.intent) return { status: "no-intent", matches: [] };
  if (!caller) return { status: "not-configured", matches: [] };
  try {
    const hits = jsonHits(await readOnlyCall(caller, "match_buyer", liveBuyerArgs(r, ref, postedAt)));
    if (!hits) return { status: "unavailable", matches: [] };
    const matches = hits.flatMap((h) => {
      const m = parseMatch(h);
      return m ? [m.item] : [];
    });
    return { status: "matched", matches: matches.slice(0, LIVE_LIMIT) };
  } catch (err) {
    return { status: timedOut(err) ? "timeout" : "unavailable", matches: [] };
  }
}

/** The request in staff terms, e.g. "rent · 2 bed apartment · Westmoorings · up to TT$9,000 a month". */
export function requestLabel(r: LiveRequest): string {
  const what = [r.beds !== null ? `${r.beds} bed` : null, r.propertyType].filter(Boolean).join(" ");
  const money = (n: number) => moneyLabel(n, r.currency) ?? String(n);
  const budget =
    r.priceMax !== null
      ? `${r.priceMin !== null ? `${money(r.priceMin)} – ` : "up to "}${money(r.priceMax)}${r.monthly ? " a month" : ""}`
      : null;
  return [r.intent, what || null, r.area, budget].filter(Boolean).join(" · ") || "Buyer request";
}

/** What staff read for a status other than a list of matches. */
export const STATUS_TEXT: Record<Exclude<LiveMatchStatus, "matched">, string> = {
  "no-intent": "Not matched: the message didn't say buy or rent.",
  "not-configured": "Not matched: market search isn't set up on this server.",
  timeout: "Not matched: the market search didn't answer in time.",
  unavailable: "Not matched: the market search was unavailable.",
};
