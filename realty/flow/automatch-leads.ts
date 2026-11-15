import { bandOf } from "./automatch.ts";
import { isUsd, moneyWithTtd, shortMoney } from "./fx.ts";
import { followUpsOf, isHidden, type FollowUp, type StatusRow } from "./match-status.ts";

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
    senderName: string | null;
    firm: string | null;
    senderPhone: string;
  };
  listing: {
    title: string;
    url: string | null;
    price: number | null;
    currency: string;
    ttdEquiv: number | null;
    /** The holding agent's CRM id, or null when unassigned (the office's). */
    agentId: number | null;
    agentName: string | null;
  };
};

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

/** A usable first name from a sender's name, or null: the first word, letters only, two or more. Never a number or a phone. */
export function firstNameOf(name: string | null): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return /^\p{L}[\p{L}'’-]*$/u.test(first) && first.length >= 2 ? first : null;
}

/** The place's words: "3-bed townhouse" (plain) or "3 bed townhouse" (the message). */
function placeWords(beds: number | null, type: string | null, dash: boolean): string {
  const b = beds != null ? `${beds}${dash ? "-bed" : " bed"}` : null;
  return [b, type].filter(Boolean).join(" ") || (dash ? "property" : "place");
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
  const want = `a client looking for a ${placeWords(a.beds, a.type, false)} in ${a.area}`;
  const budget = a.budget != null ? ` around ${budgetMsg(a.budget, a.currency, a.listingType)}` : "";
  const price = listingPriceText(r.listing, a.listingType);
  const link = r.listing.url ? `: ${r.listing.url}` : "";
  const have = `I have ${r.listing.title}${price ? ` at ${price}` : ""}${link}`;
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
      listing: { title: r.listing.title, url: r.listing.url, price: listingPriceText(r.listing, r.ask.listingType), agent: r.listing.agentId == null ? "Office" : (r.listing.agentName ?? "Agent") },
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
