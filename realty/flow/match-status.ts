/**
 * Follow-up status for one listing match on a WhatsApp request: contacted, not a fit, or closed. Bops's own record only:
 * nothing here, and nothing in its node store, sends a message, writes to the CRM or calls out. A status is keyed by the
 * request (requestId, a hash of its WhatsApp message id: the id itself can carry a sender's number) and the listing's
 * identity (its url, or its title and source when there's no url). Setting the same status again changes nothing; a
 * different one overwrites; null clears.
 * Portable: no node:*, no next, no bare process.
 */

export const MATCH_STATUSES = ["contacted", "not-a-fit", "closed"] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const STATUS_LABEL: Record<MatchStatus, string> = { contacted: "Contacted", "not-a-fit": "Not a fit", closed: "Closed" };

/** Hidden on the desk unless "Show hidden" is on. Contacted stays visible. */
const HIDDEN: readonly MatchStatus[] = ["not-a-fit", "closed"];

/** A request id as the desk shows it: 24 lowercase hex characters (realty/node/periskope-store.ts requestIdOf). */
export const REQUEST_ID = /^[0-9a-f]{24}$/;

/** One stored status. `by` is the signed-in staff email (null with the login gate off); `at` is when it was set. */
export type StatusRow = { requestId: string; listingKey: string; status: MatchStatus; by: string | null; at: string };
export type FollowUp = { status: MatchStatus; by: string | null; at: string };

/** A listing's identity: its url, or its title and source. */
export function listingKey(m: { url: string | null; title: string; source: string | null }): string {
  return m.url ? `url:${m.url}` : `title:${m.title}|${m.source ?? ""}`;
}

export const isHidden = (f: FollowUp | undefined): boolean => !!f && HIDDEN.includes(f.status);

/** The follow-ups of one request, by listing key. */
export function followUpsOf(rows: readonly StatusRow[], requestId: string): Record<string, FollowUp> {
  return Object.fromEntries(rows.filter((r) => r.requestId === requestId).map((r) => [r.listingKey, { status: r.status, by: r.by, at: r.at }]));
}

export type StatusChange = { requestId: string; listingKey: string; status: MatchStatus | null; by: string | null; at: string };

/**
 * Applies one change to the rows. The same status again changes nothing, so the first setter and time stay. A different
 * status replaces the row. null removes it. `changed` says whether the file needs rewriting.
 */
export function applyStatus(rows: readonly StatusRow[], c: StatusChange): { rows: StatusRow[]; changed: boolean } {
  const i = rows.findIndex((r) => r.requestId === c.requestId && r.listingKey === c.listingKey);
  const cur = i < 0 ? null : rows[i];
  if (c.status === null) return cur ? { rows: rows.filter((_, j) => j !== i), changed: true } : { rows: [...rows], changed: false };
  if (cur?.status === c.status) return { rows: [...rows], changed: false };
  const row: StatusRow = { requestId: c.requestId, listingKey: c.listingKey, status: c.status, by: c.by, at: c.at };
  return { rows: cur ? rows.map((r, j) => (j === i ? row : r)) : [...rows, row], changed: true };
}

export type StatusPost = { requestId: string; listingKey: string; status: MatchStatus | null };

/** The POST body: { requestId, listingKey, status } with status one of MATCH_STATUSES, or null to clear. */
export function parseStatusPost(body: unknown): { ok: true; post: StatusPost } | { ok: false; error: string } {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b) return { ok: false, error: "send JSON with requestId, listingKey and status" };
  const { requestId, listingKey: key, status } = b;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return { ok: false, error: "requestId isn't valid" };
  if (typeof key !== "string" || !key || key.length > 2000) return { ok: false, error: "listingKey isn't valid" };
  if (status !== null && !(MATCH_STATUSES as readonly unknown[]).includes(status)) {
    return { ok: false, error: "status must be contacted, not-a-fit or closed, or null to clear" };
  }
  return { ok: true, post: { requestId, listingKey: key, status: status as MatchStatus | null } };
}
