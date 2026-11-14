import { parseOptOut } from "@/realty/flow/periskope.ts";
import { optOutSender, staffAccess } from "@/realty/node/periskope-intake.ts";

export const dynamic = "force-dynamic";

/**
 * Staff only (behind the login gate; not an open path). POST { senderPhone }: adds the number to the
 * opt-out list, deletes what's stored from it (its leads, market outbox source items and seen rows),
 * and queues kind=optout for market-ingest.
 */
export async function POST(request: Request) {
  const denied = await staffAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "send JSON with senderPhone" }, { status: 400 });
  }
  const parsed = parseOptOut(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  return Response.json(await optOutSender(parsed.phone));
}
