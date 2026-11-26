/**
 * The login gate for a hosted Bops (1on1 Realtors: bop.1on1realtors.com). Off unless
 * BOPS_LOGIN_GATE=google, so the Mac app and a dev server behave exactly as upstream.
 *
 * On, every page and API call needs a session cookie that this server signed after Google confirmed
 * the person's email, and the email must still be on the allowlist each time the cookie is read (taking
 * someone off BOPS_ALLOWED_EMAILS and restarting signs them out). Paths that prove themselves (the
 * webhook relay, the cloud tunnel) and the health check stay open; everything else fails closed: a gate
 * that's turned on but missing a setting answers 503 instead of letting anyone in.
 *
 * Settings (env only, never git):
 *   BOPS_LOGIN_GATE=google
 *   BOPS_ALLOWED_EMAILS        comma separated: exact emails, or "@1on1realtors.com" for a whole domain
 *   BOPS_GATE_SECRET           32+ random characters, signs the session cookie
 *   BOPS_PUBLIC_URL            https://bop.1on1realtors.com (Google redirects back to <url>/api/gate/callback)
 *   BOPS_SSO_SECRET            optional: the 1on1 CRM's sign-in hand-off secret (lib/sso.ts, /auth/sso); unset, the hand-off is off
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET   a "Web application" OAuth client
 *
 * No imports and Web Crypto only, so the proxy (any runtime), the routes and node --test all share it.
 */

export const GATE_COOKIE = "bops_gate";
export const GATE_STATE_COOKIE = "bops_gate_state";
export const SESSION_SECONDS = 12 * 60 * 60;
export const STATE_SECONDS = 10 * 60;

export type GateConfig = {
  secret: string;
  allowed: string[];
  clientId: string;
  clientSecret: string;
  publicUrl: string;
};

type Env = Record<string, string | undefined>;

/** null: the gate is off. "misconfigured": on, but a setting is missing (fail closed). */
export function gateConfig(env: Env = process.env): GateConfig | "misconfigured" | null {
  if ((env.BOPS_LOGIN_GATE ?? "").trim().toLowerCase() !== "google") return null;
  const secret = env.BOPS_GATE_SECRET ?? "";
  const allowed = parseAllowlist(env.BOPS_ALLOWED_EMAILS ?? "");
  const clientId = (env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  const publicUrl = (env.BOPS_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (secret.length < 32 || !allowed.length || !clientId || !clientSecret || !/^https:\/\/[^/]+$/i.test(publicUrl)) return "misconfigured";
  return { secret, allowed, clientId, clientSecret, publicUrl };
}

export function parseAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(s) || /^@[^\s@,]+\.[^\s@,]+$/.test(s));
}

export function emailAllowed(email: string, allowed: string[]): boolean {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) return false;
  const domain = e.slice(e.lastIndexOf("@"));
  return allowed.some((a) => (a.startsWith("@") ? a === domain : a === e));
}

/**
 * Owners' screens and APIs (BOPS_OWNER_EMAILS): with the login gate off there's no session to check, so anyone may
 * (as ownerAccess always did); with it on, the signed-in email must be an owner. A misconfigured gate says no.
 */
export function ownerAllowed(email: string | null | undefined, env: Env = process.env): boolean {
  const cfg = gateConfig(env);
  if (!cfg) return true;
  return cfg !== "misconfigured" && !!email && emailAllowed(email, parseAllowlist(env.BOPS_OWNER_EMAILS ?? ""));
}

/**
 * The teach page and API (BOPS_TEACH_EMAILS, comma-separated, case-insensitive). Unlike ownerAllowed, the gate being off
 * is no pass: there's no signed-in email, so nobody may teach through the web. Unset or empty: nobody. Misconfigured: nobody.
 */
export function teachAllowed(email: string | null | undefined, env: Env = process.env): boolean {
  const cfg = gateConfig(env);
  if (!cfg || cfg === "misconfigured") return false;
  const teachers = parseAllowlist(env.BOPS_TEACH_EMAILS ?? "").filter((a) => !a.startsWith("@"));
  return !!email && emailAllowed(email, teachers);
}

