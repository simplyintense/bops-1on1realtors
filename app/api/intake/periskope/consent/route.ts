import { parseConsentPatch } from "@/realty/flow/periskope.ts";
import { listConsents, setConsent, staffAccess } from "@/realty/node/periskope-intake.ts";

export const dynamic = "force-dynamic";

/**
 * Staff only (behind the login gate; not an open path). A group is accepted only once its notice is
 * posted (staff do that by hand) and an admin's OK is recorded: both timestamps set, and active is not
 * false. POST also queues kind=group for market-ingest (active: true). Revoke with active: false.
 *   GET:  the consent records (group ids and staff notes; no secrets).
 *   POST: { chatId, groupName?, noticePostedAt?, adminOkBy?, adminOkAt?, active? }, a partial update.
 *         adminOkBy is a business name or role, never a phone number.
 */
export async function GET(request: Request) {
  const denied = await staffAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  return Response.json({ consents: listConsents() });
}

export async function POST(request: Request) {
  const denied = await staffAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "send JSON with chatId" }, { status: 400 });
  }
  const parsed = parseConsentPatch(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  return Response.json({ consent: await setConsent(parsed.patch) });
}
