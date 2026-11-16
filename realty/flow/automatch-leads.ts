import { bandOf } from "./automatch.ts";
import { isUsd, moneyWithTtd, shortMoney } from "./fx.ts";
import { followUpsOf, isHidden, type FollowUp, type StatusRow } from "./match-status.ts";
import { shortListingTitle } from "./listing-title.ts";

/**
 * Automatch lead cards: one card per Automatch row scoring 75 and above (STRONG), for the agent who holds the listing and for
 * the owners. The card gives the ask in plain words, who asked (name, firm, number as the store has them), why it fits, the
 * 1on1 listing, a suggested opening message from Miles (the 1on1 office), and an "Open in WhatsApp" link that opens the
 * agent's own WhatsApp in their browser. Nothing is sent from the server: the link is a plain anchor, and the message is only
 * text to read and send by hand.
 *
 * Outcomes are the match statuses (match-status.ts), keyed by the ask's request id and the listing key, so a card and a live
 * match for the same pair share one record. A card with no outcome two hours after its match is "stale": a label only.
 *
 * Visibility: an owner sees every card. Anyone else sees a card only if they hold the listing (the CRM agent with their email,
 * the same rule as the desk's). An unassigned listing (no agent) is the office's, so only owners see it.
 *
 * Portable: no node:*, no next, no bare process. Pure: every time comes in as an argument.
 */

/** A card with no outcome this long after its match is labelled Stale (display only). */
export const LEAD_STALE_MS = 2 * 3_600_000;

/** The first time Bops saw a pair (requestId + listingKey), kept in its own store (match-seen.jsonl). */
export type MatchSeenRow = { requestId: string; listingKey: string; at: string };

/** One Automatch row as a lead reads it (the node's AutomatchRow has all of these). */
export type LeadInput = {
  score: number;
  reason: string;
  /** The listing's key (match-status.ts listingKey, the same rule as a live match's ours). */
  listingKey: string;
  ask: {
    /** The ask's request id (requestIdOf of its first message), or null when it has none (no card then). */
    postId: string | null;
    area: string;
    beds: number | null;
    budget: number | null;
    currency: string;
    type: string | null;
    listingType: "sale" | "rent";
    lastSeenAt: string;
    /** When the ask was first seen (ISO), when the record has it: the posted time the digest shows. */
    postedAt?: string | null;
    senderName: string | null;
    firm: string | null;
    senderPhone: string;
    /** The contact's WhatsApp message as posted (no group name). Used to check the words in the suggested reply, and quoted by the alert. */
    originalText?: string | null;
  };
  listing: {
    /** The CRM title as it came; the cards and messages show shortListingTitle of it (with the fields below). */
    title: string;
    url: string | null;
    price: number | null;
    currency: string;
    ttdEquiv: number | null;
    /** The holding agent's CRM id, or null when unassigned (the office's). */
    agentId: number | null;
    agentName: string | null;
    /** The listing's area, beds, type word and street, when the CRM has them (shortListingTitle reads them). */
    area?: string | null;
    beds?: number | null;
    type?: string | null;
    address?: string | null;
  };
};

/**
 * The card's id on the Desk (and the anchor an email links to): "lead-<requestId>-<hash of the listing key>". Stable for the same
 * pair, and free of anything a URL would need escaped. Pure.
 */
export function leadCardId(requestId: string, listingKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < listingKey.length; i++) {
    h ^= listingKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `lead-${requestId}-${h.toString(16).padStart(8, "0")}`;
}

/** A card as the desk and the owners' page show it. The phone is shown here only, never in a log. */
export type LeadCardView = {
  requestId: string;
  listingKey: string;
  score: number;
  /** The ask in plain words, e.g. "Looking to buy a 3-bed townhouse in Maraval, around TT$4.3m". */
  ask: string;
  sender: { name: string | null; firm: string | null; phone: string };
  listing: { title: string; url: string | null; price: string | null; agent: string };
  reason: string;
  /** The suggested opening message, framed as a lead from Miles (the 1on1 office). */
  message: string;
  /** https://wa.me/<digits>?text=… for the agent's own browser, or null when there's no usable number. */
  waUrl: string | null;
  /** The later of the ask's last seen time and when this pair was first seen (ISO). */
  matchedAt: string;
  stale: boolean;
  follow: FollowUp | null;
};

export type LeadsView = { cards: LeadCardView[]; /** Cards hidden as not a fit or closed (0 when "Show hidden" is on). */ hidden: number };

/* ---------------- Words ---------------- */

/** Words that mark a company, not a person (matched as whole words, lower-case; "Real Estate" is checked as a pair below). */
const COMPANY_WORDS = new Set([
  "realty", "realtors", "limited", "ltd", "properties", "property", "company", "co", "inc", "incorporated", "llc", "llp", "plc",
  "group", "holdings", "associates", "agency", "agencies", "brokerage", "services", "enterprises", "corp", "corporation",
]);

