import { teachPlace } from "@/realty/node/learn-actions.ts";
import { staffEmail, teacherAccess } from "@/realty/node/periskope-intake.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";
import { SearchInputError } from "@/realty/node/search-store.ts";

export const dynamic = "force-dynamic";

/**
 * Teachers only (BOPS_TEACH_EMAILS; anyone else gets a 404). Teaches a place from the Teach page: its market, an optional alias,
 * coordinates, and an optional nearby or not-nearby partner (realty/flow/taught-areas.ts placeTeachOf).
 *   POST { name, market, alias?, lat?, lon?, note?, nearby?, notNearby? }
 *     → 200 { place, market, alias, pairs }
 *     → 400 { error } bad input · 404 { error } not a teacher
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
  const by = (await staffEmail(request)) ?? "teacher";
  try {
    return Response.json(teachPlace(periskopeRoot(), body, by));
  } catch (e) {
    if (e instanceof SearchInputError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
