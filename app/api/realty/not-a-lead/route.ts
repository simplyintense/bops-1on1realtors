import { setNotALead } from "@/realty/node/not-a-lead.ts";

export const dynamic = "force-dynamic";

/**
 * Staff marks a WhatsApp request as not a lead, which hides it from matching, search and the desk (realty/node/not-a-lead.ts).
 * An owner may mark any request in the store; an agent only one the desk shows them. `clear: true` takes the mark off again.
 * Behind the login gate (401 signed out); 403 on the public demo; 503 if the gate is on but not set up. Nothing is sent.
 *   POST { requestId } → 200 { requestId, notALead, changed }
 */
export async function POST(request: Request) {
  const r = await setNotALead(request);
  return Response.json(r.body, { status: r.status });
}
