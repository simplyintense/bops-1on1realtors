import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  type GateConfig,
  GATE_COOKIE,
  gateConfig,
  gateVerdict,
  identityAllowed,
  idTokenIdentity,
  isStaticAsset,
  agentMayReach,
  makeSession,
  readSession,
  SESSION_SECONDS,
  sameSiteWrite,
  signValue,
} from "../../lib/gate.ts";
import { clientIp, makeRateLimiter } from "../../lib/gate-rate-limit.ts";
import { leadLabel, leadsSectionCopy, showFeedStatus } from "../../app/realty/desk/copy.ts";
import { SECURITY_HEADER_GROUPS } from "../../lib/security-headers.ts";

/**
 * The security gate (lib/gate.ts, proxy.ts), the sign-in checks, the rate limit, CSRF, the security headers and the agent's copy.
 * proxy.ts itself imports the "@/" alias, which node --test doesn't resolve, so the proxy's decision is gateVerdict (the same
 * function the proxy calls), fed the session read from the cookie exactly as the proxy reads it.
 */

const OWNER = "miles@1on1.example";
const AGENT = "kerry@1on1.example";
const TEACHER = "teach@1on1.example";
const ENV = {
  BOPS_LOGIN_GATE: "google",
  BOPS_GATE_SECRET: "s".repeat(40),
  BOPS_ALLOWED_EMAILS: "@1on1.example, miles@simplyintense.example",
  BOPS_OWNER_EMAILS: OWNER,
  BOPS_TEACH_EMAILS: TEACHER,
  GOOGLE_OAUTH_CLIENT_ID: "client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  BOPS_PUBLIC_URL: "https://bop.example",
};
const cfg = gateConfig(ENV);
if (!cfg || cfg === "misconfigured") throw new Error("test config");
const CFG: GateConfig = cfg;

/** What the proxy decides for a request carrying this cookie header (the cookie is the only thing it reads). */
async function decide(path: string, method: string, cookieHeader?: string, env: Record<string, string> = ENV): Promise<string> {
  const c = gateConfig(env);
  if (!c || c === "misconfigured") throw new Error("config");
  const value = /(?:^|;\s*)bops_gate=([^;]*)/.exec(cookieHeader ?? "")?.[1];
  const email = await readSession(value, c);
  return gateVerdict({ path, method, email, env });
}
const session = (email: string, now = Date.now()) => makeSession(email, cfg, now);

const SENSITIVE_APIS = [
  "/api/vault",
  "/api/keys",
  "/api/bots",
  "/api/computer",
  "/api/auth/start",
  "/api/setup",
  "/api/reset",
  "/api/realty/posts",
  "/api/realty/search",
  "/api/realty/replay",
  "/api/realty/automatch-alert",
  "/api/realty/learn",
  "/api/chats",
  "/api/memory",
  "/api/mail",
];
const AGENT_PAGES_THAT_ARE_NOT_THE_DESK = ["/", "/realty/posts", "/realty/automatch", "/realty/search", "/realty/digest", "/realty/alerts", "/realty-demo", "/realty/requests"];

test("agents: the desk, online search and their APIs; every other API is refused with 403, every other page goes to the desk", async () => {
  const agent = await session(AGENT);
  for (const api of SENSITIVE_APIS) assert.equal(await decide(api, "GET", `bops_gate=${agent}`), "forbidden", api);
  for (const page of AGENT_PAGES_THAT_ARE_NOT_THE_DESK) assert.equal(await decide(page, "GET", `bops_gate=${agent}`), "desk", page);
  assert.equal(await decide("/realty/desk", "GET", `bops_gate=${agent}`), "pass");
  assert.equal(await decide("/realty/desk/anything", "GET", `bops_gate=${agent}`), "pass");
  assert.equal(await decide("/realty/market", "GET", `bops_gate=${agent}`), "pass");
  assert.equal(await decide("/realty/deskish", "GET", `bops_gate=${agent}`), "desk", "a prefix isn't a path");
  assert.equal(await decide("/api/realty/match-status", "POST", `bops_gate=${agent}`), "pass");
  assert.equal(await decide("/api/realty/match-status", "GET", `bops_gate=${agent}`), "forbidden", "the follow-up route takes POST only");
  assert.equal(await decide("/api/realty/not-a-lead", "POST", `bops_gate=${agent}`), "pass");
  assert.equal(await decide("/api/realty/not-a-lead", "GET", `bops_gate=${agent}`), "forbidden", "Not a lead takes POST only");
  assert.equal(await decide("/api/realty/tour", "POST", `bops_gate=${agent}`), "pass");
  assert.equal(await decide("/api/realty/media/3fa9c2d1e8b74f60", "GET", `bops_gate=${agent}`), "pass");
  assert.equal(await decide("/api/realty/media/3fa9c2d1e8b74f60/thumb", "GET", `bops_gate=${agent}`), "pass");
  assert.equal(await decide("/api/realty/media/3fa9c2d1e8b74f60", "POST", `bops_gate=${agent}`), "forbidden");
  assert.equal(await decide("/api/realty/learn", "POST", `bops_gate=${agent}`), "forbidden", "the teach API is for teachers");
});

