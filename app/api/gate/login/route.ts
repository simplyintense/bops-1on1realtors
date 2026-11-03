import { NextResponse } from "next/server";
import { GATE_STATE_COOKIE, STATE_SECONDS, gateConfig, googleAuthUrl, randomState, safeNext, signValue } from "@/lib/gate";

export const dynamic = "force-dynamic";

/** Starts Google sign-in for the hosted login gate (lib/gate.ts). */
export async function GET(request: Request) {
  const cfg = gateConfig();
  if (!cfg) return new NextResponse("Not found", { status: 404 });
  if (cfg === "misconfigured") return new NextResponse("Sign-in isn't set up on this server yet.", { status: 503 });
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  const state = randomState();
  const res = NextResponse.redirect(googleAuthUrl(cfg, state));
  res.cookies.set(GATE_STATE_COOKIE, await signValue("state", { state, next, exp: Math.floor(Date.now() / 1000) + STATE_SECONDS }, cfg.secret), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/gate/",
    maxAge: STATE_SECONDS,
  });
  return res;
}
