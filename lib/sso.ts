import { createHmac, timingSafeEqual } from "node:crypto";
import { emailAllowed, gateConfig, type GateConfig } from "./gate.ts";

/**
 * The 1on1 CRM's signed hand-off to this desk: GET /auth/sso?token=<token>&next=<optional path> (app/auth/sso/route.ts). An
 * agent signed in to the CRM gets a short-lived token, and this server turns a valid one into the same session cookie that
 * Google sign-in sets (lib/gate.ts makeSession). No session is needed before the hand-off; the checks here are the only gate.
 *
 * Token: `<payload>.<mac>`, both base64url with no padding. payload is the UTF-8 JSON {"email","exp","nonce"} (exp in unix
 * seconds). mac is HMAC-SHA256 with BOPS_SSO_SECRET, over the payload string (not the decoded JSON). Fails closed: any failed
 * check gives a reason code and no session. The code is for the log only (never the email, token or secret). Nonces are
 * single-use in this process's memory (see the note on redeemSsoToken).
 */

export const SSO_SECRET_ENV = "BOPS_SSO_SECRET";
/** Where the hand-off lands when `next` is missing or not one of the desk's own pages. */
export const SSO_DEFAULT_NEXT = "/realty/search";
/** The CRM mints tokens with a 60 second life; anything longer than this from now is refused. */
export const SSO_MAX_TTL_SECONDS = 120;
export const SSO_MIN_NONCE_LENGTH = 16;
const SSO_MAX_NONCE_LENGTH = 128;

export type SsoReason =
  | "gate-off"
  | "misconfigured"
  | "no-secret"
  | "malformed"
  | "bad-signature"
  | "bad-payload"
  | "expired"
  | "too-long"
  | "bad-nonce"
  | "not-allowed"
  | "replayed";

export type SsoResult = { ok: true; email: string; next: string; cfg: GateConfig } | { ok: false; reason: SsoReason };

type Env = Record<string, string | undefined>;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
/**
 * A `next` the hand-off may land on: the sidebar's eight AI Desk pages (staff-pages.ts), the site root (the owner-only Bot Workspace), or one stored
 * post's page (/realty/posts/<id>, the id is hex or base64url, as requestIdOf makes it). A query string is allowed on those, with
 * plain characters only. Nothing else: no other paths, no scheme, no "//", no backslash, no "..", no fragment.
 */
const SSO_NEXT =
  /^(?:\/|\/realty\/(?:desk|automatch|search|posts|market|digest|alerts|learn)|\/realty\/posts\/[A-Za-z0-9_-]+)(?:\?[A-Za-z0-9_=&%+.-]*)?$/;

/** Single-use nonces: nonce -> the token's expiry (ms). Pruned on each call, so the map keeps only tokens that could still pass. */
const usedNonces = new Map<string, number>();

/** Test-only: forget every nonce seen so far. */
export function resetSsoNonces(): void {
  usedNonces.clear();
}

/**
 * A safe post-sign-in path for the hand-off, or SSO_DEFAULT_NEXT. Stricter than gate.ts safeNext on purpose: a hand-off may only
 * open one of the AI Desk pages or a stored post, and Google sign-in keeps its own rules. Unsafe, empty or missing values all go
 * to the default: https://evil.example, //evil.example, /api/keys, /realty/searchx, /realty/posts/ (a trailing slash, no id),
 * javascript: and /\evil.
 */
export function safeSsoNext(next: unknown): string {
  if (typeof next !== "string" || next === "") return SSO_DEFAULT_NEXT;
  if (next.includes("\\") || next.includes("..") || next.startsWith("//")) return SSO_DEFAULT_NEXT;
  return SSO_NEXT.test(next) ? next : SSO_DEFAULT_NEXT;
}

type Claims = { email: string; nonce: string; expMs: number };

/** The signature and the claims' shape, life and nonce format. Nothing is recorded here; that happens only after every check passes. */
function verifyToken(token: unknown, secret: string, nowMs: number): { ok: true; claims: Claims } | { ok: false; reason: SsoReason } {
  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payload, mac] = parts;
  if (!payload || !mac || !BASE64URL.test(payload) || !BASE64URL.test(mac)) return { ok: false, reason: "malformed" };

  // Timing-safe comparison; a length mismatch is a plain "no" (timingSafeEqual would throw on it).
  const want = createHmac("sha256", secret).update(payload).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad-signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "bad-payload" };
  const c = parsed as Record<string, unknown>;
  if (typeof c.email !== "string" || typeof c.nonce !== "string" || typeof c.exp !== "number" || !Number.isFinite(c.exp)) {
    return { ok: false, reason: "bad-payload" };
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (c.exp <= nowSec) return { ok: false, reason: "expired" };
  if (c.exp > nowSec + SSO_MAX_TTL_SECONDS) return { ok: false, reason: "too-long" };

  if (c.nonce.length < SSO_MIN_NONCE_LENGTH || c.nonce.length > SSO_MAX_NONCE_LENGTH || !BASE64URL.test(c.nonce)) {
    return { ok: false, reason: "bad-nonce" };
  }
  return { ok: true, claims: { email: c.email.trim().toLowerCase(), nonce: c.nonce, expMs: c.exp * 1000 } };
}

/**
 * Checks one hand-off and, if every check passes, records its nonce so the token can't be used again. Fails closed in this order:
 * the login gate must be on and configured (lib/gate.ts), BOPS_SSO_SECRET must be set, the token must verify, its email must be on
 * the staff allowlist (BOPS_ALLOWED_EMAILS, by emailAllowed: no Google `hd` here, so identityAllowed doesn't apply), and its
 * nonce must be new.
 *
 * The nonce set lives in this process. Tokens are single-use on one server; a second server instance would keep its own set, so
 * the CRM's 60 second life is the limit across instances.
 */
export function redeemSsoToken(i: { token: unknown; next?: unknown; env?: Env; nowMs?: number }): SsoResult {
  const env = i.env ?? process.env;
  const nowMs = i.nowMs ?? Date.now();
  const cfg = gateConfig(env);
  if (cfg === null) return { ok: false, reason: "gate-off" };
  if (cfg === "misconfigured") return { ok: false, reason: "misconfigured" };
  const secret = env[SSO_SECRET_ENV] ?? "";
  if (!secret.trim()) return { ok: false, reason: "no-secret" };

  const verified = verifyToken(i.token, secret, nowMs);
  if (!verified.ok) return verified;
  const { email, nonce, expMs } = verified.claims;
  if (!EMAIL.test(email)) return { ok: false, reason: "bad-payload" };
  if (!emailAllowed(email, cfg.allowed)) return { ok: false, reason: "not-allowed" };

  for (const [n, exp] of usedNonces) if (exp <= nowMs) usedNonces.delete(n);
  if (usedNonces.has(nonce)) return { ok: false, reason: "replayed" };
  usedNonces.set(nonce, expMs);
  return { ok: true, email, next: safeSsoNext(i.next), cfg };
}