test("owners reach every page and API, as before", async () => {
  const owner = await session(OWNER);
  for (const path of [...SENSITIVE_APIS, ...AGENT_PAGES_THAT_ARE_NOT_THE_DESK, "/realty/desk", "/realty/learn", "/api/realty/match-status", "/api/realty/not-a-lead"]) {
    assert.equal(await decide(path, "POST", `bops_gate=${owner}`), "pass", path);
  }
});

test("teachers also reach the teach page and its APIs, and nothing owners-only", async () => {
  const teacher = await session(TEACHER);
  assert.equal(await decide("/realty/learn", "GET", `bops_gate=${teacher}`), "pass");
  assert.equal(await decide("/api/realty/learn", "POST", `bops_gate=${teacher}`), "pass");
  assert.equal(await decide("/api/realty/learn/questions", "POST", `bops_gate=${teacher}`), "pass");
  assert.equal(await decide("/api/vault", "GET", `bops_gate=${teacher}`), "forbidden");
  assert.equal(await decide("/realty/posts", "GET", `bops_gate=${teacher}`), "desk");
});

test("signed out: an API call is a sign-in (401), a page goes to the sign-in", async () => {
  assert.equal(await decide("/api/vault", "GET"), "sign-in");
  assert.equal(await decide("/", "GET"), "sign-in");
  assert.equal(await decide("/realty/desk", "GET"), "sign-in");
});

test("static files from public/ load for agents: the logo and the favicon; nothing under /api/ is a file", async () => {
  const agent = await session(AGENT);
  assert.equal(await decide("/realty/1on1-realtors-logo.png", "GET", `bops_gate=${agent}`), "pass");
  assert.equal(await decide("/favicon.ico", "GET", `bops_gate=${agent}`), "pass");
  assert.equal(await decide("/favicon", "GET", `bops_gate=${agent}`), "pass");
  assert.equal(isStaticAsset("/api/keys/logo.png"), false);
  assert.equal(isStaticAsset("/realty/../api/keys.png"), false);
  assert.equal(await decide("/api/keys/logo.png", "GET", `bops_gate=${agent}`), "forbidden");
});

test("no alternate login: forged identity headers, a window token, a bearer key, ?token= and a bare cookie grant nothing without a session", async () => {
  const forged = new Headers({
    "x-forwarded-email": OWNER,
    "x-user-email": OWNER,
    "x-auth-user": OWNER,
    authorization: "Bearer sk_anything",
    "x-bops-window": "anything",
    cookie: "bops_window=anything; bops_gate=not-a-session",
  });
  // The proxy reads identity only from the signed bops_gate cookie. Headers and other cookies are never read for it.
  const cookie = forged.get("cookie") ?? "";
  for (const path of ["/api/vault", "/api/keys", "/", "/realty/posts"]) {
    assert.equal(await decide(path, "GET", cookie), "sign-in", path);
  }
  assert.equal(await decide("/api/vault?token=owner-token", "GET", undefined), "sign-in");
  assert.equal(await decide("/api/vault", "GET", "bops_window=anything"), "sign-in");
  // A session for the owner passes only with that cookie, whatever headers a caller adds.
  const owner = await session(OWNER);
  assert.equal(await decide("/api/vault", "GET", `bops_gate=${owner}`), "pass");
  assert.equal(await decide("/api/vault", "GET", `bops_window=x`), "sign-in");
});

