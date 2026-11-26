import { automatchClient } from "@/realty/node/automatch-client.ts";

export const dynamic = "force-dynamic";

/**
 * Server to server, for the 1on1 CRM only: Authorization: Bearer <BOPS_AUTOMATCH_TOKEN>. Scores a new client's brief against our
 * active listings (realty/node/automatch-client.ts). Not behind the Google gate (lib/gate.ts).
 *   POST → 200 { ok, matches, meta } · 400 { error } · 401 { error } · 503 { error }
 */
export async function POST(request: Request) {
  const body = await request.text().catch(() => "");
  const { status, body: reply } = await automatchClient({ authorization: request.headers.get("authorization"), body }, process.env);
  return Response.json(reply, { status, headers: { "Cache-Control": "no-store" } });
}
