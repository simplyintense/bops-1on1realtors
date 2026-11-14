import { handleWebhook, SIGNATURE_HEADER } from "@/realty/node/periskope-intake.ts";

export const dynamic = "force-dynamic";

/**
 * Periskope's WhatsApp group webhook (message.created). Signed: HMAC-SHA256 of the raw body, hex, in
 * x-periskope-signature, with PERISKOPE_SIGNING_KEY. The check runs on the raw bytes before any parsing.
 * Open to the login gate (lib/gate.ts GATE_OPEN_PATHS): the signature is its check, like the other webhooks.
 * Nothing is sent back: no WhatsApp reply, no Periskope call. See docs/1on1-realtors.md (Periskope intake).
 */
export async function POST(request: Request) {
  const raw = new Uint8Array(await request.arrayBuffer());
  try {
    const r = await handleWebhook(raw, request.headers.get(SIGNATURE_HEADER));
    return Response.json(r.body, { status: r.status });
  } catch {
    // Only a failure to take a buyer request gets here. The message isn't marked seen, so Periskope's retry can take it.
    return Response.json({ error: "could not process" }, { status: 500 });
  }
}