test("a session signed with another secret is rejected, and so is a forged payload with a copied signature", async () => {
  const good = await session(OWNER);
  const other = { ...cfg, secret: "z".repeat(40) };
  assert.equal(await readSession(good, other), null);
  assert.equal(await decide("/api/vault", "GET", `bops_gate=${await makeSession(OWNER, other)}`), "sign-in");
  const body = Buffer.from(JSON.stringify({ email: OWNER, exp: 9e9 })).toString("base64url");
  assert.equal(await readSession(`${body}.${good.split(".")[1]}`, cfg), null);
});

test("an expired session (over 12 hours) is rejected", async () => {
  assert.equal(SESSION_SECONDS, 12 * 60 * 60);
  const old = await session(OWNER, Date.now() - (SESSION_SECONDS + 60) * 1000);
  assert.equal(await readSession(old, cfg), null);
  assert.equal(await decide("/api/vault", "GET", `bops_gate=${old}`), "sign-in");
  const fresh = await session(OWNER, Date.now() - (SESSION_SECONDS - 600) * 1000);
  assert.equal(await readSession(fresh, cfg), OWNER, "still good 11h50m in");
});

test("a session whose email has left the allowlist is rejected", async () => {
  const gone = await session("someone@elsewhere.example");
  assert.equal(await readSession(gone, cfg), null);
  const state = await signValue("state", { email: OWNER, exp: 9e9 }, cfg.secret);
  assert.equal(await readSession(state, cfg), null, "a state cookie is not a session");
});

