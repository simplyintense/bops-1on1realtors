import { ownerAccess } from "@/realty/node/periskope-intake.ts";
import { replaySamples } from "@/realty/node/replay.ts";

export const dynamic = "force-dynamic";

/**
 * Owners only (behind the login gate, then BOPS_OWNER_EMAILS; 403 on the public demo). A dry run of live matching: the
 * sample WhatsApp messages (realty/fixtures/whatsapp-samples.ts) go through the signed Periskope webhook path into a
 * throwaway store, and each one comes back parsed, with its live matches from the market. Nothing is kept, nothing is
 * sent (no WhatsApp, no email, no market-ingest), and the real intake data isn't touched. See realty/node/replay.ts.
 *   POST → 200 { ranAt, market, messages: [{ id, expect, result, request, label, status, matches }], duplicate }
 */
export async function POST(request: Request) {
  const denied = await ownerAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  try {
    return Response.json(await replaySamples());
  } catch {
    return Response.json({ error: "The replay failed. Try again in a minute." }, { status: 500 });
  }
}