/**
 * True when a sender's name is a company ("DRL Realty Limited", "Bar Co.", "Westside Group"): a company word as a whole word, or
 * "Real Estate". Dots are dropped first, so "Co." and "Inc." match and "Cole" or "Incorporate" don't. Pure.
 */
export function isCompanyName(name: string | null | undefined): boolean {
  const words = (name ?? "").toLowerCase().replace(/\./g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.some((w, i) => COMPANY_WORDS.has(w) || (w === "real" && words[i + 1] === "estate"));
}

/**
 * A usable first name from a sender's name, or null: the first word, letters only, two or more. Never a number or a phone, and
 * never a company (the greeting is then just "Hi,").
 */
export function firstNameOf(name: string | null): string | null {
  if (isCompanyName(name)) return null;
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return /^\p{L}[\p{L}'’-]*$/u.test(first) && first.length >= 2 ? first : null;
}

/** The place's words: "3-bed townhouse" (plain) or "3 bed townhouse" (the message). */
function placeWords(beds: number | null, type: string | null, dash: boolean): string {
  const b = beds != null ? `${beds}${dash ? "-bed" : " bed"}` : null;
  return [b, type].filter(Boolean).join(" ") || (dash ? "property" : "place");
}

/**
 * The public listing link, or null. Only http(s) on 1on1realtors.com or www.1on1realtors.com, with no login in the URL. Any other
 * host (bop.1on1realtors.com included) gives null, so an email or message never carries it. Pure.
 */
export function publicListingUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || !/^https?:\/\//i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (host !== "1on1realtors.com" && host !== "www.1on1realtors.com") return null;
  return u.toString();
}

/** Whole-word, case-insensitive: the area's words as they are, separated by anything, not part of a longer word. */
function wordIn(phrase: string, text: string): boolean {
  const words = phrase.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return false;
  return new RegExp(`(?<!\\p{L})${words.join("\\s+")}(?!\\p{L})`, "iu").test(text);
}

/**
 * A type word as the message writes it: "townhouse" matches "town house", "town-house" and "townhouses"; "house" does not match
 * inside "townhouse". Pure.
 */
export function typeWordIn(type: string, text: string): boolean {
  const letters = type.trim().toLowerCase().replace(/[\s-]+/g, "");
  if (!letters) return false;
  const body = [...letters].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s-]?");
  return new RegExp(`(?<!\\p{L})${body}s?(?!\\p{L})`, "iu").test(text);
}

/** Words that can mean the message offers more than one place ("open to", "or", "and", a slash). Conservative on purpose. */
const MULTI_AREA_CUE = /\b(open to|or|and|either|also|nearby|anywhere|neighbou?rs?|neighbou?rhood)\b|[/&+]/i;

/** True when the message reads as offering alternative areas, so no single area should be pinned on the contact. */
export function offersSeveralAreas(text: string): boolean {
  return MULTI_AREA_CUE.test(text);
}

/**
 * The ask's words for the suggested reply, with no invented type or area. A type shows only when the parsed type is set and, if the
 * original message is there, the message says it. An area shows only when the parsed area is set, and, if the message is there, the
 * message names that area and does not offer several areas. Pure.
 */
export function askPlaceWords(a: LeadInput["ask"]): string {
  const text = (a.originalText ?? "").trim();
  const type = a.type && (!text || typeWordIn(a.type, text)) ? a.type : null;
  const area = a.area && (!text || (wordIn(a.area, text) && !offersSeveralAreas(text))) ? a.area : null;
  const beds = a.beds != null ? (type ? `${a.beds} bed` : `${a.beds} bedroom`) : null;
  const what = [beds, type].filter(Boolean).join(" ") || "place";
  return area ? `${what} in ${area}` : what;
}

/** The budget as the desk's plain line: TT$ as it reads, a USD ask as "asked in US$ (US$650k ≈ TT$4.41m)". A rent is a month. */
function budgetPlain(budget: number, currency: string, listingType: "sale" | "rent"): string {
  const rent = listingType === "rent" ? " a month" : "";
  return isUsd(currency) ? `asked in US$ (${moneyWithTtd(budget, "USD")})${rent}` : `around ${shortMoney(budget, "TTD")}${rent}`;
}

/** The ask in plain words: "Looking to buy a 3-bed townhouse in Maraval, around TT$4.3m". */
export function askLine(a: LeadInput["ask"]): string {
  const what = placeWords(a.beds, a.type, true);
  const budget = a.budget != null ? `, ${budgetPlain(a.budget, a.currency, a.listingType)}` : "";
  return `Looking to ${a.listingType === "rent" ? "rent" : "buy"} a ${what} in ${a.area}${budget}`;
}

/** The listing's price in words, e.g. "TT$3.7m" or "US$650k ≈ TT$4.41m"; null when none is listed. */
export function listingPriceText(l: LeadInput["listing"], listingType: "sale" | "rent"): string | null {
  if (!l.price) return null;
  const rent = listingType === "rent" ? " a month" : "";
  const shown = isUsd(l.currency) ? moneyWithTtd(l.price, l.currency, l.ttdEquiv) : shortMoney(l.price, "TTD");
  return `${shown}${rent}`;
}

