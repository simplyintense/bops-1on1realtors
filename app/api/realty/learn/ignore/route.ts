import { ignoreQueueItem } from "@/realty/node/learn-actions.ts";
import { staffEmail, teacherAccess } from "@/realty/node/periskope-intake.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";
import { NotInQueueError } from "@/realty/node/search-store.ts";

export const dynamic = "force-dynamic";

/**
 * Teachers only (BOPS_TEACH_EMAILS; anyone else gets a 404). "Not a listing": one click takes a queue item out of the open queue,
 * with no explanation needed (the same ignored state "Not a lead" sets).
 *   POST { id }
 *     → 200 { id, ignored: true }
 *     → 400 { error } bad id · 404 { error } not a teacher, or not in the queue
 */
export async function POST(request: Request) {
  const denied = await teacherAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send a JSON object." }, { status: 400 });
  }
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^[0-9a-f]{24}$/.test(o.id)) return Response.json({ error: "Send the item id." }, { status: 400 });
  const by = (await staffEmail(request)) ?? "teacher";
  try {
    return Response.json(await ignoreQueueItem(periskopeRoot(), o.id, by));
  } catch (e) {
    if (e instanceof NotInQueueError) return Response.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
