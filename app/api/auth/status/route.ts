import { authStatus } from "@/lib/server/orgo-sign-in";
import { ownerAllowed } from "@/lib/gate";
import { staffEmail } from "@/realty/node/periskope-intake.ts";
import { staffAuthStatus } from "@/lib/staff-workspace";

export const dynamic = "force-dynamic";

/**
 * Who's signed in, if anyone: { signedIn, user: { id, email?, name? } | null, needsSignIn, cloudProblem }.
 * `?retry=1`: the user pressed Try again on "can't reach Bops Cloud": load their state now.
 * A signed-in staff member (not an owner) is signed in as themselves and never asked to sign in to Orgo: the owner's
 * account isn't theirs to see or reload (lib/staff-workspace.ts staffAuthStatus), so `retry` does nothing for them.
 */
export async function GET(request: Request) {
  const who = await staffEmail(request);
  if (!ownerAllowed(who)) {
    if (!who) return Response.json({ error: "Sign in first." }, { status: 401 });
    return Response.json(staffAuthStatus(who));
  }
  return Response.json(await authStatus({ retry: new URL(request.url).searchParams.get("retry") === "1" }));
}
