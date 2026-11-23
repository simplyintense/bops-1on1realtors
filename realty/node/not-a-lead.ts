import { ownerAllowed } from "../../lib/gate.ts";
import { runtimeEnv, type Env } from "../flow/env.ts";
import { bandOf } from "../flow/automatch.ts";
import { REQUEST_ID } from "../flow/match-status.ts";
import { liveDesk } from "../flow/live-match.ts";
import type { CrmSeam } from "../flow/crm-seam.ts";
import { exclusive, staffAccess, staffEmail, type Reply } from "./periskope-intake.ts";
import { crmSeamFromEnv } from "./crm-shared.ts";
import { automatchRun, type AutomatchOpts } from "./automatch.ts";
import { defaultIntakeRoot } from "./requests.ts";
import { PeriskopeStore, requestIdOf } from "./periskope-store.ts";
import { syncFromJsonl } from "./search-store.ts";

/**
 * The "Not a lead" route's logic (app/api/realty/not-a-lead): a staff member marks a WhatsApp request (or an Automatch lead's ask)
 * as not a lead, so it leaves matching, search and the desk. It is a kind override with status "ignored" (realty/node/periskope-store.ts
 * setKindOverride), the same one a CLI correction writes. Then the observation is rebuilt and the search store synced, so the
 * change shows at once. Bops's own store only: nothing is sent, and the CRM is not written.
 *
 * An owner may mark any request in the store. An agent may mark a request only if the desk already shows it to them: a live
 * request on their own desk or on a listing they hold, or an Automatch lead on a listing they hold. Otherwise 403. A request that
 * isn't in the store is 404. Marking an ignored request again changes nothing. `clear: true` takes the flag off again.
 *   POST { requestId }            → 200 { requestId, notALead: true, changed }
 *   POST { requestId, clear: true } → 200 { requestId, notALead: false, changed }
 *                                    400 bad body · 403 not yours · 404 not on the desk · 401/403/503 from staffAccess
 */

export const NOT_A_LEAD_REASON = "Not a lead";

export type NotALeadOptions = Omit<AutomatchOpts, "now"> & { env?: Env; root?: string; now?: () => Date; seam?: CrmSeam };

export async function setNotALead(request: Request, o: NotALeadOptions = {}): Promise<Reply> {
  const env = o.env ?? runtimeEnv();
  const denied = await staffAccess(request, env);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, body: { error: "send JSON with requestId" } };
  }
  const b = (body && typeof body === "object" ? body : {}) as { requestId?: unknown; clear?: unknown };
  if (typeof b.requestId !== "string" || !REQUEST_ID.test(b.requestId)) return { status: 400, body: { error: "requestId isn't valid" } };
  const requestId = b.requestId;
  const clear = b.clear === true;
  const by = await staffEmail(request, env);
  const at = (o.now?.() ?? new Date()).toISOString();
  const root = o.root ?? defaultIntakeRoot();
  const store = new PeriskopeStore(root);
  const messageId = messageIdOf(store, requestId);
  if (!messageId) return { status: 404, body: { error: "That request isn't on the desk." } };
  if (!ownerAllowed(by, env) && !(await agentSees(requestId, by, { ...o, env, root }))) {
    return { status: 403, body: { error: "That request isn't yours." } };
  }
  return exclusive((): Reply => {
    const ignored = store.kindOverrides().some((r) => r.messageId === messageId && r.status === "ignored");
    const unchanged = clear ? !ignored : ignored;
    if (unchanged) return { status: 200, body: { requestId, notALead: !clear, changed: false } };
    // A clear keeps the other override fields (side, place, type); setKindOverride merges them.
    store.setKindOverride(clear ? { messageId, status: null, by, at } : { messageId, status: "ignored", by, reason: NOT_A_LEAD_REASON, at });
    store.reprojectObservation(store.posts());
    syncFromJsonl(root, { force: true });
    return { status: 200, body: { requestId, notALead: !clear, changed: true } };
  });
}

/** The stored message behind a request id: a live request, else a stored post (both hash their messageId the same way). */
function messageIdOf(store: PeriskopeStore, requestId: string): string | null {
  return store.live().find((r) => r.requestId === requestId)?.messageId ?? store.posts().find((p) => requestIdOf(p.messageId) === requestId)?.messageId ?? null;
}

/** An agent sees a request if it's on their live desk (their own, or on a listing they hold), or an Automatch lead on a listing they hold. */
async function agentSees(requestId: string, email: string | null, o: NotALeadOptions & { env: Env; root: string }): Promise<boolean> {
  if (!email) return false;
  const seam = o.seam ?? crmSeamFromEnv(o.env);
  const agents = await seam.agents().catch(() => []);
  const desk = liveDesk({ email, owner: false, agents, rows: new PeriskopeStore(o.root).live(), showHidden: true });
  const cards = [...(desk.yours.status === "ok" ? desk.yours.cards : []), ...desk.onListings];
  if (cards.some((c) => c.requestId === requestId)) return true;
  const { result, agents: crmAgents } = await automatchRun({ ...o, seam, now: o.now?.() });
  const id = crmAgents.find((a) => a.email?.trim().toLowerCase() === email.trim().toLowerCase())?.id;
  return id != null && result.pairs.some((p) => bandOf(p.score) === "strong" && p.ask.postId === requestId && p.listing.agentId === id);
}
