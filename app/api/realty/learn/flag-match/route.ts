import { flagMatch } from "@/realty/node/flag-match.ts";

export const dynamic = "force-dynamic";

/**
 * Server to server, for the 1on1 CRM only: Authorization: Bearer <BOPS_AUTOMATCH_TOKEN>. A bad match the CRM was shown, kept for the
 * Teach page's "Flagged from CRM" (realty/node/flag-match.ts). Not behind the Google gate (lib/gate.ts).
 *   POST { source, reason, client_id?, client_locations?, listing_id?, listing_title?, listing_location?, note?, reported_by? }
 *     → 200 { ok, id } · 400 { error } · 401 { error } · 503 { error }
 */
export async function POST(request: Request) {
  const { status, body } = await flagMatch({ authorization: request.headers.get("authorization"), readBody: () => request.text().catch(() => "") }, process.env);
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
