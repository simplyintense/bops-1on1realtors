import { runtimeEnv } from "../flow/env.ts";
import { buildAdminDigest, publicBaseUrl, type AdminDigest } from "../flow/admin-digest.ts";
import { automatchRun, type AutomatchOpts } from "./automatch.ts";
import { ownerAccess } from "./periskope-intake.ts";
import { periskopeRoot } from "./periskope-root.ts";
import { PeriskopeStore } from "./periskope-store.ts";

/**
 * The admin match digest's loader (realty/flow/admin-digest.ts builds it). Reads only: the Automatch matching the desk uses
 * (automatchRun: the demand, the active CRM listings, the agents, with the agents' feedback applied) and the match statuses
 * (what has already been actioned). It does NOT call staffLeads, so no first-sight record is written and the stale clocks don't
 * move. Nothing is sent, and nothing is written to the CRM.
 */

/** The digest for the current matches (75 and above, not yet actioned). */
export async function loadAdminDigest(o: AutomatchOpts = {}): Promise<AdminDigest> {
  const env = o.env ?? runtimeEnv();
  const root = o.root ?? periskopeRoot(env);
  const { result } = await automatchRun({ ...o, env, root });
  const statuses = new PeriskopeStore(root).matchStatuses();
  return buildAdminDigest(result.pairs, { statuses, baseUrl: publicBaseUrl(env) });
}

/**
 * The owners' preview (app/api/realty/admin-digest). Owners only, through ownerAccess: signed out is 401, and anyone else is
 * 403 with { error } before any data is read, as the other owners' routes do. Then the preview as HTML, or as plain text with
 * ?format=txt. It only renders; it never sends.
 */
export async function adminDigestRoute(request: Request, o: AutomatchOpts = {}): Promise<Response> {
  const env = o.env ?? runtimeEnv();
  const denied = await ownerAccess(request, env);
  if (denied) return Response.json(denied.body, { status: denied.status });
  const digest = await loadAdminDigest({ ...o, env });
  const text = new URL(request.url).searchParams.get("format") === "txt";
  return new Response(text ? digest.text : digest.html, {
    headers: { "content-type": text ? "text/plain; charset=utf-8" : "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
