import { emailAllowed } from "../../lib/gate.ts";
import type { ToolCaller } from "./areas.ts";
import { httpUrl, moneyLabel, priceOf } from "./market-search.ts";
import { budgetLabel, jsonHits, numish, readOnlyCall, sortRequests, timedOut, type BuyerRequest, type RequestsResult } from "./requests.ts";

/**
 * "Top recommendations for you" on the staff desk (app/realty/desk). Read only, and it never invents a match.
 *
 * Buyer side (live now): match_buyer for the newest few open buyer requests, each with that request's own fields as the
 * buyer. It scores other agencies' market listings, so it needs no CRM inventory. Scores and grades are dropped here, not
 * just hidden on the page: a match is its listing, the reason the market gave, and the request it's for.
 *
 * CRM side (not connected yet): match_requests needs a real listings array. With none, recommendationsFor says
 * { status: "missing", missing: "crm-listings" } and calls neither match_requests nor score_matches. A CRM listings provider
 * plugs in by passing its listings as `listings`.
 *
 * Owners only: these are other agencies' requests, not the signed-in agent's own, so the whole buyer side is for owners
 * (BOPS_OWNER_EMAILS, passed in as `owners` and checked with emailAllowed). For anyone else it is { status: "owners-only" },
 * match_buyer isn't called, and nothing from it is in the view. An agent's own WhatsApp requests are the live side
 * (live-match.ts liveDesk). A match whose route_to is missing or "unassigned" (and who has no holder_agent) is unassigned.
 * Nobody else's email is ever in the view.
 *
 * Portable: no node:*, no next, no bare process.
 */

export const CRM_MISSING_TEXT =
  "1on1 CRM listings aren't connected yet (no CRM credentials on this server), so requests can't be scored against our inventory.";

/** How many of the newest open requests get a live match, and how many matches each asks for. */
export const BUYER_REQUESTS = 3;
export const BUYER_LIMIT = 5;

/** A CRM listing. Its shape comes with the CRM provider; nothing supplies these yet. Needs an id. */
export type DeskListing = { id: string } & Record<string, unknown>;

export type MatchItem = {
  title: string;
  url: string | null;
  area: string | null;
  price: string | null;
  beds: number | null;
  /** The agency the listing came from, as the market gives it. */
  source: string | null;
  /** Why the market matched it, with phone numbers and emails taken out. Never a score or a grade. */
  reason: string | null;
};

export type BuyerMatch = MatchItem & {
  /** The request this match is for, in the terms staff read it in. */
  forRequest: { area: string | null; budget: string | null; beds: number | null; intent: "buy" | "rent" | null; propertyType: string | null };
};

export type Recommendations = {
  listings:
    | { status: "missing"; missing: "crm-listings" }
    | { status: "not-configured" }
    | { status: "error" }
    | { status: "ok"; items: MatchItem[] };
  buyers:
    | { status: "owners-only" }
    | { status: "not-configured" }
    | { status: "error"; reason: "timeout" | "unavailable" }
    | { status: "no-requests" }
    | { status: "ok"; matches: BuyerMatch[] };
  /** Whether the signed-in person is an owner. */
  owner: boolean;
  /** Owners only: matches nobody is routed to yet. null for everyone else (they are not in the view at all). */
  unassigned: BuyerMatch[] | null;
};

export type RecommendationsInput = {
  /** The signed-in email from the gate's session, or null. Used only to check the owner list; never shown. */
  email: string | null;
  /** BOPS_OWNER_EMAILS, parsed with parseAllowlist (lib/gate.ts). */
  owners: string[];
  /** CRM listings, when a provider has them. Empty or absent means "missing". */
  listings?: DeskListing[] | null;
  /** The buyer requests (searchRequests). */
  requests: RequestsResult;
  /** The market client, or null when market search isn't configured. */
  caller: ToolCaller | null;
};

export async function recommendationsFor(input: RecommendationsInput): Promise<Recommendations> {
  const owner = !!input.email && emailAllowed(input.email, input.owners);
  const buyers: BuyerSide = owner ? await buyerSide(input) : { buyers: { status: "owners-only" }, unassigned: [] };
  return {
    listings: await listingSide(input),
    buyers: buyers.buyers,
    owner,
    unassigned: owner ? buyers.unassigned : null,
  };
}

/* ---------------- Buyers: match_buyer for the newest open requests ---------------- */

type BuyerSide = { buyers: Recommendations["buyers"]; unassigned: BuyerMatch[] };

/** The requests with an intent, newest first: the ones match_buyer can take. */
function usableRequests(rows: BuyerRequest[]): BuyerRequest[] {
  return sortRequests(rows, { key: "date", dir: "desc" })
    .filter((q) => q.intent)
    .slice(0, BUYER_REQUESTS);
}

