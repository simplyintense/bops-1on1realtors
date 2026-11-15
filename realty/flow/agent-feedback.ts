import type { AutomatchPair, ScoreParts } from "./automatch.ts";
import { sortPairs, totalScore } from "./automatch.ts";
import { OUR_AGENCY } from "./live-match.ts";
import { listingKey, FEEDBACK_REASONS, REASON_LABEL, STATUS_LABEL, scrubPhones, type FeedbackReason, type StatusRow } from "./match-status.ts";
import type { Listing } from "./source.ts";

/**
 * What agents told Bops, and the three rules that let it learn from one (the reasons are in match-status.ts). Pure: every row and
 * listing comes in as an argument. Only these three change matching, and only Automatch's pairs (so the Automatch page and the
 * desk's lead cards both respect them):
 *
 *   1. listing-unavailable: the listing is not matched (every pair with its listing key is dropped) until it's re-listed. The
 *      listing is suppressed only while it's still in the active CRM list with the fingerprint it had when reported. A changed
 *      fingerprint (a new CRM id, price, beds or type) lifts it, and so does the listing going off the active list (then there's
 *      no pair to drop).
 *   2. not-a-fit with wrong-area: for that area pair (the ask's area and the listing's, either way round), a NEARBY pair's area
 *      points drop from 15 to NEARBY_WRONG_AREA_POINTS and the score is rescored. A same-area pair is not touched. One report is
 *      enough for every later nearby pair of those two areas.
 *   3. client-not-interested: only that ask and that listing (the desk's request id and the listing key) are dropped. The
 *      listing still matches other asks, and the ask still matches other listings.
 *
 * The other reasons are stored and shown (Teach Bops), and change nothing. Phone numbers are never in a line of this file.
 * Portable: no node:*, no next, no bare process.
 */

/** A nearby pair's area points after an agent marked that area pair wrong (was 15: WEIGHT.area / 2 in flow/automatch.ts). */
export const NEARBY_WRONG_AREA_POINTS = 5;

/** The listing's fingerprint: its CRM id, price, beds and listing type. A change to any of them is a re-listing. */
export function listingFingerprint(l: Pick<Listing, "id" | "price" | "beds" | "listingType">): string {
  return [l.id, l.price, l.beds, l.listingType].join("|");
}

/** An Automatch listing's match key: the same rule as a live match's listing (its url, else its title and our agency). */
export function ourListingKey(l: Pick<Listing, "id" | "url" | "title">): string {
  return listingKey({ url: /^https?:\/\//i.test(l.url) ? l.url : null, title: l.title || `${OUR_AGENCY} listing ${l.id}`, source: OUR_AGENCY });
}

/** The two areas as one key, the same either way round. */
export const areaPairKey = (a: string, b: string): string => [a, b].map((s) => s.trim().toLowerCase()).sort().join("|");

/** A nearby pair with the wrong-area points, rescored (rule 2). The reason says why. */
function lowerNearby(p: AutomatchPair): AutomatchPair {
  const parts: ScoreParts = { ...p.parts, area: NEARBY_WRONG_AREA_POINTS };
  return { ...p, parts, score: totalScore(parts), reason: `${p.reason}; lowered after an agent marked this area wrong` };
}

/**
 * The pairs after the agents' feedback (rows: the match-status store's rows; postIdOf: the desk's request id for an Automatch ask
 * id, or null). Best first, as automatchPairs sorts them. Pure: a row with no fingerprint or area context still counts for the
 * rule that needs only the listing key (rule 1 with no fingerprint is suppressed while the listing is present).
 */
export function learnFromFeedback(pairs: readonly AutomatchPair[], rows: readonly StatusRow[], postIdOf: (askId: string) => string | null): AutomatchPair[] {
  const unavailable = new Map<string, (string | null)[]>();
  const notInterested = new Set<string>();
  const wrongArea = new Set<string>();
  for (const r of rows) {
    if (r.reason === "listing-unavailable") unavailable.set(r.listingKey, [...(unavailable.get(r.listingKey) ?? []), r.context?.fingerprint ?? null]);
    if (r.reason === "client-not-interested") notInterested.add(`${r.requestId}|${r.listingKey}`);
    if (r.reason === "wrong-area" && r.status === "not-a-fit" && r.context?.askArea && r.context.listingArea) {
      wrongArea.add(areaPairKey(r.context.askArea, r.context.listingArea));
    }
  }
  const out: AutomatchPair[] = [];
  for (const p of pairs) {
    const key = ourListingKey(p.listing);
    const reports = unavailable.get(key);
    if (reports) {
      const now = listingFingerprint(p.listing);
      if (reports.some((fp) => fp === null || fp === now)) continue;
    }
    const postId = postIdOf(p.ask.id);
    if (postId && notInterested.has(`${postId}|${key}`)) continue;
    const nearbyWrong = p.areaRelation === "nearby" && wrongArea.has(areaPairKey(p.ask.area, p.listing.area));
    out.push(nearbyWrong ? lowerNearby(p) : p);
  }
  return sortPairs(out);
}

/* ---------------- What agents told us (Teach Bops, owners) ---------------- */

/** One line of the summary: an outcome with its reason and note, the listing's title, who set it and when (ISO). */
export type FeedbackLine = { outcome: string; reason: string | null; note: string | null; title: string; who: string | null; at: string };

export type AgentFeedbackSummary = {
  /** Outcomes with a reason or a note. */
  total: number;
  /** Counts by reason, most first; a reason no one used is left out. */
  reasons: { reason: FeedbackReason; label: string; count: number }[];
  /** The newest lines, newest first. */
  recent: FeedbackLine[];
};

/** A listing's title for a line: the stored one, else the title in its key, else "a listing" (a url key carries no title). */
function titleOf(r: StatusRow): string {
  if (r.context?.title) return r.context.title;
  if (r.listingKey.startsWith("title:")) return r.listingKey.slice("title:".length).split("|")[0] || "a listing";
  return "a listing";
}

/** The summary the owners' Teach Bops section shows, built from the store's rows. Phone numbers are taken out of notes again. */
export function agentFeedbackSummary(rows: readonly StatusRow[], recentLimit = 8): AgentFeedbackSummary {
  const fed = rows.filter((r) => r.reason || r.note).sort((a, b) => b.at.localeCompare(a.at));
  const counts = new Map<FeedbackReason, number>();
  for (const r of fed) if (r.reason) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  const reasons = FEEDBACK_REASONS.filter((id) => counts.has(id))
    .map((reason) => ({ reason, label: REASON_LABEL[reason], count: counts.get(reason) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const recent = fed.slice(0, recentLimit).map((r) => ({
    outcome: STATUS_LABEL[r.status],
    reason: r.reason ? REASON_LABEL[r.reason] : null,
    note: r.note ? scrubPhones(r.note) : null,
    title: titleOf(r),
    who: r.by,
    at: r.at,
  }));
  return { total: fed.length, reasons, recent };
}
