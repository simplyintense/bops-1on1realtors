import { editTaught, removeTaught, taughtPatchOf } from "@/realty/node/learn-actions.ts";
import { staffEmail, teacherAccess } from "@/realty/node/periskope-intake.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";
import { NotTaughtError, SearchInputError } from "@/realty/node/search-store.ts";

export const dynamic = "force-dynamic";

/** The taught row's id from a body: a positive whole number, else null. */
async function idOf(request: Request): Promise<{ id: number; body: unknown } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? { id, body } : null;
}

/**
 * Teachers only (BOPS_TEACH_EMAILS; anyone else gets a 404). Edits or removes one past answer (a taught knowledge row, by id). Seeded
 * area and gazetteer rows are not editable: they are 404 here, as is an unknown id. Stored posts are read again, the tables rebuilt.
 *   PATCH  { id, answer?, term?, area?, development?, type?, listingType? } → 200 { id, saved, term, reparsed }
 *   DELETE { id }                                                          → 200 { id, term, reparsed }
 *   400 { error } bad input · 404 { error } not a teacher, or not a taught answer
 */
export async function PATCH(request: Request) {
  const denied = await teacherAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  const got = await idOf(request);
  if (!got) return Response.json({ error: "Send the answer's id." }, { status: 400 });
  const by = (await staffEmail(request)) ?? "teacher";
  try {
    return Response.json(editTaught(periskopeRoot(), got.id, taughtPatchOf(got.body), by));
  } catch (e) {
    if (e instanceof NotTaughtError) return Response.json({ error: e.message }, { status: 404 });
    if (e instanceof SearchInputError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export async function DELETE(request: Request) {
  const denied = await teacherAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  const got = await idOf(request);
  if (!got) return Response.json({ error: "Send the answer's id." }, { status: 400 });
  try {
    return Response.json(removeTaught(periskopeRoot(), got.id));
  } catch (e) {
    if (e instanceof NotTaughtError) return Response.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
