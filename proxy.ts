import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, GATE_OPEN_PATHS, gateConfig, readSession } from "@/lib/gate";

/**
 * Who may call Bops' API. The server answers on every address the Mac has, but only the app on this
 * Mac may drive it: anyone else on the same wifi could otherwise sign it out and back in to their own
 * Orgo account, and any web page in the user's browser could post to it.
 *
 * - A request addressed to another host (a LAN or tailnet address, or a DNS-rebound name) may only
 *   reach the paths the tailnet calls, each of which proves itself (the bot's secret, the webhook
 *   signature): bot computers' app calls and the webhook relay (edge/).
 * - A request from a web page must come from the app's own origin.
 *
 * The Host header is the caller's to set, so this stops browsers, not a determined caller on the
 * same network. That needs the server bound to loopback, and then another way in for the tailnet
 * paths above.
 *
 * On the Mac app, only the Bops window may use the API, reads included: desktop/main.cjs gives this
 * server a token (BOPS_UI_TOKEN) and the window an httpOnly cookie with it, so every request must carry
 * it (lib/server/ui-token.ts). A page that reached this server some other way (a bot's Chrome on this
 * Mac, after a redirect) has the same origin but not the cookie, so it can neither act nor read (a bot
 * computer's VNC password, the Mac's windows, the chats). What else may come without it: the paths
 * that prove themselves (the tailnet's above, the cloud tunnel's with its own token), the app's
 * health (main.cjs asks it before the window loads), and bots' pages, read in a tab of their own or
 * the browser (made by bots, served sandboxed, nothing of the user's in them but what a bot put there).
 * A hosted server, or a dev server run outside the app, has no token, and this doesn't apply.
 *
 * A hosted server (BOPS_DATABASE_URL) is reached by its own name, so that name is the app's too:
 * BOPS_PUBLIC_HOST lists it (names, comma separated; behind a reverse proxy that rewrites Host, the
 * public name the browser uses). Without it, a hosted server takes any Host and keeps the origin check.
 *
 * 1on1 Realtors fork: a server put on the web (bop.1on1realtors.com) also has a login gate in front of
 * every page and API call (BOPS_LOGIN_GATE=google, lib/gate.ts): only allowlisted Google accounts get
 * in. Off by default, so the Mac app is unchanged. The health check answers on any Host, so the
 * host's own checks (which call the machine's address) can reach it; it says only that it's Bops.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TAILNET_PATHS = new Set(["/api/apps/call", "/api/phone/agentphone", "/api/phone/openai", "/api/channels/slack/events"]);
/** Handed over by Bops Cloud's tunnel (lib/server/cloud-tunnel.ts), which proves itself with its own token. */
const TUNNEL_PATHS = new Set(["/api/cloud/event"]);
const READS = new Set(["GET", "HEAD"]);
/**
 * Reads anyone on this Mac's loopback may make: the app's health, bots' pages, the page of an app a bot
 * made (its code, which may hold what the chat gave it to start with, but never what it keeps: an id of
 * 128 random bits, made-apps.ts; it loads in a session of its own that has no window token,
 * desktop/app-frames.cjs), and files bots linked once the user opened them (unguessable ids).
 */
const OPEN_READS = (path: string) =>
  path === "/api/health" || path.startsWith("/api/pages/") || path.startsWith("/api/files/") || /^\/api\/made-apps\/[^/]+\/view$/.test(path);

/** The window's token, from its cookie or (desktop/main.cjs's own calls) its header, the same in constant time. */
function fromWindow(request: NextRequest, want: string) {
  const got = request.cookies.get("bops_window")?.value ?? request.headers.get("x-bops-window") ?? "";
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const hostname = (host: string) => host.replace(/:\d+$/, "").toLowerCase();

const PUBLIC = new Set(
  (process.env.BOPS_PUBLIC_HOST ?? "")
    .split(",")
    .map((h) => hostname(h.trim()))
    .filter(Boolean),
);
const HOSTED = !!process.env.BOPS_DATABASE_URL;

/** A name the app is served under: this Mac's loopback, or a hosted server's own. */
const ours = (name: string) => LOOPBACK.has(name) || PUBLIC.has(name) || (HOSTED && !PUBLIC.size);

/** The login gate (lib/gate.ts): a response to send instead, or null to go on. */
async function gate(request: NextRequest): Promise<NextResponse | null> {
  const cfg = gateConfig();
  if (!cfg) return null;
  const path = request.nextUrl.pathname;
  if (GATE_OPEN_PATHS.has(path)) return null;
  const api = path.startsWith("/api/");
  if (cfg === "misconfigured") return new NextResponse("Sign-in isn't set up on this server yet.", { status: 503 });
  if (await readSession(request.cookies.get(GATE_COOKIE)?.value, cfg)) return null;
  if (api) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const login = new URL("/api/gate/login", cfg.publicUrl);
  login.searchParams.set("next", path + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export async function proxy(request: NextRequest) {
  const gated = await gate(request);
  if (gated) return gated;
  const path = request.nextUrl.pathname;
  // Pages only pass through here for the gate; the checks below are the API's (as upstream).
  if (!path.startsWith("/api/")) return NextResponse.next();
  if (path === "/api/health" && READS.has(request.method.toUpperCase())) return NextResponse.next();
  const host = request.headers.get("host") ?? "";
  const origin = request.headers.get("origin");
  if (!ours(hostname(host)) && !TAILNET_PATHS.has(request.nextUrl.pathname)) return new NextResponse("Not allowed", { status: 403 });
  if (origin) {
    let from = "";
    try {
      from = new URL(origin).host;
    } catch {}
    // (A sandboxed page, like the ones bots make, sends "null": not the app either.)
    if (from.toLowerCase() !== host.toLowerCase() && !PUBLIC.has(hostname(from))) return new NextResponse("Not allowed", { status: 403 });
  }
  const token = process.env.BOPS_UI_TOKEN;
  const method = request.method.toUpperCase();
  const open = TAILNET_PATHS.has(path) || TUNNEL_PATHS.has(path) || method === "OPTIONS" || (READS.has(method) && OPEN_READS(path));
  if (token && !open && !fromWindow(request, token)) return NextResponse.json({ error: "Only the Bops app can do that." }, { status: 403 });
  return NextResponse.next();
}

// Every path but Next's own static files, so the login gate covers pages too; with the gate off a page
// goes straight through (above), as before.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
