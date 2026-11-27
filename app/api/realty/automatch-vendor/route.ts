import { automatchVendor } from "@/realty/node/automatch-vendor.ts";

export const dynamic = "force-dynamic";

/**
 * Server to server, for the 1on1 CRM only: Authorization: Bearer <BOPS_AUTOMATCH_TOKEN>. Scores a property a vendor or landlord is
 * offering against our active buyers and tenants and the WhatsApp requests (realty/node/automatch-vendor.ts). Not behind the Google
 * gate (lib/gate.ts).
 *   POST → 200 { ok, client_matches, whatsapp_requests, meta } · 400 { error } · 401 { error } · 503 { error }
 */
export async function POST(request: Request) {
  const body = await request.text().catch(() => "");
  const { status, body: reply } = await automatchVendor({ authorization: request.headers.get("authorization"), body }, process.env);
  return Response.json(reply, { status, headers: { "Cache-Control": "no-store" } });
}
