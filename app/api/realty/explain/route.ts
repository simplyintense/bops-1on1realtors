import { ownerAccess } from "@/realty/node/periskope-intake.ts";
import { NotInQueueError, SearchInputError, withSearchStore } from "@/realty/node/search-store.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";

/**
 * Owners only. Explains one needs-explanation item and optionally saves an alias (term -> area, development or type).
 * Every alias is then reapplied to every vague item; items that are now clear move to supply or demand.
 *   POST { id, explanation, aliases?: [{ term, area?, development?, type? }] }
 *     → 200 { id, stillVague, promoted, aliasesSaved, promotedByAlias }
 *     → 400 { error } bad input · 404 { error } not in the queue
 */
export async function POST(request: Request) {
  const denied = await ownerAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send a JSON object." }, { status: 400 });
  }
  const o = (body && typeof body === "object" ? body : {}) as { id?: unknown; explanation?: unknown; aliases?: unknown };
  if (typeof o.id !== "string" || !/^[0-9a-f]{24}$/.test(o.id)) return Response.json({ error: "Send the item id." }, { status: 400 });
  try {
    const result = withSearchStore(periskopeRoot(), (store) =>
      store.explain(o.id as string, {
        explanation: o.explanation as string,
        aliases: Array.isArray(o.aliases) ? (o.aliases as never) : undefined,
      }),
    );
    return Response.json(result);
  } catch (e) {
    if (e instanceof SearchInputError) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof NotInQueueError) return Response.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
