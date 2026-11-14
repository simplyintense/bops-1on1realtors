import { areaTier, refFor, type AreaResolver, type ToolCaller } from "./areas.ts";
import type { SeamAgent } from "./crm-seam.ts";
import { moneyLabel } from "./market-search.ts";
import { listingTypeOf, type Facts } from "./periskope.ts";
import { parseMatch, type MatchItem } from "./recommendations.ts";
import { followUpsOf, isHidden, listingKey, type FollowUp, type StatusRow } from "./match-status.ts";
import type { Listing } from "./source.ts";
import { jsonHits, readOnlyCall, timedOut } from "./requests.ts";

/**
 * Real-time matching for a buyer request that arrives from the agents' WhatsApp group (Periskope intake,
 * realty/node/periskope-intake.ts). When a request is taken, it is matched once against other agencies' market
 * listings with the market's match_buyer tool, and the top few are stored with the market's short reason line.
 *
 * The co-broke rules are the market's (tt-market-search src/match/score.ts): same island, same or neighbouring
 * area, price within 20% of the budget, beds within one, sale vs rent, compatible type. 1on1 scoring is not
 * decided yet, so nothing is scored here: scores and grades are dropped (parseMatch), only the listing and the
 * reason are kept. Our own CRM listings (crm-seam.ts) are matched here with the same rules, by matchOurListings, and
 * kept apart as `ours`, each with the CRM agent holding it.
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

/** A stored request as the desk and digest read it (realty/node/periskope-store.ts LiveRow has these and more). */
export type LiveEntry = {
  messageId: string;
  /** The desk's id for the request: a hash of messageId (realty/node/periskope-store.ts requestIdOf). What the pages and buttons carry. */
  requestId: string;
  /** The posting agent's own number, normalized. Used only to tie a request to an agent; never shown. */
  senderPhone: string;
  receivedAt: string;
  request: LiveRequest;
  status: LiveMatchStatus | "pending";
  /** Other agencies' listings, from the market. */
  matches: MatchItem[];
  /** Our own CRM listings, each with its holder. Missing on rows stored before the CRM was connected. */
  ours?: MatchItem[];
};

/**
 * A request with its matches, as a page shows it: no phone number, no WhatsApp message id, no message text. `follow` is the
 * follow-up of each listing on it, by listingKey.
 */
export type LiveCard = {
  requestId: string;
  label: string;
  receivedAt: string;
  status: LiveMatchStatus | "pending";
  statusText: string | null;
  matches: MatchItem[];
  ours: MatchItem[];
  follow: Record<string, FollowUp>;
};

/** `statuses`: the follow-ups to show. `hideMarked`: drop matches marked not a fit or closed (and a request left with none). */
export type CardOptions = { statuses?: readonly StatusRow[]; hideMarked?: boolean };

/** Newest first, at most `limit`. */
export function liveCards(rows: readonly LiveEntry[], limit = 10, o: CardOptions = {}): LiveCard[] {
  return [...rows]
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
    .flatMap((r) => {
      const follow = followUpsOf(o.statuses ?? [], r.requestId);
      const keep = (m: MatchItem) => !(o.hideMarked && isHidden(follow[listingKey(m)]));
      const matches = r.matches.filter(keep);
      const ours = (r.ours ?? []).filter(keep);
      // A request whose matches are all marked goes too; one that never had a match stays ("nothing fits").
      if (o.hideMarked && r.matches.length + (r.ours ?? []).length > 0 && !matches.length && !ours.length) return [];
      return [{ requestId: r.requestId, label: requestLabel(r.request), receivedAt: r.receivedAt, status: r.status, statusText: r.status === "matched" ? null : r.status === "pending" ? "Matching hasn't finished." : STATUS_TEXT[r.status], matches, ours, follow }];
    })
    .slice(0, limit);
}

/* ---------------- Our own listings ---------------- */

export const OUR_AGENCY = "1on1 Realtors";
/** The market's price band: a listing's price within 20% of the budget. */
export const PRICE_BAND = 0.2;