async function buyerSide(input: RecommendationsInput): Promise<BuyerSide> {
  const r = input.requests;
  if (r.status === "not-configured") return { buyers: { status: "not-configured" }, unassigned: [] };
  if (r.status === "error") return { buyers: { status: "error", reason: r.reason }, unassigned: [] };
  const newest = usableRequests(r.rows);
  if (!newest.length) return { buyers: { status: "no-requests" }, unassigned: [] };
  const caller = input.caller;
  if (!caller) return { buyers: { status: "not-configured" }, unassigned: [] };

  const settled = await Promise.allSettled(
    newest.map((q) => readOnlyCall(caller, "match_buyer", buyerArgs(q)).then((res) => ({ q, hits: jsonHits(res) }))),
  );
  const failed: unknown[] = [];
  const found: { item: MatchItem; routed: boolean; q: BuyerRequest }[] = [];
  for (const s of settled) {
    if (s.status === "rejected") {
      failed.push(s.reason);
      continue;
    }
    if (!s.value.hits) {
      failed.push(new Error("no hits"));
      continue;
    }
    for (const h of s.value.hits) {
      const m = parseMatch(h);
      if (m) found.push({ ...m, q: s.value.q });
    }
  }
  if (failed.length === newest.length) {
    return { buyers: { status: "error", reason: failed.every(timedOut) ? "timeout" : "unavailable" }, unassigned: [] };
  }

  // The same listing can match more than one request: show it once, for the first (newest) request.
  const seen = new Set<string>();
  const unique = found.filter((f) => {
    const k = f.item.url ?? `${f.item.title}|${f.item.source ?? ""}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const view = (f: (typeof unique)[number]): BuyerMatch => ({ ...f.item, forRequest: forRequest(f.q) });
  return {
    buyers: { status: "ok", matches: unique.filter((f) => f.routed).map(view) },
    unassigned: unique.filter((f) => !f.routed).map(view),
  };
}

/** match_buyer wants a `buyer` object (intent is required) plus an optional limit. Only the fields the request has are sent on the buyer. */
export function buyerArgs(q: BuyerRequest): Record<string, unknown> {
  const buyer: Record<string, unknown> = { intent: q.intent };
  if (q.ref) buyer.ref = q.ref;
  if (q.area) buyer.area = q.area;
  if (q.priceMin !== null) buyer.price_min = q.priceMin;
  if (q.priceMax !== null) buyer.price_max = q.priceMax;
  if (q.currency) buyer.currency = q.currency;
  if (q.bedsMin !== null) buyer.beds_min = q.bedsMin;
  if (q.propertyType) buyer.property_type = q.propertyType;
  if (q.receivedAt) buyer.posted_at = q.receivedAt;
  return { buyer, limit: BUYER_LIMIT };
}

function forRequest(q: BuyerRequest): BuyerMatch["forRequest"] {
  return { area: q.area, budget: budgetLabel(q), beds: q.bedsMin, intent: q.intent, propertyType: q.propertyType };
}

/* ---------------- CRM listings: match_requests, only with a real listings array ---------------- */

async function listingSide(input: RecommendationsInput): Promise<Recommendations["listings"]> {
  const listings = (input.listings ?? []).filter((l) => l && typeof l.id === "string" && l.id.trim() !== "");
  if (!listings.length) return { status: "missing", missing: "crm-listings" };
  if (!input.caller) return { status: "not-configured" };
  try {
    const hits = jsonHits(await readOnlyCall(input.caller, "match_requests", { listings, limit: BUYER_LIMIT }));
    if (!hits) return { status: "error" };
    return {
      status: "ok",
      items: hits.flatMap((h) => {
        const m = parseMatch(h);
        return m ? [m.item] : [];
      }),
    };
  } catch {
    return { status: "error" };
  }
}

/* ---------------- Parsing ---------------- */

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The market's reason text, with anything that looks like a phone number or an email taken out. (The reason is built from
 * the request and the listing, but a request's own text can end up in it.)
 */
export function reasonText(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return s.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email removed]").replace(/\+?\d[\d\s().-]{8,}\d/g, "[number removed]");
}

function contactOf(o: Record<string, unknown>): Record<string, unknown> | null {
  const c = o.recommended_contact;
  return c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, unknown>) : null;
}

/** route_to is always a string on a real Match. "unassigned" means no agent; anything else is routed. */
function isRouted(o: Record<string, unknown>): boolean {
  const route = str(o.route_to);
  if (route && route.toLowerCase() !== "unassigned") return true;
  const holder = str(o.holder_agent) ?? str(o.holder_agent_id);
  return !!(holder && holder.toLowerCase() !== "unassigned");
}

/**
 * The listing page's own slug as a title ("…/property/modern-3-bedroom-townhouse-for-sale-in-diego-martin/" → "Modern 3
 * bedroom townhouse for sale in diego martin"), when it has at least three words. A real Match carries no title, only
 * listing_ref ("mybunchofkeys:1099006"), which means nothing to staff. Null for an id-only path.
 */
export function slugTitle(url: string | null): string | null {
  if (!url) return null;
  let seg = "";
  try {
    seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return null;
  }
  const words = decodeURIComponent(seg).replace(/\.[a-z]{2,5}$/i, "").split(/[-_]+/).filter(Boolean);
  if (words.length < 3 || !words.some((w) => /[a-z]{3,}/i.test(w))) return null;
  const text = words.join(" ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One match hit. Title falls back to the url's slug, then listing_ref; url falls back to recommended_contact.url. */
export function parseMatch(h: unknown): { item: MatchItem; routed: boolean } | null {
  const o = (h ?? {}) as Record<string, unknown>;
  const contact = contactOf(o);
  const url = httpUrl(o.url) ?? (contact ? httpUrl(contact.url) : null);
  const title = str(o.title) ?? slugTitle(url) ?? str(o.listing_ref);
  if (!title) return null;
  const money = priceOf(o.price, o.currency);
  return {
    item: {
      title,
      url,
      area: str(o.area),
      price: moneyLabel(money.price, money.currency),
      beds: numish(o.beds),
      source: str(o.source) ?? (contact ? str(contact.agency) : null),
      reason: reasonText(o.reason ?? o.match_reason),
    },
    routed: isRouted(o),
  };
}
