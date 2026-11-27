import { areasForMatch, developmentOf, namesPlace, WEST_HILLS_UNCONFIRMED_NEIGHBOURS } from "../extract.ts";
import { knowledgeOf, nearbyByKnowledge, nearbyReason, type AreaKnowledgeIndex } from "./area-knowledge.ts";
import { areaTier, islandNamedIn, parseRegion, refFor, type AreaRef, type AreaResolver, type Island, type Region, type ToolCaller } from "./areas.ts";
import type { SeamAgent } from "./crm-seam.ts";
import { isUsd, moneyWithTtd, ttdValue } from "./fx.ts";
import { moneyLabel } from "./market-search.ts";
import { nearbyDriveLabel, taughtVerdict, type TaughtVerdict } from "./taught-areas.ts";
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
export const categoryOfRequest = (t: string | null): Category | null => (t === "land" || t === "commercial" ? t : t ? "residential" : null);
/**
 * The CRM files some land and storage under "Residential", so a title that says land, a lot, storage, a warehouse or an
 * office decides when the CRM's kind says residential.
 */
const LAND_TITLE = /\b(land|lots?|acres?)\b/i;
const COMMERCIAL_TITLE = /\b(storage|warehouse|office|commercial|retail|shop|bond)\b/i;
export const categoryOfListing = (l: Listing): Category => {
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
/** The request's budget in TTD (its top figure, or its only one), 0 when it gives none. */
const budgetTtdOf = (r: LiveRequest) => ttdValue((r.priceMax ?? r.priceMin) ?? 0, r.currency);

/**
 * A listing's price in TTD, the one currency every comparison uses (fx.ts). A USD listing uses the CRM's TTD equivalent when it
 * has one, else the price at USD_TO_TTD. 0 when the listing gives no price.
 */
export function listingTtd(l: Pick<Listing, "price" | "currency" | "ttdEquiv">): number {
  if (!l.price) return 0;
  return isUsd(l.currency) ? l.ttdEquiv || ttdValue(l.price, l.currency) : l.price;
}

/** A listing's price as shown: TT$ as it is; a USD listing as "US$500k ≈ TT$3.39m" (the CRM's TTD equivalent when it has one). */
export function listingPriceLabel(l: { price: number | null; currency: string; ttdEquiv?: number | null }): string | null {
  if (!l.price) return null;
  return isUsd(l.currency) ? moneyWithTtd(l.price, l.currency, l.ttdEquiv) : moneyLabel(l.price, "TTD");
}

const areaTextKey = (s: string) => s.replace(/[–—]/g, "-").trim().replace(/\s+/g, " ").toLowerCase();

/** A listing in Glencoe is not a West Hills match until Miles confirms, even though sources put them in the same west cluster. */
function blockedWestHillsGlencoe(requestArea: string, l: Listing): boolean {
  const d = developmentOf(requestArea);
  if (d?.name !== "West Hills") return false;
  const hay = `${l.area ?? ""} ${l.title ?? ""}`;
  if (d.aliases.some((a) => namesPlace(hay, a)) || namesPlace(hay, d.name)) return false;
  return WEST_HILLS_UNCONFIRMED_NEIGHBOURS.some((n) => namesPlace(hay, n));
}

function gazetteerTier(requestArea: string, l: Listing): { tier: "same-area" | "neighbour" } | null {
  const { same, nearby } = areasForMatch(requestArea);
  const hay = `${l.area ?? ""} ${l.title ?? ""}`;
  const areaK = areaTextKey(l.area ?? "");
  const hit = (name: string) => areaK === areaTextKey(name) || namesPlace(hay, name);
  const d = developmentOf(requestArea);
  if (same.some(hit) || (d && d.aliases.some((a) => namesPlace(hay, a)))) return { tier: "same-area" };
  if (nearby.some(hit)) return { tier: "neighbour" };
  return null;
}

/**
 * One of our listings against the request, on the rules that don't need the area: active, sale vs rent, the same kind of
 * place, price within PRICE_BAND of the budget in the same currency, beds within one. A field the listing doesn't give
 * (no price, no beds) can't be checked, so it passes. Shared by matchOurListings and automatch.ts.
 */
export function fitsOurListing(r: LiveRequest, l: Listing): boolean {
  const type = r.intent === "rent" ? "rent" : "sale";
  const cat = categoryOfRequest(r.propertyType);
  const top = r.priceMax ?? r.priceMin;
  const bottom = r.priceMin ?? r.priceMax;
  const cp = listingTtd(l);
  const hi = top !== null ? ttdValue(top, r.currency) * (1 + PRICE_BAND) : null;
  const lo = bottom !== null ? ttdValue(bottom, r.currency) * (1 - PRICE_BAND) : null;
  return (
    l.status === "active" &&
    l.listingType === type &&
    (!cat || categoryOfListing(l) === cat) &&
    (!cp || ((hi === null || cp <= hi) && (lo === null || cp >= lo))) &&
    (r.beds === null || !l.beds || Math.abs(l.beds - r.beds) <= 1)
  );
}

/** How one of our listings' area relates to the request's: the same area, or a neighbour (taught, by the directory, or by coordinates). */
export type OurAreaRelation = { tier: "same-area" | "neighbour"; via?: "knowledge" | "taught"; relKm?: number; relMin?: number };

/**
 * The request's area, its island (null when unknown), the areas wanted (same and nearby), and each listing area's ref. Built once per request.
 */
export type OurAreaContext = { area: string; island: Island | null; wants: AreaRef[]; refs: Map<string, AreaRef>; knowledge: AreaKnowledgeIndex | null };

/** The lookups for the area rules, for the listings that already fit (fitsOurListing). One lookup per distinct area. */
export async function ourAreaContext(area: string, listings: readonly Listing[], areas: AreaResolver, knowledge: AreaKnowledgeIndex | null = null): Promise<OurAreaContext> {
  const plan = areasForMatch(area);
  const wantsSame = await Promise.all(plan.same.map((name) => refFor(areas, name)));
  const wantsNear = await Promise.all(plan.nearby.map((name) => refFor(areas, name)));
  const refs = new Map<string, AreaRef>();
  for (const a of new Set(listings.map((l) => l.area).filter(Boolean))) refs.set(a, await refFor(areas, a));
  const island = wantsSame[0]?.match?.island ?? islandNamedIn(area);
  return { area, island, wants: [...wantsSame, ...wantsNear], refs, knowledge };
}

/** The island of a listing's area: the directory's, else the one its name spells out. */
function islandOfListing(ctx: OurAreaContext, l: Listing): Island | null {
  return ctx.refs.get(l.area)?.match?.island ?? islandNamedIn(l.area ?? "");
}

/** The request's development named by the listing (its area, title or an alias): the same development stays the same area. */
function developmentNamed(requestArea: string, l: Listing): boolean {
  const d = developmentOf(requestArea);
  if (!d) return false;
  const hay = `${l.area ?? ""} ${l.title ?? ""}`;
  return areaTextKey(l.area ?? "") === areaTextKey(d.name) || namesPlace(hay, d.name) || d.aliases.some((a) => namesPlace(hay, a));
}

/** Both areas taught: the taught pair decides. A development named by the listing stays the same area, as before. */
function taughtRelation(area: string, l: Listing, v: TaughtVerdict): OurAreaRelation | null {
  if (v.tier === "same") return { tier: "same-area" };
  if (developmentNamed(area, l)) return { tier: "same-area" };
  if (v.tier === "nearby") return { tier: "neighbour", via: "taught", relKm: v.km ?? undefined, relMin: v.minutes ?? undefined };
  return null;
}

/**
 * A region asked for by name ("Central", "North West", "Port of Spain"…): a listing is in it when the resolver puts the listing's
 * area in that region, or when the listing is named by the region itself. Nothing is matched by title, and no gazetteer
 * neighbours apply, so "Central" never reaches North West or Port of Spain places.
 */
function regionRelation(region: Region, area: string, l: Listing, ref: AreaRef | undefined): OurAreaRelation | null {
  if (areaTextKey(l.area ?? "") === areaTextKey(area)) return { tier: "same-area" };
  return ref?.match?.region === region ? { tier: "same-area" } : null;
}

/** The listing's area relation to the request's area, or null when it is neither the same nor a nearby area. */
export function ourAreaRelation(ctx: OurAreaContext, l: Listing): OurAreaRelation | null {
  const { area, knowledge } = ctx;
  const region = parseRegion(area);
  if (region) return regionRelation(region, area, l, ctx.refs.get(l.area));
  // The island is checked before any name rule: a text match (or a taught or coordinate pair) never reaches across the water.
  const listingIsland = islandOfListing(ctx, l);
  if (ctx.island && listingIsland && ctx.island !== listingIsland) return null;
  const taught = area && l.area ? taughtVerdict(knowledge?.taught, area, l.area) : null;
  if (taught) return taughtRelation(area, l, taught);
  // Without coordinates, Glencoe stays out of West Hills matches. With knowledge, it may be a nearby recommendation, never a very-strong alert.
  const known = area && l.area ? nearbyByKnowledge(knowledge, area, l.area) : null;
  const bothCoords = !!(knowledge && knowledgeOf(knowledge, area)?.coords && l.area && knowledgeOf(knowledge, l.area)?.coords);
  if (!bothCoords && blockedWestHillsGlencoe(area, l)) return null;
  let best: OurAreaRelation | null = gazetteerTier(area, l);
  if (bothCoords) {
    if (best?.tier === "same-area") {
      /* same development or area stays exact */
    } else if (known) {
      best = { tier: "neighbour", via: "knowledge", relKm: known.km, relMin: known.minutes };
    } else {
      best = null;
    }
  }
  const ref = ctx.refs.get(l.area);
  if (!best && !bothCoords && ref) {
    for (const want of ctx.wants) {
      const v = areaTier(want, ref);
      if (v.tier === "same-area") {
        best = { tier: "same-area" };
        break;
      }
      if (v.tier === "neighbour" && best?.tier !== "same-area") best = { tier: "neighbour" };
    }
  }
  return best;
}

export async function matchOurListings(r: LiveRequest, listings: readonly Listing[], areas: AreaResolver, limit = LIVE_LIMIT, knowledge: AreaKnowledgeIndex | null = null): Promise<MatchItem[]> {
  if (!r.intent || !r.area) return [];
  const area = r.area;
  const budget = budgetTtdOf(r);
  const fits = listings.filter((l) => fitsOurListing(r, l));
  if (!fits.length) return [];
  const ctx = await ourAreaContext(area, fits, areas, knowledge);
  const ranked = fits.flatMap((l) => {
    const v = ourAreaRelation(ctx, l);
    return v ? [{ l, v }] : [];
  });
  ranked.sort((a, b) => (a.v.tier === b.v.tier ? 0 : a.v.tier === "same-area" ? -1 : 1) || gap(listingTtd(a.l), budget) - gap(listingTtd(b.l), budget));
  return ranked.slice(0, limit).map(({ l, v }) => ({
    title: l.title || `${OUR_AGENCY} listing ${l.id}`,
    url: /^https?:\/\//i.test(l.url) ? l.url : null,
    area: l.area || null,
    price: listingPriceLabel(l),
    beds: l.beds || null,
    source: OUR_AGENCY,
    reason:
      v.via === "taught"
        ? ourReason(r, l, nearbyDriveLabel(l.area || "", v.relMin))
        : v.via === "knowledge"
          ? nearbyReason(l.area || "", r.area || "", v.relMin != null ? { name: l.area || "", km: v.relKm ?? 0, minutes: v.relMin } : null, true)
          : ourReason(r, l, v.tier === "same-area" ? `in ${l.area}` : `${l.area}, near ${r.area}`),
    holder: l.agentId > 0 ? l.agentId : null,
  }));
}

function ourReason(r: LiveRequest, l: Listing, where: string): string {
  const money = (n: number, c: string) => moneyLabel(n, c) ?? String(n);
  const budget = r.priceMax !== null ? money(r.priceMax, r.currency ?? "TTD") : r.priceMin !== null ? `from ${money(r.priceMin, r.currency ?? "TTD")}` : null;
  const shown = listingPriceLabel(l);
  const price = !shown ? "no price listed" : budget ? `${shown} for a ${budget} budget` : shown;
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

/**
 * Whether a pair (a request and a listing) is on this person's desk: the cards liveDesk built for them (their own requests, and
 * the matches on listings they hold). Used to refuse a status for a match the desk wouldn't show them (realty/node/match-status.ts).
 */
export function deskHolds(desk: LiveDesk, requestId: string, listing: string): boolean {
  const cards = [...(desk.yours.status === "ok" ? desk.yours.cards : []), ...desk.onListings];
  return cards.some((c) => c.requestId === requestId && [...c.matches, ...c.ours].some((m) => listingKey(m) === listing));
}