type Category = "land" | "commercial" | "residential";
const categoryOfRequest = (t: string | null): Category | null => (t === "land" || t === "commercial" ? t : t ? "residential" : null);
/**
 * The CRM files some land and storage under "Residential", so a title that says land, a lot, storage, a warehouse or an
 * office decides when the CRM's kind says residential.
 */
const LAND_TITLE = /\b(land|lots?|acres?)\b/i;
const COMMERCIAL_TITLE = /\b(storage|warehouse|office|commercial|retail|shop|bond)\b/i;
const categoryOfListing = (l: Listing): Category => {
  if (l.propertyKind === "land" || l.propertyKind === "commercial") return l.propertyKind;
  if (LAND_TITLE.test(l.title)) return "land";
  if (COMMERCIAL_TITLE.test(l.title)) return "commercial";
  return "residential";
};

/**
 * Our active CRM listings that fit the request, by the market's co-broke rules with no scoring: sale vs rent; same or a
 * nearby area (same-area or neighbour tier, same island; same region alone isn't nearby); price within 20% of the budget
 * either way (from 20% under the least to 20% over the most; a single figure is both) in the same currency; beds within
 * one; and the same kind of place (land, commercial or residential). A field the listing doesn't give (no price, no beds)
 * can't be checked, so it passes, as on the market. Same area first, then nearby, then the price closest to the budget. Never throws: an area that can't be resolved only matches its own name.
 */
const gap = (price: number, budget: number) => (price ? Math.abs(price - budget) : Infinity);

export async function matchOurListings(r: LiveRequest, listings: readonly Listing[], areas: AreaResolver, limit = LIVE_LIMIT): Promise<MatchItem[]> {
  if (!r.intent || !r.area) return [];
  const type = r.intent === "rent" ? "rent" : "sale";
  const cat = categoryOfRequest(r.propertyType);
  const top = r.priceMax ?? r.priceMin;
  const bottom = r.priceMin ?? r.priceMax;
  const hi = top !== null ? top * (1 + PRICE_BAND) : null;
  const lo = bottom !== null ? bottom * (1 - PRICE_BAND) : null;
  const budget = top ?? 0;
  const fits = listings.filter(
    (l) =>
      l.status === "active" &&
      l.listingType === type &&
      (!cat || categoryOfListing(l) === cat) &&
      (!l.price || ((hi === null && lo === null) || (l.currency === (r.currency ?? "TTD") && (hi === null || l.price <= hi) && (lo === null || l.price >= lo)))) &&
      (r.beds === null || !l.beds || Math.abs(l.beds - r.beds) <= 1),
  );
  if (!fits.length) return [];
  const want = await refFor(areas, r.area);
  // One lookup per distinct area, not per listing.
  const refs = new Map<string, Awaited<ReturnType<typeof refFor>>>();
  for (const a of new Set(fits.map((l) => l.area).filter(Boolean))) refs.set(a, await refFor(areas, a));
  const ranked = fits.flatMap((l) => {
    const ref = refs.get(l.area);
    if (!ref) return [];
    const v = areaTier(want, ref);
    return v.tier === "same-area" || v.tier === "neighbour" ? [{ l, v }] : [];
  });
  ranked.sort((a, b) => (a.v.tier === b.v.tier ? 0 : a.v.tier === "same-area" ? -1 : 1) || gap(a.l.price, budget) - gap(b.l.price, budget));
  return ranked.slice(0, limit).map(({ l, v }) => ({
    title: l.title || `${OUR_AGENCY} listing ${l.id}`,
    url: /^https?:\/\//i.test(l.url) ? l.url : null,
    area: l.area || null,
    price: l.price ? moneyLabel(l.price, l.currency) : null,
    beds: l.beds || null,
    source: OUR_AGENCY,
    reason: ourReason(r, l, v.tier === "same-area" ? `in ${l.area}` : `${l.area}, near ${r.area}`),
    holder: l.agentId > 0 ? l.agentId : null,
  }));
}