test("OAuth: the ID token must be verified, from the right issuer and audience, current, and for an allowed Workspace account", () => {
  const tok = (c: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(c)).toString("base64url")}.s`;
  const now = Date.now();
  const good = { iss: "https://accounts.google.com", aud: "client-id", exp: now / 1000 + 600, email: "Kerry@1on1.example", email_verified: true, hd: "1on1.example" };
  assert.deepEqual(idTokenIdentity(tok(good), "client-id", now), { email: "kerry@1on1.example", hd: "1on1.example" });
  assert.equal(idTokenIdentity(tok({ ...good, email_verified: false }), "client-id", now), null, "unverified email");
  assert.equal(idTokenIdentity(tok({ ...good, email_verified: "no" }), "client-id", now), null, "a non-true verified flag");
  assert.equal(idTokenIdentity(tok({ ...good, aud: "other-client" }), "client-id", now), null, "wrong audience");
  assert.equal(idTokenIdentity(tok({ ...good, iss: "https://evil.example" }), "client-id", now), null, "wrong issuer");
  assert.equal(idTokenIdentity(tok({ ...good, exp: 1 }), "client-id", now), null, "expired");
  assert.equal(idTokenIdentity("not-a-token", "client-id", now), null);
});

test("OAuth: a whole-domain entry needs the Workspace claim (hd); an exact address needs only the verified email", () => {
  const allowed = ["@1on1.example", "miles@simplyintense.example"];
  assert.equal(identityAllowed({ email: "kerry@1on1.example", hd: "1on1.example" }, allowed), true);
  assert.equal(identityAllowed({ email: "kerry@1on1.example", hd: null }, allowed), false, "a consumer account on the same name is not the Workspace");
  assert.equal(identityAllowed({ email: "kerry@1on1.example", hd: "evil.example" }, allowed), false, "another Workspace");
  assert.equal(identityAllowed({ email: "miles@simplyintense.example", hd: null }, allowed), true, "an exact allowlisted address");
  assert.equal(identityAllowed({ email: "miles@simplyintense.example", hd: "other.example" }, allowed), true, "an exact address needs no hd");
  assert.equal(identityAllowed({ email: "stranger@gmail.example", hd: null }, allowed), false);
});

test("rate limit: 20 sign-in attempts in ten minutes per address, the 21st is limited, and it resets after the window", () => {
  const limiter = makeRateLimiter(20, 10 * 60_000);
  const t0 = 1_000_000;
  for (let i = 0; i < 20; i++) assert.equal(limiter.allow("1.2.3.4", t0 + i), true, `attempt ${i + 1}`);
  assert.equal(limiter.allow("1.2.3.4", t0 + 21), false, "the 21st is limited");
  assert.equal(limiter.allow("1.2.3.4", t0 + 10 * 60_000 - 1), false, "still limited just before the window ends");
  assert.equal(limiter.allow("5.6.7.8", t0 + 22), true, "another address is its own bucket");
  assert.equal(limiter.allow("1.2.3.4", t0 + 10 * 60_000 + 20), true, "allowed again once the early attempts age out");
});

test("rate limit: the address is the platform's header, else the first hop of X-Forwarded-For", () => {
  assert.equal(clientIp(new Headers({ "fly-client-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" })), "9.9.9.9");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "2.2.2.2, 10.0.0.1" })), "2.2.2.2");
  assert.equal(clientIp(new Headers()), "unknown");
});

test("CSRF: a write from a foreign origin is refused; with no Origin, only Sec-Fetch-Site same-origin passes; same-site passes", () => {
  const ours = (h: string) => h === "bop.example";
  const w = (origin: string | null, secFetchSite: string | null, method = "POST") => sameSiteWrite({ method, origin, secFetchSite, ours });
  assert.equal(w("https://evil.example", null), false, "foreign origin");
  assert.equal(w("https://evil.example", "same-origin"), false, "a foreign origin is refused whatever Sec-Fetch-Site says");
  assert.equal(w(null, null), false, "no origin and no Sec-Fetch-Site");
  assert.equal(w(null, "cross-site"), false);
  assert.equal(w(null, "same-origin"), true, "same-origin with no Origin");
  assert.equal(w("https://bop.example", null), true, "same-site origin");
  assert.equal(w("null", "same-origin"), false, "a sandboxed page's null origin");
  assert.equal(w("not a url", null), false);
  assert.equal(w("https://evil.example", null, "GET"), true, "reads aren't writes");
});

test("security headers: HSTS, nosniff, SAMEORIGIN frames, a strict referrer, and frame-ancestors 'self' (not DENY/'none') on every response", async () => {
  const groups = SECURITY_HEADER_GROUPS;
  assert.ok(groups.length >= 2);
  const all = Object.fromEntries(groups.flatMap((g) => g.headers.map((h) => [h.key, h.value])));
  assert.equal(all["Strict-Transport-Security"], "max-age=31536000; includeSubDomains");
  assert.equal(all["X-Content-Type-Options"], "nosniff");
  assert.equal(all["X-Frame-Options"], "SAMEORIGIN");
  assert.equal(all["Referrer-Policy"], "strict-origin-when-cross-origin");
  const csp = groups.flatMap((g) => g.headers).find((h) => h.key === "Content-Security-Policy");
  assert.equal(csp?.value, "frame-ancestors 'self'", "only frame-ancestors, and 'self'");
  assert.ok(groups.some((g) => g.source === "/:path*"), "every path");
  assert.ok(groups.find((g) => g.headers.some((h) => h.key === "Content-Security-Policy"))?.source.includes("made-apps"), "the sandboxed made apps keep their own CSP");
});

/* ---------------- The agent's copy ---------------- */

const DESK_DIR = join(import.meta.dirname, "../../app/realty/desk");
const MARKET_DIR = join(import.meta.dirname, "../../app/realty/market");
/** Source with the comments removed: a line that's only a comment (JSDoc, //) and /* blocks. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

test("agents see 'Strong match' and no number on a lead card; owners keep the score", () => {
  assert.equal(leadLabel(false, 88), "Strong match");
  assert.doesNotMatch(leadLabel(false, 88), /\d|score/i);
  assert.equal(leadLabel(true, 88), "Lead · score 88");
});

test("the lead section copy: owners keep the 75 and the office line; agents get neither the number nor 'score'", () => {
  const agent = leadsSectionCopy(false);
  assert.equal(agent, "Strong matches for the listings you hold in the 1on1 CRM: who asked, the listing, and a suggested message.");
  assert.doesNotMatch(agent, /\b75\b|score|office/i, "no threshold number, no score, and not the office line");
  assert.match(leadsSectionCopy(true), /75 and above/);
});

test("the live feed's status line is for owners only", () => {
  assert.equal(showFeedStatus(false), false);
  assert.equal(showFeedStatus(true), true);
});

test("no 'Bops' in agent-visible text on the desk and online search (components and pages; comments are not visible)", () => {
  for (const dir of [DESK_DIR, MARKET_DIR]) {
    for (const f of readdirSync(dir).filter((n) => /\.(tsx|ts)$/.test(n))) {
      const text = codeOnly(readFileSync(join(dir, f), "utf8"));
      // Owner-only copy is allowed to say Bops; only text an agent can see is checked, so owner blocks are stripped.
      const visible = text.replace(/\{owner \? [\s\S]*?: [^}]*\}/g, "");
      assert.doesNotMatch(visible, /bops/i, `${f} has "Bops" in agent-visible text`);
    }
  }
});

test("the desk page draws the feed status line only through showFeedStatus(owner), and the lead cards take their label from leadLabel", () => {
  const page = codeOnly(readFileSync(join(DESK_DIR, "page.tsx"), "utf8"));
  assert.match(page, /showFeedStatus\(owner\)/, "the feed status is gated on the owner");
  assert.match(page, /\{leadsSectionCopy\(owner\)\}/, "the lead section copy comes from leadsSectionCopy");
  const cards = codeOnly(readFileSync(join(DESK_DIR, "lead-cards.tsx"), "utf8"));
  assert.doesNotMatch(cards, /Lead · score/, "the label comes from leadLabel, which gives owners the score");
  assert.match(cards, /leadLabel\(owner, c\.score\)/);
});

/* ---------------- Data scoping: an agent sets status only on their own desk ---------------- */

import { setMatchFollowUp } from "../node/match-status.ts";
import { PeriskopeStore, requestIdOf } from "../node/periskope-store.ts";
import { listingKey } from "../flow/match-status.ts";
import { NOT_CONNECTED, type CrmSeam } from "../flow/crm-seam.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const PHONE_KERRY = "+18685550101";
const PHONE_OTHER = "+18685550202";
const OTHER = "sam@1on1.example";
const NOW = new Date("2026-11-17T12:00:00.000Z");
const ITEM = { title: "Alpha", url: "https://example.com/listing/alpha", area: "Westmoorings", price: "TT$8,500", beds: 2, source: "Example Realty", reason: "Same area" };
const SEAM: CrmSeam = {
  ...NOT_CONNECTED,
  connected: true,
  agents: async () => [
    { id: 7, name: "Kerry", email: AGENT, phone: PHONE_KERRY },
    { id: 8, name: "Sam", email: OTHER, phone: PHONE_OTHER },
  ],
};

async function statusPost(email: string, root: string, requestId: string) {
  const cookie = `${GATE_COOKIE}=${await makeSession(email, CFG)}`;
  return setMatchFollowUp(
    new Request("https://bop.example/api/realty/match-status", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: "https://bop.example" },
      body: JSON.stringify({ requestId, listingKey: listingKey(ITEM), status: "contacted" }),
    }),
    { env: ENV, root, now: () => NOW, seam: SEAM },
  );
}

test("an agent may set a status only on a match in their own desk view; another agent's request is refused, an owner may set any", async () => {
  const root = mkdtempSync(join(tmpdir(), "scope-"));
  const store = new PeriskopeStore(root);
  store.addLive({ messageId: "msg-k", chatId: "g", senderPhone: PHONE_KERRY, receivedAt: "2026-11-17T11:00:00.000Z", request: { intent: "rent", area: "Westmoorings", beds: 2, propertyType: "apartment", priceMin: null, priceMax: 9000, currency: "TTD", monthly: true }, status: "matched", matchedAt: "2026-11-17T11:00:00.000Z", matches: [ITEM] });
  const kerryReq = requestIdOf("msg-k");

  // Sam (another agent) doesn't hold this listing and didn't send the request: the desk doesn't show it to Sam.
  const sam = await statusPost(OTHER, root, kerryReq);
  assert.notEqual(sam.status, 200, "Sam can't set a status on Kerry's request");
  assert.equal(store.matchStatuses().length, 0);

  // Kerry's own request is on Kerry's desk: allowed.
  const kerry = await statusPost(AGENT, root, kerryReq);
  assert.equal(kerry.status, 200);
  assert.equal(store.matchStatuses().length, 1);

  // An owner may set any match on the desk.
  const owner = await statusPost(OWNER, root, kerryReq);
  assert.equal(owner.status, 200);
});

test("static files: only top-level or directly under /realty/, so a dynamic page can't pose as one", () => {
  assert.equal(isStaticAsset("/realty/1on1-realtors-logo.png"), true);
  assert.equal(isStaticAsset("/favicon.ico"), true);
  assert.equal(isStaticAsset("/realty/posts/abc.png"), false);
  assert.equal(agentMayReach("/realty/posts/abc.png", "GET"), false);
  assert.equal(agentMayReach("/api/realty/posts/abc.png", "GET"), false);
});
