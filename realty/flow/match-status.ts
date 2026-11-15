/**
 * Follow-up status for one listing match on a WhatsApp request: contacted, viewing booked, not a fit, already in touch, or
 * closed (the first three and the last two are the same set as before, plus the two new ones). Bops's own record only:
 * nothing here, and nothing in its node store, sends a message, writes to the CRM or calls out. A status is keyed by the
 * request (requestId, a hash of its WhatsApp message id: the id itself can carry a sender's number) and the listing's
 * identity (its url, or its title and source when there's no url). Setting the same status again changes nothing; a
 * different one overwrites; null clears.
 * An outcome can carry feedback (why, and an optional note): FEEDBACK_REASONS, cleanNote. What the feedback changes in matching is
 * agent-feedback.ts's rules; this file only stores and validates it. Portable: no node:*, no next, no bare process.
 */

export const MATCH_STATUSES = ["contacted", "viewing-booked", "not-a-fit", "already-in-touch", "closed"] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const STATUS_LABEL: Record<MatchStatus, string> = {
  contacted: "Contacted",
  "viewing-booked": "Viewing booked",
  "not-a-fit": "Not a fit",
  "already-in-touch": "Already in touch",
  closed: "Closed",
};

/** Hidden on the desk unless "Show hidden" is on. Every other status stays visible. */
const HIDDEN: readonly MatchStatus[] = ["not-a-fit", "closed"];

/**
 * Why an agent marked an outcome (optional). The ids are stored; the labels are shown. Only some reasons change matching
 * (agent-feedback.ts); the rest are kept and shown.
 */
