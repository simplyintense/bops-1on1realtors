import { type NextRequest, NextResponse } from "next/server";
import { GATE_COOKIE, GATE_STATE_COOKIE, SESSION_SECONDS, callbackUrl, emailAllowed, emailFromIdToken, gateConfig, makeSession, readValue, safeNext } from "@/lib/gate";

export const dynamic = "force-dynamic";

const page = (status: number, text: string) =>
  new NextResponse(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Bops</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${text}</p><p><a href="/api/gate/login">Sign in with another Google account</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

/** Google's redirect back: checks the state, swaps the code for an ID token, checks the allowlist, sets the session. */
export async function GET(request: NextRequest) {
  const cfg = gateConfig();
  if (!cfg) return new NextResponse("Not found", { status: 404 });
  if (cfg === "misconfigured") return new NextResponse("Sign-in isn't set up on this server yet.", { status: 503 });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const st = await readValue("state", request.cookies.get(GATE_STATE_COOKIE)?.value, cfg.secret);
  if (!code || !st || st.state !== url.searchParams.get("state") || typeof st.exp !== "number" || st.exp * 1000 <= Date.now()) {
    return page(400, "That sign-in link expired. Please try again.");
  }
  let idToken = "";
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: callbackUrl(cfg), grant_type: "authorization_code" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) idToken = ((await r.json()) as { id_token?: string }).id_token ?? "";
  } catch {}
  const email = idToken ? emailFromIdToken(idToken, cfg.clientId) : null;
  if (!email) return page(400, "Google didn't confirm an email address. Please try again.");
  if (!emailAllowed(email, cfg.allowed)) return page(403, "This Google account isn't on the 1on1 Realtors team list. Ask Miles to add it.");
  const res = NextResponse.redirect(new URL(safeNext(typeof st.next === "string" ? st.next : "/"), cfg.publicUrl));
  res.cookies.set(GATE_COOKIE, await makeSession(email, cfg), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_SECONDS });
  res.cookies.set(GATE_STATE_COOKIE, "", { path: "/api/gate/", maxAge: 0 });
  return res;
}
