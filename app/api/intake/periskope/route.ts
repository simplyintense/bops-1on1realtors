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
    const r = await handleWebhook(raw, request.headers.get(SIGNATURE_HEADER), { ackFirst: true });
    return Response.json(r.body, { status: r.status });
  } catch {
    // ackFirst: a verified delivery is queued and answered 200 at once; it is handled in the background (never behind the
    // poll's lock, which made replies take 10-22 s and got the endpoint unsubscribed). A throw here means nothing was
    // queued: a 500 makes Periskope send it again.
    return Response.json({ error: "could not process" }, { status: 500 });
  }
}
