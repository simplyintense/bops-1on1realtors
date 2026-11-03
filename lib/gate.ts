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

/** Paths that skip the gate: they prove themselves (signatures, tokens) or say nothing. */
export const GATE_OPEN_PATHS = new Set([
  "/api/health",
  "/api/gate/login",
  "/api/gate/callback",
  "/api/gate/logout",
  // Webhooks and the tunnel (proxy.ts TAILNET_PATHS / TUNNEL_PATHS), each checked by its own secret.
  "/api/apps/call",
  "/api/phone/agentphone",
  "/api/phone/openai",
  "/api/channels/slack/events",
  "/api/cloud/event",
]);

/** A redirect target that stays on this site. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/api/gate/")) return "/";
  return next;
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
 * The email in an ID token this server got straight from Google's token endpoint over TLS (OpenID
 * Connect Core 3.1.3.7 lets a client skip the signature check then), after checking who issued it, for
 * whom, that it's current and that Google verified the address. null if any of that fails.
 */
export function emailFromIdToken(idToken: string, clientId: string, now = Date.now()): string | null {
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
  if (c.aud !== clientId) return null;
  if (typeof c.exp !== "number" || c.exp * 1000 <= now) return null;
  if (c.email_verified !== true && c.email_verified !== "true") return null;
  return typeof c.email === "string" ? c.email.toLowerCase() : null;
}

export function randomState(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return b64url(b);
}