/** Paths that skip the gate: they prove themselves (signatures, tokens) or say nothing. */
export const GATE_OPEN_PATHS = new Set([
  "/api/health",
  "/api/gate/login",
  "/api/gate/callback",
  "/api/gate/logout",
  // The CRM's signed hand-off (app/auth/sso, lib/sso.ts): it sets the session itself, checked by its own signed token. Not public:
  // the demo gate (demoRoute) still sends it away.
  "/auth/sso",
  // Webhooks and the tunnel (proxy.ts TAILNET_PATHS / TUNNEL_PATHS), each checked by its own secret.
  "/api/apps/call",
  "/api/phone/agentphone",
  "/api/phone/openai",
  "/api/channels/slack/events",
  "/api/cloud/event",
  // Periskope's WhatsApp group webhook (realty/node/periskope-intake.ts), checked by its HMAC signature. Its staff paths (opt-out, consent) stay gated.
  "/api/intake/periskope",
  // The staff MCP's read-only search (realty/node/agent-search.ts), checked by its bearer token (BOPS_MCP_TOKEN) and nothing else.
  "/api/realty/agent-search",
  "/api/realty/agent-search/snapshot",
  // The staff MCP's usage counts (realty/node/usage-stats.ts), checked by the same bearer token (BOPS_MCP_TOKEN) and nothing else.
  "/api/mcp/stats",
]);

/** Where staff land after sign-in: the desk (the Bops chat app at / is one click away in the nav). */
export const HOME_AFTER_SIGN_IN = "/realty/desk";

/**
 * A redirect target that stays on this site. Empty, invalid or off-site targets, the API's own paths, and the site root (a
 * sign-in from / lands on the desk too) all go to the desk, HOME_AFTER_SIGN_IN. Anything else on the site is kept as it is.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/api/gate/")) return HOME_AFTER_SIGN_IN;
  if (next === "/") return HOME_AFTER_SIGN_IN;
  return next;
}

/* ---------------- Who may reach what (owners, teachers, agents) ---------------- */

/**
 * With the gate on, an owner (ownerAllowed) reaches everything, as before. Any other signed-in person is staff, and staff reach
 * the AI Desk pages (the sidebar's group, staff-pages.ts) and the guided tour's APIs. Owner-only mutation APIs, the owners' vault,
 * keys and Workspace APIs stay closed to staff: their calls get 403. A teacher (teachAllowed) also may POST the teach APIs (the
 * page's own forms; the teach page itself is open to all staff). Everything else is refused by the proxy (proxy.ts): an API call
 * gets 403, a page a redirect to the desk. Listed by path, not by prefix, so a new route is closed until someone adds it here.
 */

/**
 * The AI Desk pages a signed-in staff member may open, with everything under each. Supply & Demand (/realty/search) is open too;
 * its owner-only controls are hidden by the page itself, and its APIs stay owner-only (AGENT_APIS has none for them).
 * Automatch, the digest, the alert preview and the teach page are read-only for staff: their mutation buttons are hidden by the
 * page (owner flag or teachAllowed), and the APIs they call are owner- or teacher-only.
 */
export const AGENT_PAGES = [
  "/realty/desk",
  "/realty/automatch",
  "/realty/search",
  "/realty/market",
  "/realty/digest",
  "/realty/alerts",
  "/realty/learn",
] as const;

/**
 * Pages an agent may open by exact path only, never by prefix: "/" (Workspace, the Bops chat app's home) and "/realty/posts" (the
 * list of all posts). `under(path, "/")` is true for every path, so "/" must never go through `under`.
 */
const AGENT_EXACT_PAGES: readonly string[] = ["/", "/realty/posts"];
/** One stored post's page, /realty/posts/<request id> (the id is hex or base64url, from requestIdOf). */
const AGENT_POST_PAGE = /^\/realty\/posts\/[A-Za-z0-9_-]+$/;

type ApiRule = { methods: readonly string[]; match: (path: string) => boolean };

/** The APIs the desk, online search and the guided tour call (desk/follow-up-buttons.tsx, desk-tour.tsx, photo-thumbs.tsx). */
export const AGENT_APIS: readonly ApiRule[] = [
  // The desk's follow-up buttons: the route only writes what the agent may see on their own desk (realty/node/match-status.ts).
  { methods: ["POST"], match: (p) => p === "/api/realty/match-status" },
  // "Not a lead" on a desk card: the route only marks what the agent may see on their own desk (realty/node/not-a-lead.ts).
  { methods: ["POST"], match: (p) => p === "/api/realty/not-a-lead" },
  // The guided tour marks itself seen (realty/node/tour-seen.ts).
  { methods: ["POST"], match: (p) => p === "/api/realty/tour" },
  // Listing photos: an unguessable hash per photo (realty/node/listing-media.ts); the thumbs are the same photos, smaller.
  { methods: ["GET", "HEAD"], match: (p) => /^\/api\/realty\/media\/[^/]+(?:\/thumb)?$/.test(p) },
];

