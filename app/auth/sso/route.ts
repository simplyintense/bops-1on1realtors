// Relative imports, and next/server.js (the file, not the bare name: plain Node ESM can't resolve the bare one), so
// realty/test/sso.test.ts can run this handler under node --test. Next bundles it the same either way.
import { type NextRequest, NextResponse } from "next/server.js";
import { GATE_COOKIE, SESSION_SECONDS, gateConfig, makeSession } from "../../../lib/gate.ts";
import { redeemSsoToken } from "../../../lib/sso.ts";

export const dynamic = "force-dynamic";

/**
 * The 1on1 CRM's sign-in hand-off: GET /auth/sso?token=<token>&next=<optional path>. A valid token sets the same session cookie
 * Google sign-in sets, then 302s to `next` (default /realty/search). Anything else 302s to Google sign-in (/api/gate/login) with
 * no cookie, and the reason goes to the log as a code only. Nothing about the failure is shown to the browser.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const result = redeemSsoToken({ token: params.get("token"), next: params.get("next") });
  if (!result.ok) {
    console.log(JSON.stringify({ sso: result.reason }));
    const cfg = gateConfig();
    const login = new URL("/api/gate/login", typeof cfg === "object" && cfg ? cfg.publicUrl : request.url);
    return noStore(NextResponse.redirect(login, { status: 302 }));
  }
  const res = NextResponse.redirect(new URL(result.next, result.cfg.publicUrl), { status: 302 });
  res.cookies.set(GATE_COOKIE, await makeSession(result.email, result.cfg), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_SECONDS });
  return noStore(res);
}

/** The token is in the URL, so the response must not be cached or kept by a shared cache. */
function noStore(res: NextResponse): NextResponse {
  res.headers.set("cache-control", "no-store");
  return res;
}