function ourReason(r: LiveRequest, l: Listing, where: string): string {
  const money = (n: number) => moneyLabel(n, l.currency) ?? String(n);
  const budget = r.priceMax !== null ? money(r.priceMax) : r.priceMin !== null ? `from ${money(r.priceMin)}` : null;
  const price = !l.price ? "no price listed" : budget ? `${money(l.price)} for a ${budget} budget` : money(l.price);
  return [where, price, l.beds ? `${l.beds} bed` : null, "our listing"].filter(Boolean).join(", ");
}

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

/**
 * The live side of the desk, for the signed-in person (matched to a CRM agent by email):
 *   yours       their own WhatsApp requests (by the agent's number) with every match
 *   onListings  anyone's requests that matched a listing they hold (only those matches of ours are shown)
 *   unassigned  owners only: requests from a number that isn't one of our agents
 *   unheld      owners only: requests that matched one of our listings with no agent assigned
 * For anyone who isn't an owner, unassigned and unheld are null, so those requests aren't in the view at all.
 */
export type LiveDesk = {
  yours: { status: "signed-out" } | { status: "no-agent" } | { status: "ok"; phoneKnown: boolean; cards: LiveCard[] };
  onListings: LiveCard[];
  unassigned: LiveCard[] | null;
  unheld: LiveCard[] | null;
};

export function liveDesk(i: { email: string | null; owner: boolean; agents: readonly SeamAgent[]; rows: readonly LiveEntry[]; statuses?: readonly StatusRow[]; showHidden?: boolean }): LiveDesk {
  const o: CardOptions = { statuses: i.statuses, hideMarked: !i.showHidden };
  const phones = new Set(i.agents.flatMap((a) => (a.phone ? [a.phone] : [])));
  const email = i.email?.trim().toLowerCase() ?? null;
  const me = email ? (i.agents.find((a) => a.email === email) ?? null) : null;
  const yours: LiveDesk["yours"] = !email
    ? { status: "signed-out" }
    : !me
      ? { status: "no-agent" }
      : { status: "ok", phoneKnown: !!me.phone, cards: me.phone ? liveCards(i.rows.filter((r) => r.senderPhone === me.phone), 10, o) : [] };
  const keepOurs = (keep: (m: MatchItem) => boolean) => (rows: readonly LiveEntry[]) =>
    rows.flatMap((r) => {
      const ours = (r.ours ?? []).filter(keep);
      return ours.length ? [{ ...r, ours, matches: [] }] : [];
    });
  const mine = me ? keepOurs((m) => m.holder === me.id)(i.rows.filter((r) => r.senderPhone !== me.phone)) : [];
  return {
    yours,
    onListings: liveCards(mine, 10, o),
    unassigned: i.owner ? liveCards(i.rows.filter((r) => !phones.has(r.senderPhone)), 10, o) : null,
    unheld: i.owner ? liveCards(keepOurs((m) => m.holder == null)(i.rows), 10, o) : null,
  };
}

/** The owners' daily digest: the requests that came in over the last `hours`, how many found matches, and the cards. */
export type Digest = {
  since: string;
  until: string;
  requests: number;
  /** Requests with at least one match. */
  withMatches: number;
  /** Matched, but nothing fits yet. */
  noMatches: number;
  /** Not matched: no intent, market not set up, or the market failed. */
  notMatched: number;
  cards: LiveCard[];
};

/** Every request in the window, with every match and its follow-up (nothing is hidden in the digest). */
export function digestOf(rows: readonly LiveEntry[], now: Date, hours = 24, statuses: readonly StatusRow[] = []): Digest {
  const since = new Date(now.getTime() - hours * 3_600_000);
  const recent = rows.filter((r) => {
    const t = Date.parse(r.receivedAt);
    return t >= since.getTime() && t <= now.getTime();
  });
  return {
    since: since.toISOString(),
    until: now.toISOString(),
    requests: recent.length,
    withMatches: recent.filter((r) => r.status === "matched" && r.matches.length > 0).length,
    noMatches: recent.filter((r) => r.status === "matched" && r.matches.length === 0).length,
    notMatched: recent.filter((r) => r.status !== "matched").length,
    cards: liveCards(recent, 50, { statuses }),
  };
}
