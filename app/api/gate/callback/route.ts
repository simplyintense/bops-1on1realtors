import { type NextRequest, NextResponse } from "next/server";
import { GATE_COOKIE, GATE_STATE_COOKIE, HOME_AFTER_SIGN_IN, SESSION_SECONDS, callbackUrl, gateConfig, identityAllowed, idTokenIdentity, makeSession, readSession, readValue, safeNext } from "@/lib/gate";
import { callbackRateLimiter, clientIp } from "@/lib/gate-rate-limit";

export const dynamic = "force-dynamic";

const page = (status: number, text: string) =>
  new NextResponse(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Bops</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${text}</p><p><a href="/api/gate/login">Sign in with another Google account</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

const tooMany = () =>
  new NextResponse("Too many sign-in attempts from this address. Wait a few minutes and try again.", {
    status: 429,
    headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "600", "cache-control": "no-store" },
  });

/** One line per sign-in outcome for the Fly logs: the reason and the email's domain only, never the address or a token. */
const note = (outcome: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ gate: outcome, ...extra }));
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/** Google's redirect back: checks the state, swaps the code for an ID token, checks the allowlist, sets the session. */
export async function GET(request: NextRequest) {
  const cfg = gateConfig();
  if (!cfg) return new NextResponse("Not found", { status: 404 });
  if (cfg === "misconfigured") return new NextResponse("Sign-in isn't set up on this server yet.", { status: 503 });
  if (!callbackRateLimiter.allow(clientIp(request.headers))) return tooMany();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const st = await readValue("state", request.cookies.get(GATE_STATE_COOKIE)?.value, cfg.secret);
  if (!code || !st || st.state !== url.searchParams.get("state") || typeof st.exp !== "number" || st.exp * 1000 <= Date.now()) {
    // Already signed in (a second tab, the back button, a refresh after success): go to the desk, not an error.
    if (await readSession(request.cookies.get(GATE_COOKIE)?.value, cfg)) return NextResponse.redirect(new URL(HOME_AFTER_SIGN_IN, cfg.publicUrl));
    const error = url.searchParams.get("error");
    note("state-invalid", { hasCode: !!code, hasStateCookie: !!st, googleError: error ? error.slice(0, 40) : null });
    if (error === "access_denied") return page(403, "Google sign-in was cancelled or isn't allowed for this account.");
    return page(400, "That sign-in link expired. Please try again.");
  }
  let idToken = "";
  let tokenStatus = 0;
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: callbackUrl(cfg), grant_type: "authorization_code" }),
      signal: AbortSignal.timeout(15_000),
    });
    tokenStatus = r.status;
    if (r.ok) idToken = ((await r.json()) as { id_token?: string }).id_token ?? "";
  } catch (e) {
    note("token-exchange-error", { error: (e as Error)?.name ?? "error" });
  }
  const who = idToken ? idTokenIdentity(idToken, cfg.clientId) : null;
  if (!who) {
    note("no-identity", { tokenStatus, hadIdToken: !!idToken });
    return page(400, "Google didn't confirm an email address. Please try again.");
  }
  if (!identityAllowed(who, cfg.allowed)) {
    note("denied", { domain: domainOf(who.email), workspace: who.hd });
    const personal = !who.hd && domainOf(who.email) === "1on1realtors.com";
    return page(
      403,
      personal
        ? "This Google account uses your 1on1 Realtors address but isn't a 1on1 Realtors Google Workspace account. Ask Miles to add this address."
        : "This Google account isn't on the 1on1 Realtors team list. Sign in with your @1on1realtors.com Google account, or ask Miles to add this one.",
    );
  }
  note("signed-in", { domain: domainOf(who.email), workspace: who.hd });
  const res = NextResponse.redirect(new URL(safeNext(typeof st.next === "string" ? st.next : null), cfg.publicUrl));
  res.cookies.set(GATE_COOKIE, await makeSession(who.email, cfg), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_SECONDS });
  res.cookies.set(GATE_STATE_COOKIE, "", { path: "/api/gate/", maxAge: 0 });
  return res;
}
