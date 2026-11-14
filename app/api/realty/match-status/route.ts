import { setMatchFollowUp } from "@/realty/node/match-status.ts";

export const dynamic = "force-dynamic";

/**
 * Staff (any signed-in agent; not owners only) marks one listing match on a WhatsApp request: contacted, not-a-fit or
 * closed, or null to clear. Bops's own record only; nothing is sent and the CRM isn't touched (realty/node/match-status.ts).
 * Behind the login gate (401 signed out); 403 on the public demo; 503 if the gate is on but not set up.
 *   POST { requestId, listingKey, status } → 200 { requestId, listingKey, status, changed }
 */
export async function POST(request: Request) {
  const r = await setMatchFollowUp(request);
  return Response.json(r.body, { status: r.status });
}