/** The teach page's APIs (the routes check teacherAccess themselves). */
export const TEACHER_APIS: readonly ApiRule[] = [
  { methods: ["POST"], match: (p) => p === "/api/realty/learn" },
  { methods: ["POST"], match: (p) => p === "/api/realty/learn/questions" },
];

/** Files from public/ (a logo, icons, fonts), and the favicon: they carry nothing of the team's. Never under /api/. */
export function isStaticAsset(path: string): boolean {
  if (path.startsWith("/api/") || path.includes("..")) return false;
  if (path === "/favicon" || path === "/favicon.ico") return true;
  // Only a file at the top level or directly under /realty/ (where public/ files live), so a dynamic page like
  // /realty/posts/x.png can't pass as a file.
  return /^\/(?:realty\/)?[^/]+\.(?:png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|css|txt|webmanifest)$/i.test(path);
}

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** Whether a signed-in agent (or a teacher, with `teacher`, for the teach APIs) may reach this path with this method. Owners are checked by the caller. */
export function agentMayReach(path: string, method: string, opts: { teacher?: boolean } = {}): boolean {
  const m = method.toUpperCase();
  const read = m === "GET" || m === "HEAD";
  if (!path.startsWith("/api/")) {
    if (isStaticAsset(path)) return read;
    if (!read) return false;
    if (AGENT_EXACT_PAGES.includes(path) || AGENT_POST_PAGE.test(path)) return true;
    return AGENT_PAGES.some((base) => under(path, base));
  }
  const rules = opts.teacher ? [...AGENT_APIS, ...TEACHER_APIS] : AGENT_APIS;
  return rules.some((r) => r.methods.includes(m) && r.match(path));
}

/**
 * What the gate does with one request, once it's on and the path isn't open (proxy.ts): "pass" (an owner; or an agent, or a
 * teacher for the teach APIs, to a path they may reach), "sign-in" (no session: an API call gets 401, a page the sign-in),
 * "forbidden" (an agent's API call to anything else: 403) or "desk" (an agent's page elsewhere: the desk). `email` is the
 * signed-in address (readSession), or null.
 */
export function gateVerdict(i: { path: string; method: string; email: string | null; env?: Env }): "pass" | "sign-in" | "forbidden" | "desk" {
  if (!i.email) return "sign-in";
  if (ownerAllowed(i.email, i.env)) return "pass";
  if (agentMayReach(i.path, i.method, { teacher: teachAllowed(i.email, i.env) })) return "pass";
  return i.path.startsWith("/api/") ? "forbidden" : "desk";
}

/**
 * CSRF for the cookie-bearing writes (proxy.ts, with the gate on): a state-changing request must come from this site. A browser
 * sends Origin on a POST, so that Origin's host must be one of ours; with no Origin (an old browser, or a same-site form), only
 * Sec-Fetch-Site: same-origin passes. A sandboxed page sends "null" for Origin, and that's refused.
 */
export function sameSiteWrite(i: { method: string; origin: string | null; secFetchSite: string | null; ours: (host: string) => boolean }): boolean {
  const m = i.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return true;
  if (i.origin !== null) {
    let host = "";
    try {
      host = new URL(i.origin).host;
    } catch {
      return false;
    }
    return !!host && i.ours(host.toLowerCase());
  }
  return i.secFetchSite === "same-origin";
}

