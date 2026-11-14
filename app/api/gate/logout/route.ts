import { NextResponse } from "next/server";
import { GATE_COOKIE, gateConfig } from "@/lib/gate";

export const dynamic = "force-dynamic";

/** Signs out of the hosted login gate (lib/gate.ts). POST from the app; GET from a typed link. */
function signOut() {
  if (!gateConfig()) return new NextResponse("Not found", { status: 404 });
  const res = new NextResponse(
    '<!doctype html><meta name="viewport" content="width=device-width"><title>Bops</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>You are signed out.</p><p><a href="/api/gate/login">Sign in again</a></p></body>',
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
  res.cookies.set(GATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

export const GET = signOut;
export const POST = signOut;
