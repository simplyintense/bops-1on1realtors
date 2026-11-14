import { parseConsentPatch } from "@/realty/flow/periskope.ts";
import { listConsents, setConsent, staffAccess } from "@/realty/node/periskope-intake.ts";

export const dynamic = "force-dynamic";

/**
 * Staff only (behind the login gate; not an open path). A group is accepted once an admin's OK is
 * recorded and either a notice was posted or the owner waived the notice (noticeWaivedAt / noticeWaivedBy),
 * and active is not false. Do not invent a noticePostedAt to stand in for a waiver. POST also queues
 * kind=group for market-ingest (active: true). Revoke with active: false.
 *   GET:  the consent records (group ids and staff notes; no secrets).
 *   POST: { chatId, groupName?, noticePostedAt?, noticeWaivedAt?, noticeWaivedBy?, adminOkBy?, adminOkAt?, active? }.
 *         adminOkBy and noticeWaivedBy are a name or role, never a phone number.
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
