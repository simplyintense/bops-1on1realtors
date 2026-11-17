import { staffAccess, staffEmail } from "../../../../realty/node/periskope-intake.ts";
import { periskopeRoot } from "../../../../realty/node/periskope-root.ts";
import { markTourSeen } from "../../../../realty/node/tour-seen.ts";

export const dynamic = "force-dynamic";

/**
 * Marks the signed-in staff viewer as having seen the guided tour (realty/node/tour-seen.ts). The email comes only from the
 * session cookie, never from the request body. Signed out: 401. Gate off (no session email): 401 too, and the tour keeps
 * its "seen" flag in the browser instead. Idempotent: a second POST writes nothing.
 *   POST → 200 { seen: true, recorded: boolean } · 401 { error } no session · 403/503 from the staff access check
 */
export async function POST(request: Request) {
  const denied = await staffAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  const email = await staffEmail(request);
  if (!email) return Response.json({ error: "Sign in first." }, { status: 401 });
  const recorded = markTourSeen(email, periskopeRoot());
  return Response.json({ seen: true, recorded });
}
