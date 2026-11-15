import { staffEmail, teacherAccess } from "@/realty/node/periskope-intake.ts";
import { NotInQueueError, SearchInputError, withSearchStore } from "@/realty/node/search-store.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";

/**
 * Teachers only (BOPS_TEACH_EMAILS; anyone else gets a 404). Teaches Bops from one needs-explanation item: the one-line
 * answer is kept on the item, the teaching is saved to the shared knowledge, and stored posts are read again with it.
 *   POST { id, answer, term?, area?, development?, type?, listingType?, note? }
 *     → 200 { id, saved, term, stillVague, promoted, reparsed, promotedRecords }
 *     → 400 { error } bad input · 404 { error } not a teacher, or not in the queue
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
  const text = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
  const by = (await staffEmail(request)) ?? "teacher";
  try {
    const result = withSearchStore(periskopeRoot(), (store) =>
      store.teach(
        o.id as string,
        { answer: text("answer") ?? "", term: text("term"), area: text("area"), development: text("development"), type: text("type"), listingType: text("listingType"), note: text("note") },
        by,
      ),
    );
    return Response.json(result);
  } catch (e) {
    if (e instanceof SearchInputError) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof NotInQueueError) return Response.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