export const FEEDBACK_REASONS = [
  "wrong-area",
  "over-budget",
  "wrong-type-or-size",
  "client-not-interested",
  "client-unreachable",
  "listing-unavailable",
  "already-with-another-agent",
  "other",
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

export const REASON_LABEL: Record<FeedbackReason, string> = {
  "wrong-area": "Wrong area",
  "over-budget": "Over budget",
  "wrong-type-or-size": "Wrong type or size",
  "client-not-interested": "Client not interested",
  "client-unreachable": "Client unreachable",
  "listing-unavailable": "Listing unavailable or sold",
  "already-with-another-agent": "Already working with another agent",
  other: "Other",
};

/** The longest note an agent may write, in characters. */
export const NOTE_MAX = 300;

/**
 * What the listing and the ask were when the outcome was set, kept only for a reason (and only for an Automatch lead, where
 * Bops knows them): the listing's title, the ask's area and the listing's area (null when unknown), and the listing's
 * fingerprint (agent-feedback.ts listingFingerprint) at that time, for the "re-listed" check.
 */
export type FeedbackContext = { title: string; askArea: string | null; listingArea: string | null; fingerprint: string };

/** A request id as the desk shows it: 24 lowercase hex characters (realty/node/periskope-store.ts requestIdOf). */
export const REQUEST_ID = /^[0-9a-f]{24}$/;

/**
 * One stored status. `by` is the signed-in staff email (null with the login gate off); `at` is when it was set (and when the
 * feedback last changed). `reason`, `note` and `context` are present only when they're set, so a plain status stores as before.
 */
export type StatusRow = {
  requestId: string;
  listingKey: string;
  status: MatchStatus;
  by: string | null;
  at: string;
  reason?: FeedbackReason;
  note?: string;
  context?: FeedbackContext;
};
export type FollowUp = { status: MatchStatus; by: string | null; at: string; reason?: FeedbackReason; note?: string };

/** A listing's identity: its url, or its title and source. */
export function listingKey(m: { url: string | null; title: string; source: string | null }): string {
  return m.url ? `url:${m.url}` : `title:${m.title}|${m.source ?? ""}`;
}

export const isHidden = (f: FollowUp | undefined): boolean => !!f && HIDDEN.includes(f.status);

/** The follow-ups of one request, by listing key. */
export function followUpsOf(rows: readonly StatusRow[], requestId: string): Record<string, FollowUp> {
  return Object.fromEntries(rows.filter((r) => r.requestId === requestId).map((r) => [r.listingKey, followUpOf(r)]));
}

const followUpOf = (r: StatusRow): FollowUp => ({ status: r.status, by: r.by, at: r.at, ...(r.reason ? { reason: r.reason } : {}), ...(r.note ? { note: r.note } : {}) });

export type StatusChange = {
  requestId: string;
  listingKey: string;
  status: MatchStatus | null;
  by: string | null;
  at: string;
  reason?: FeedbackReason | null;
  note?: string | null;
  context?: FeedbackContext | null;
};

/**
 * Applies one change to the rows. The same status, reason and note again changes nothing, so the first setter and time stay.
 * Any other change to the outcome or its feedback replaces the row (a new reason or note refreshes who and when). null removes
 * it, feedback and all. `changed` says whether the file needs rewriting.
 */
export function applyStatus(rows: readonly StatusRow[], c: StatusChange): { rows: StatusRow[]; changed: boolean } {
  const i = rows.findIndex((r) => r.requestId === c.requestId && r.listingKey === c.listingKey);
  const cur = i < 0 ? null : rows[i];
  if (c.status === null) return cur ? { rows: rows.filter((_, j) => j !== i), changed: true } : { rows: [...rows], changed: false };
  const reason = c.reason ?? null;
  const note = c.note ?? null;
  if (cur && cur.status === c.status && (cur.reason ?? null) === reason && (cur.note ?? null) === note) return { rows: [...rows], changed: false };
  const row: StatusRow = {
    requestId: c.requestId,
    listingKey: c.listingKey,
    status: c.status,
    by: c.by,
    at: c.at,
    ...(reason ? { reason } : {}),
    ...(note ? { note } : {}),
    ...(reason && c.context ? { context: c.context } : {}),
  };
  return { rows: cur ? rows.map((r, j) => (j === i ? row : r)) : [...rows, row], changed: true };
}

/** A note as stored: trimmed, and any phone number taken out (the record never holds one). Empty is null; too long is an error. */
export function cleanNote(text: string): { ok: true; note: string | null } | { ok: false; error: string } {
  const t = text.trim();
  if (t.length > NOTE_MAX) return { ok: false, error: `note is at most ${NOTE_MAX} characters` };
  return { ok: true, note: t ? scrubPhones(t) || null : null };
}

/** Replaces each run of 7 or more digits (a phone number, with its spaces, dashes and brackets) with "[number]". */
export function scrubPhones(text: string): string {
  return text.replace(/\+?\d[\d\s().-]*\d/g, (m) => (m.replace(/\D/g, "").length >= 7 ? "[number]" : m));
}

export type StatusPost = { requestId: string; listingKey: string; status: MatchStatus | null; reason?: FeedbackReason; note?: string };

/**
 * The POST body: { requestId, listingKey, status, reason?, note? } with status one of MATCH_STATUSES, or null to clear (which
 * clears the feedback too, so a reason or note sent with null is dropped). reason is one of FEEDBACK_REASONS, or absent/null.
 */
export function parseStatusPost(body: unknown): { ok: true; post: StatusPost } | { ok: false; error: string } {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b) return { ok: false, error: "send JSON with requestId, listingKey and status" };
  const { requestId, listingKey: key, status } = b;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return { ok: false, error: "requestId isn't valid" };
  if (typeof key !== "string" || !key || key.length > 2000) return { ok: false, error: "listingKey isn't valid" };
  if (status !== null && !(MATCH_STATUSES as readonly unknown[]).includes(status)) {
    return { ok: false, error: `status must be one of ${MATCH_STATUSES.join(", ")}, or null to clear` };
  }
  const base: StatusPost = { requestId, listingKey: key, status: status as MatchStatus | null };
  if (status === null) return { ok: true, post: base };
  const { reason, note } = b;
  if (reason !== undefined && reason !== null && !(FEEDBACK_REASONS as readonly unknown[]).includes(reason)) {
    return { ok: false, error: `reason must be one of ${FEEDBACK_REASONS.join(", ")}` };
  }
  if (note !== undefined && note !== null && typeof note !== "string") return { ok: false, error: "note must be text" };
  const cleaned = typeof note === "string" ? cleanNote(note) : { ok: true as const, note: null };
  if (!cleaned.ok) return { ok: false, error: cleaned.error };
  return {
    ok: true,
    post: {
      ...base,
      ...(reason ? { reason: reason as FeedbackReason } : {}),
      ...(cleaned.note ? { note: cleaned.note } : {}),
    },
  };
}