/**
 * The suggested opening message: a lead from Miles (the 1on1 office) to the poster, with the listing. It never says what the
 * message came from (no group, no scanning, no monitoring, no Bops), so it reads as one agent to another.
 * "Hi <first name>," when the poster's name is known, else "Hi,". The listing's link is left out when it has no url.
 */
export function leadMessage(r: LeadInput): string {
  const hi = firstNameOf(r.ask.senderName);
  const a = r.ask;
  const want = `a client looking for a ${askPlaceWords(a)}`;
  const budget = a.budget != null ? ` around ${budgetMsg(a.budget, a.currency, a.listingType)}` : "";
  const price = listingPriceText(r.listing, a.listingType);
  const link = publicListingUrl(r.listing.url);
  const have = `I have ${shortListingTitle(r.listing)}${price ? ` at ${price}` : ""}${link ? `: ${link}` : ""}`;
  return `${hi ? `Hi ${hi},` : "Hi,"} I hear you have ${want}${budget}. ${have}. Happy to set up a viewing.`;
}

/** The ask's budget in the message: shortMoney, with the currency and "a month" for a rent. */
function budgetMsg(budget: number, currency: string, listingType: "sale" | "rent"): string {
  const rent = listingType === "rent" ? " a month" : "";
  return `${shortMoney(budget, isUsd(currency) ? "USD" : "TTD")}${rent}`;
}

/**
 * The WhatsApp link for the agent's browser: https://wa.me/<digits>?text=<encoded message>. The digits are the sender's number
 * with everything else removed (wa.me wants the international form with no +). No usable number (fewer than 7 or more than
 * 15 digits, or none) gives null: no link.
 */
export function waUrlFor(phone: string, message: string): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/* ---------------- Time, stale, visibility ---------------- */

/** The match's time: the later of the ask's last seen time and when this pair was first seen. An unreadable one is ignored. */
export function matchedAt(lastSeenAt: string, firstSeenAt: string | null): string {
  const a = Date.parse(lastSeenAt);
  const b = firstSeenAt ? Date.parse(firstSeenAt) : Number.NaN;
  const finite = [a, b].filter((t) => Number.isFinite(t));
  if (!finite.length) return firstSeenAt ?? lastSeenAt;
  return new Date(Math.max(...finite)).toISOString();
}

/** Stale: no outcome, and the match is at least LEAD_STALE_MS old. Any outcome (contacted included) clears it. */
export function isStale(matched: string, follow: FollowUp | null, now: Date): boolean {
  const t = Date.parse(matched);
  return follow == null && Number.isFinite(t) && now.getTime() - t >= LEAD_STALE_MS;
}

/** Owners see every card. Anyone else sees a card only for a listing they hold (agentId is theirs). Unassigned is owners only. */
export function canSeeLead(me: { owner: boolean; agentId: number | null }, listingAgentId: number | null): boolean {
  if (me.owner) return true;
  return listingAgentId != null && me.agentId === listingAgentId;
}

/**
 * The cards this viewer may see, best first (the rows' order). A card is a STRONG row with a request id. A card that is not
 * a fit or closed is hidden unless showHidden, and counted in `hidden`.
 */
export function leadsView(
  rows: readonly LeadInput[],
  o: { owner: boolean; agentId: number | null; statuses: readonly StatusRow[]; firstSeen: readonly MatchSeenRow[]; now: Date; showHidden?: boolean },
): LeadsView {
  const cards: LeadCardView[] = [];
  let hidden = 0;
  const followsByRequest = new Map<string, Record<string, FollowUp>>();
  for (const r of rows) {
    if (bandOf(r.score) !== "strong" || !r.ask.postId) continue;
    if (!canSeeLead(o, r.listing.agentId)) continue;
    const requestId = r.ask.postId;
    if (!followsByRequest.has(requestId)) followsByRequest.set(requestId, followUpsOf(o.statuses, requestId));
    const follow = followsByRequest.get(requestId)?.[r.listingKey] ?? null;
    if (isHidden(follow ?? undefined) && !o.showHidden) {
      hidden += 1;
      continue;
    }
    const first = o.firstSeen.find((s) => s.requestId === requestId && s.listingKey === r.listingKey)?.at ?? null;
    const at = matchedAt(r.ask.lastSeenAt, first);
    const message = leadMessage(r);
    cards.push({
      requestId,
      listingKey: r.listingKey,
      score: r.score,
      ask: askLine(r.ask),
      sender: { name: r.ask.senderName, firm: r.ask.firm, phone: r.ask.senderPhone },
      listing: { title: shortListingTitle(r.listing), url: r.listing.url, price: listingPriceText(r.listing, r.ask.listingType), agent: r.listing.agentId == null ? "Office" : (r.listing.agentName ?? "Agent") },
      reason: r.reason,
      message,
      waUrl: waUrlFor(r.ask.senderPhone, message),
      matchedAt: at,
      stale: isStale(at, follow, o.now),
      follow,
    });
  }
  return { cards, hidden };
}
