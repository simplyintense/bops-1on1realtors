import { runtimeEnv, type Env } from "../flow/env.ts";
import { listingKey, parseStatusPost } from "../flow/match-status.ts";
import { exclusive, staffAccess, staffEmail, type Reply } from "./periskope-intake.ts";
import { defaultIntakeRoot } from "./requests.ts";
import { PeriskopeStore } from "./periskope-store.ts";

/**
 * The match follow-up route's logic (app/api/realty/match-status): a staff member marks one listing match on a WhatsApp
 * request as contacted, not a fit or closed, or clears it. Bops's own store only: this never sends, never writes to the
 * CRM and never calls out. The request and the listing must be on the desk now (its live row and one of its matches),
 * so a status can't be keyed to anything the intake didn't store. Writes are idempotent (realty/flow/match-status.ts).
 *   POST { requestId, listingKey, status }  → 200 { requestId, listingKey, status, changed }
 *                                            400 bad body · 404 not on the desk · 401/403/503 from staffAccess
 */

export type FollowOptions = { env?: Env; root?: string; now?: () => Date };

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
  return exclusive((): Reply => {
    const store = new PeriskopeStore(o.root ?? defaultIntakeRoot());
    const row = store.live().find((r) => r.requestId === post.requestId);
    if (!row) return { status: 404, body: { error: "That request isn't on the desk." } };
    if (![...row.matches, ...(row.ours ?? [])].some((m) => listingKey(m) === post.listingKey)) {
      return { status: 404, body: { error: "That listing isn't a match for this request." } };
    }
    const { changed } = store.setMatchStatus({ ...post, by, at });
    return { status: 200, body: { ...post, changed } };
  });
}
