import { automatchAlertRoute, automatchAlertTestSendRoute } from "@/realty/node/automatch-alert.ts";
import { ownerAccess } from "@/realty/node/periskope-intake.ts";
import { runtimeEnv } from "@/realty/flow/env.ts";

export const dynamic = "force-dynamic";

/**
 * Owners only. Auto-Match Alert preview (realty/node/automatch-alert.ts): text/html by default, text/plain with
 * ?format=txt, plan counts with ?format=json. Renders only: GET never sends mail.
 * POST sends one [TEST] alert to miles@simplyintense.com only, with no CC or BCC, even while live sending is off.
 *   GET  → 200 · 403 { error } not an owner · 401 signed out · 503 gate misconfigured
 *   POST → 200 { ok, id } · 502/503 { ok: false, error } · same auth as GET
 */
export async function GET(request: Request) {
  const denied = await ownerAccess(request, runtimeEnv());
  if (denied) return Response.json(denied.body, { status: denied.status });
  return automatchAlertRoute(request);
}

export async function POST(request: Request) {
  const denied = await ownerAccess(request, runtimeEnv());
  if (denied) return Response.json(denied.body, { status: denied.status });
  return automatchAlertTestSendRoute();
}
