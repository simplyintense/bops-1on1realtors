import { previewText } from "@/realty/node/learn-actions.ts";
import { staffAccess } from "@/realty/node/periskope-intake.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";

/**
 * Any signed-in staff member (staffAccess). "Test how the desk reads this": a place name or a sample message, read with the taught
 * knowledge. Nothing is saved, and the text is not sent back. No network: the market resolver is never asked.
 *   POST { text } → 200 { kind, listingType, area, island, region, bedrooms, price, currency, vague }
 *   400 { error } bad text · 401 { error } signed out
 */
export async function POST(request: Request) {
  const denied = await staffAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send a JSON object." }, { status: 400 });
  }
  const raw = (body as { text?: unknown } | null)?.text;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return Response.json({ error: "Send some text to read." }, { status: 400 });
  if (text.length > 4000) return Response.json({ error: "Keep the text to 4,000 characters." }, { status: 400 });
  return Response.json(previewText(periskopeRoot(), text));
}
