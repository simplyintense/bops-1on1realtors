import { runtimeEnv, type Env } from "../flow/env.ts";
import { listingKey, parseStatusPost, type FeedbackContext } from "../flow/match-status.ts";
import { exclusive, staffAccess, staffEmail, type Reply } from "./periskope-intake.ts";
import { ownerAllowed } from "../../lib/gate.ts";
import { deskHolds, liveDesk } from "../flow/live-match.ts";
import { crmSeamFromEnv } from "./crm-shared.ts";
import type { CrmSeam } from "../flow/crm-seam.ts";
import { leadAccess } from "./automatch-leads.ts";
import type { AutomatchOpts, AutomatchRow } from "./automatch.ts";
import { defaultIntakeRoot } from "./requests.ts";
import { PeriskopeStore } from "./periskope-store.ts";

/**
 * The match follow-up route's logic (app/api/realty/match-status): a staff member marks one listing match on a WhatsApp
 * request as contacted, viewing booked, not a fit, already in touch or closed, or clears it. Bops's own store only: this never
 * sends, never writes to the CRM and never calls out. The pair must be on the desk now: a live request with that listing as one
 * of its matches, as before. Or it's an Automatch lead (a strong row, realty/node/automatch-leads.ts), and then only an owner or
 * the agent who holds that listing may set its outcome (403 otherwise). So a status can't be keyed to anything nobody may see.
 * An agent (not an owner) may set a live match only if the desk shows it to them (liveDesk: their own requests, and the matches on
 * listings they hold), not any match on the desk. Writes are idempotent (realty/flow/match-status.ts). An outcome may carry a reason and a note (the agents' feedback,
 * agent-feedback.ts). For an Automatch lead the route also keeps what the pair was (its areas and the listing's fingerprint), so
 * the learning rules can apply later; that's read from the same lead lookup, never from the CRM write path.
 *   POST { requestId, listingKey, status, reason?, note? }  → 200 { requestId, listingKey, status, changed, … }
 *                                            400 bad body · 403 a lead that isn't yours · 404 not on the desk · 401/403/503 from staffAccess
 */

export type FollowOptions = Omit<AutomatchOpts, "now"> & { env?: Env; root?: string; now?: () => Date; seam?: CrmSeam };

export async function setMatchFollowUp(request: Request, o: FollowOptions = {}): Promise<Reply> {
  const env = o.env ?? runtimeEnv();
  const denied = await staffAccess(request, env);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { error: "send JSON with requestId, listingKey and status" } };
  }
  const parsed = parseStatusPost(body);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const { post } = parsed;
  const by = await staffEmail(request, env);
  const at = (o.now?.() ?? new Date()).toISOString();
  const root = o.root ?? defaultIntakeRoot();
  const rows = new PeriskopeStore(root).live();
  const live = rows.find((r) => r.requestId === post.requestId);
  let onDesk = !!live && [...live.matches, ...(live.ours ?? [])].some((m) => listingKey(m) === post.listingKey);
  if (onDesk && !ownerAllowed(by, env)) {
    // An agent: only a match in the desk view built for them (the same scoping the desk page uses).
    const agents = await (o.seam ?? crmSeamFromEnv(env)).agents().catch(() => []);
    onDesk = deskHolds(liveDesk({ email: by, owner: false, agents, rows, showHidden: true }), post.requestId, post.listingKey);
  }
  // The lead (an Automatch strong row) is needed to refuse a pair that isn't on the desk, and to keep what the pair was when a
  // reason is given (only then does the learning rules read it).
  const withReason = post.status !== null && post.reason !== undefined;
  let lead: { row: AutomatchRow; allowed: boolean } | null = null;
  if (!onDesk) {
    lead = await leadAccess(post.requestId, post.listingKey, { ...o, env, root, email: by, now: o.now?.() });
    if (!lead) {
      return live
        ? { status: 404, body: { error: "That listing isn't a match for this request." } }
        : { status: 404, body: { error: "That request isn't on the desk." } };
    }
    if (!lead.allowed) return { status: 403, body: { error: "That listing isn't yours." } };
  } else if (withReason) {
    // Best effort: the outcome saves even if the lead can't be read (it's only what the learning rules need).
    lead = await leadAccess(post.requestId, post.listingKey, { ...o, env, root, email: by, now: o.now?.() }).catch(() => null);
  }
  const context: FeedbackContext | null =
    withReason && lead ? { title: lead.row.listing.title, askArea: lead.row.ask.area || null, listingArea: lead.row.listing.area, fingerprint: lead.row.listing.fingerprint } : null;
  return exclusive((): Reply => {
    const { changed } = new PeriskopeStore(root).setMatchStatus({ ...post, by, at, context });
    return { status: 200, body: { ...post, changed } };
  });
}