/* ---------------- Signed values ---------------- */

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** `<payload>.<mac>`, both base64url; `purpose` keeps a state cookie from passing as a session. */
export async function signValue(purpose: string, payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(secret, `${purpose}.${body}`))}`;
}

export async function readValue(purpose: string, value: string | undefined | null, secret: string): Promise<Record<string, unknown> | null> {
  if (!value) return null;
  const [body, mac, extra] = value.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const got = unb64url(mac);
  if (!got || !sameBytes(got, await hmac(secret, `${purpose}.${body}`))) return null;
  const raw = unb64url(body);
  if (!raw) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(raw)) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function makeSession(email: string, cfg: GateConfig, now = Date.now()): Promise<string> {
  return signValue("session", { email: email.toLowerCase(), exp: Math.floor(now / 1000) + SESSION_SECONDS }, cfg.secret);
}

/** The signed-in email, or null (bad signature, expired, or no longer allowlisted). */
export async function readSession(cookie: string | undefined | null, cfg: GateConfig, now = Date.now()): Promise<string | null> {
  const v = await readValue("session", cookie, cfg.secret);
  if (!v || typeof v.email !== "string" || typeof v.exp !== "number") return null;
  if (v.exp * 1000 <= now) return null;
  return emailAllowed(v.email, cfg.allowed) ? v.email : null;
}

/* ---------------- Google sign-in ---------------- */

export const callbackUrl = (cfg: GateConfig) => `${cfg.publicUrl}/api/gate/callback`;

export function googleAuthUrl(cfg: GateConfig, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: callbackUrl(cfg),
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/**
 * Who an ID token is for: the verified email and the Google Workspace domain (`hd`, absent for a consumer account). Taken
 * straight from Google's token endpoint over TLS (OpenID Connect Core 3.1.3.7 lets a client skip the signature check then), so
 * this checks who issued it, for whom, that it's current, and that Google verified the address. null if any of that fails.
 */
export function idTokenIdentity(idToken: string, clientId: string, now = Date.now()): { email: string; hd: string | null } | null {
  const part = idToken.split(".")[1];
  const raw = part ? unb64url(part) : null;
  if (!raw) return null;
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") return null;
  if (typeof c.aud !== "string" || c.aud !== clientId) return null;
  if (typeof c.exp !== "number" || c.exp * 1000 <= now) return null;
  if (c.email_verified !== true && c.email_verified !== "true") return null;
  if (typeof c.email !== "string" || !c.email) return null;
  const hd = typeof c.hd === "string" && c.hd ? c.hd.trim().toLowerCase() : null;
  return { email: c.email.toLowerCase(), hd };
}

/** The email in an ID token (idTokenIdentity), or null. */
export function emailFromIdToken(idToken: string, clientId: string, now = Date.now()): string | null {
  return idTokenIdentity(idToken, clientId, now)?.email ?? null;
}

/**
 * Whether a verified Google identity may sign in. An exact-email entry matches that address only (Google verified it). A
 * whole-domain entry ("@1on1realtors.com") matches only when Google says the account belongs to that Workspace domain (`hd`),
 * so a consumer account on the same name can't pass.
 */
export function identityAllowed(who: { email: string; hd: string | null }, allowed: string[]): boolean {
  const e = who.email.trim().toLowerCase();
  const domain = e.slice(e.lastIndexOf("@"));
  return allowed.some((a) => (a.startsWith("@") ? a === domain && who.hd === a.slice(1) : a === e));
}

export function randomState(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return b64url(b);
}

/* ---------------- Public demo (Vercel) ---------------- */

/** The 1on1 Realtors demo page (app/realty-demo): fixture data only, rendered on the server. */
export const DEMO_PAGE = "/realty-demo";

/**
 * Public demo mode: the server shows only the demo page, so nobody on the open web can sign this server
 * in to an Orgo account, add keys or reach any API that could send. On when ONEON1_PUBLIC_DEMO=1, and
 * by default on Vercel (VERCEL is set there) unless ONEON1_PUBLIC_DEMO=0 turns it off on purpose.
 */
export function publicDemo(env: Env = process.env): boolean {
  const v = (env.ONEON1_PUBLIC_DEMO ?? "").trim();
  if (v === "1") return true;
  if (v === "0") return false;
  return !!env.VERCEL;
}

/**
 * What public demo mode does with a path: "pass" (the demo page, its assets, the health check),
 * "demo" (any other page: redirect to the demo) or "deny" (any other API call: 403).
 */
export function demoRoute(path: string): "pass" | "demo" | "deny" {
  if (path === DEMO_PAGE || path === "/api/health" || path.startsWith("/_next/")) return "pass";
  if (path.startsWith("/api/")) return "deny";
  // Static files from public/ that a page may load (icons, logos).
  if (/\.(svg|png|jpg|jpeg|webp|ico|woff2?)$/i.test(path) && !path.includes("..")) return "pass";
  return "demo";
}
