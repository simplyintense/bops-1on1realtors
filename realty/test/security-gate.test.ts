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
/** The nine AI Desk pages (the sidebar's group, staff-pages.ts): every signed-in staff member may open each, including "/". */
const AI_DESK_PAGES = ["/", "/realty/desk", "/realty/automatch", "/realty/search", "/realty/posts", "/realty/market", "/realty/digest", "/realty/alerts", "/realty/learn"];
/** Pages that are not AI Desk pages, and near-misses of them: an agent is sent to the desk. */
const NOT_AI_DESK_PAGES = ["/realty-demo", "/realty/requests", "/realty/postsx", "/realty/automatchx", "/realty/digests", "/realty/learning", "/realty/alertsx", "/anything"];
/** Owner-only mutation APIs and the owners' screens' APIs: an agent's call is 403, a GET or a POST. */
const OWNER_ONLY_APIS = ["/api/realty/replay", "/api/realty/automatch-alert", "/api/realty/admin-digest", "/api/realty/posts", "/api/realty/posts/3fa9c2d1e8b74f60a1b2c3d4", "/api/realty/search/export", "/api/members", "/api/workspaces", "/api/vnc", "/api/call", "/api/routines", "/api/mail"];

test("agents: Supply & Demand and a stored post's page open to any signed-in staff; the owners' post list, the owners' APIs and the export stay closed", async () => {
  const agent = await session(AGENT);
  const at = (path: string, method = "GET") => decide(path, method, `bops_gate=${agent}`);
  assert.equal(await at("/realty/search"), "pass");
  assert.equal(await at("/realty/posts/3fa9c2d1e8b74f60a1b2c3d4"), "pass", "a stored post, by its request id");
  assert.equal(await at("/realty/posts/3fa9.png"), "desk", "a dot is not an id");
  assert.equal(await at("/realty/posts/3fa9/extra"), "desk", "one id only");
  assert.equal(await at("/realty/posts"), "pass", "the list of all posts is open to any signed-in staff");
  assert.equal(await at("/realty/posts/"), "desk");
  assert.equal(await at("/realty/searchable"), "desk", "a prefix isn't a path");
  assert.equal(await at("/api/realty/search"), "forbidden", "the search API stays owner-only");
  assert.equal(await at("/api/realty/search/export"), "forbidden", "the export stays owner-only");
  assert.equal(await at("/api/realty/posts"), "forbidden", "the posts API stays owner-only");
  assert.equal(await at("/api/realty/posts/3fa9c2d1e8b74f60a1b2c3d4"), "forbidden", "the post API stays owner-only");
  assert.equal(await at("/realty/posts/3fa9c2d1e8b74f60a1b2c3d4", "POST"), "desk", "a POST to a page is not a page read");
});

test("agents: every AI Desk page opens (GET), and the owners' APIs are refused with 403; every other page goes to the desk", async () => {
  const agent = await session(AGENT);
  for (const api of SENSITIVE_APIS) assert.equal(await decide(api, "GET", `bops_gate=${agent}`), "forbidden", api);
  for (const page of AI_DESK_PAGES) assert.equal(await decide(page, "GET", `bops_gate=${agent}`), "pass", page);
  for (const page of AI_DESK_PAGES) assert.equal(await decide(page, "HEAD", `bops_gate=${agent}`), "pass", `HEAD ${page}`);
  for (const page of NOT_AI_DESK_PAGES) assert.equal(await decide(page, "GET", `bops_gate=${agent}`), "desk", page);
  for (const api of OWNER_ONLY_APIS) {
    assert.equal(await decide(api, "GET", `bops_gate=${agent}`), "forbidden", `GET ${api}`);
    assert.equal(await decide(api, "POST", `bops_gate=${agent}`), "forbidden", `POST ${api}`);
  }
  assert.equal(await decide("/", "POST", `bops_gate=${agent}`), "desk", "a POST to the root is not a page read");
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

/** The Bot Workspace's own state and sign-in status, and the chat routes a staff member may use (lib/gate.ts AGENT_APIS). */
const WORKSPACE_READS = ["/api/state", "/api/auth/status"];
const WORKSPACE_CHAT_WRITES = ["/api/chats", "/api/chats/stf_6162_6b65727279/messages", "/api/chats/stf_6162_6b65727279/read"];

test("staff Bot Workspace: its page, state and sign-in status open to a signed-in agent; the chat is open by exact path; everything else stays closed", async () => {
  const agent = await session(AGENT);
  const at = (path: string, method = "GET") => decide(path, method, `bops_gate=${agent}`);
  for (const path of ["/", ...WORKSPACE_READS]) assert.equal(await at(path), "pass", `GET ${path}`);
  for (const path of WORKSPACE_READS) assert.equal(await at(path, "HEAD"), "pass", `HEAD ${path}`);
  for (const path of WORKSPACE_CHAT_WRITES) assert.equal(await at(path, "POST"), "pass", `POST ${path}`);
  // The state and sign-in status are read only; the owner's chat (colon id) and the chat-admin routes are not the staff's.
  for (const path of ["/api/state", "/api/auth/status"]) assert.equal(await at(path, "POST"), "forbidden", `POST ${path}`);
  assert.equal(await at("/api/chats/stf_6162_6b65727279/messages"), "forbidden", "a chat's messages are written with POST only");
  assert.equal(await at("/api/chats/stf_6162_6b65727279/messages", "DELETE"), "forbidden", "no deleting messages");
  assert.equal(await at("/api/chats/stf_6162_6b65727279/compact", "POST"), "forbidden", "compacting a chat is the owner's");
  assert.equal(await at("/api/chats", "DELETE"), "forbidden", "deleting a group chat is the owner's");
  assert.equal(await at("/api/chats/bot:wendy/messages", "POST"), "forbidden", "the owner's default bot chat (botChatId) is never the staff's");
  assert.equal(await at("/api/chats/bot%3Awendy/messages", "POST"), "forbidden", "the same, encoded");
  assert.equal(await at("/api/chats/..%2Fkeys/messages", "POST"), "forbidden", "no path tricks");
  assert.equal(await at("/api/chats/stf_6162/messages/extra", "POST"), "forbidden", "one message route only");
  assert.equal(await at("/api/chats-admin", "POST"), "forbidden", "a prefix isn't the chat route");
  assert.equal(await at("/api/state/../keys", "GET"), "forbidden", "no traversal past the state route");
  assert.equal(await at("/api/state/extra", "GET"), "forbidden");
  assert.equal(await at("/api/auth/start", "POST"), "forbidden", "signing in to Orgo stays the owner's");
  assert.equal(await at("/api/auth/status/extra", "GET"), "forbidden");
  assert.equal(await at("/api/keys/reveal", "POST"), "forbidden", "keys stay the owner's");
  assert.equal(await at("/api/bots", "POST"), "forbidden", "bots stay the owner's");
  assert.equal(await at("/api/sessions/s1/terminal", "POST"), "forbidden", "terminals stay the owner's");
  assert.equal(await at("/api/input", "POST"), "forbidden", "screen input stays the owner's");
  assert.equal(await at("/api/uploads", "POST"), "forbidden", "uploads are not opened (no images from staff)");
  assert.equal(await at("/api/view", "POST"), "forbidden", "presence is not opened");
});

test("signed out: the Bot Workspace, its state and sign-in status, and its chat APIs all fail closed (a sign-in, or a 401)", async () => {
  assert.equal(await decide("/", "GET", ""), "sign-in");
  for (const path of WORKSPACE_READS) assert.equal(await decide(path, "GET", ""), "sign-in", `GET ${path}`);
  for (const path of WORKSPACE_CHAT_WRITES) assert.equal(await decide(path, "POST", ""), "sign-in", `POST ${path}`);
  assert.equal(await decide("/api/state", "GET", "bops_gate=forged.value"), "sign-in", "a forged cookie");
  // The first character of the payload: every bit of it is in the MAC, so a changed one never verifies (the last one of the signature can carry unused bits).
  const good = await makeSession(OWNER, CFG);
  const tampered = (good[0] === "A" ? "B" : "A") + good.slice(1);
  assert.equal(await decide("/api/state", "GET", `bops_gate=${tampered}`), "sign-in", "a tampered session");
});

test("the owner keeps the Bot Workspace APIs; a teacher gets them too (as every staff member does), but not the owner's writes", async () => {
  const owner = await session(OWNER);
  for (const path of [...WORKSPACE_READS, ...WORKSPACE_CHAT_WRITES]) assert.equal(await decide(path, "POST", `bops_gate=${owner}`), "pass", `owner POST ${path}`);
  const teacher = await session(TEACHER);
  assert.equal(await decide("/api/state", "GET", `bops_gate=${teacher}`), "pass");
  assert.equal(await decide("/api/state", "POST", `bops_gate=${teacher}`), "forbidden");
  assert.equal(await decide("/api/bots", "POST", `bops_gate=${teacher}`), "forbidden");
});

test("owners reach every page and API, as before", async () => {
  const owner = await session(OWNER);
  for (const path of [...SENSITIVE_APIS, ...OWNER_ONLY_APIS, ...AI_DESK_PAGES, ...NOT_AI_DESK_PAGES, "/api/realty/match-status", "/api/realty/not-a-lead"]) {
    assert.equal(await decide(path, "POST", `bops_gate=${owner}`), "pass", path);
  }
});

test("teachers reach the teach page (as every staff member does) and its POST APIs, and nothing owners-only", async () => {
  const teacher = await session(TEACHER);
  assert.equal(await decide("/realty/learn", "GET", `bops_gate=${teacher}`), "pass");
  assert.equal(await decide("/api/realty/learn", "POST", `bops_gate=${teacher}`), "pass");
  assert.equal(await decide("/api/realty/learn/questions", "POST", `bops_gate=${teacher}`), "pass");
  for (const [path, method] of [["/api/realty/learn/area", "POST"], ["/api/realty/learn/ignore", "POST"], ["/api/realty/learn/taught", "PATCH"], ["/api/realty/learn/taught", "DELETE"]] as const) {
    assert.equal(await decide(path, method, `bops_gate=${teacher}`), "pass", `${method} ${path}`);
  }
  assert.equal(await decide("/api/vault", "GET", `bops_gate=${teacher}`), "forbidden");
  for (const api of OWNER_ONLY_APIS) assert.equal(await decide(api, "POST", `bops_gate=${teacher}`), "forbidden", api);
});

test("an agent can't teach: the teach APIs are teacher-only, while the teach page is open to every staff member", async () => {
  const agent = await session(AGENT);
  assert.equal(await decide("/realty/learn", "GET", `bops_gate=${agent}`), "pass");
  assert.equal(await decide("/api/realty/learn", "POST", `bops_gate=${agent}`), "forbidden");
  assert.equal(await decide("/api/realty/learn/questions", "POST", `bops_gate=${agent}`), "forbidden");
  for (const [path, method] of [["/api/realty/learn/area", "POST"], ["/api/realty/learn/ignore", "POST"], ["/api/realty/learn/taught", "PATCH"], ["/api/realty/learn/taught", "DELETE"]] as const) {
    assert.equal(await decide(path, method, `bops_gate=${agent}`), "forbidden", `${method} ${path}`);
  }
  assert.equal(await decide("/api/realty/learn/preview", "POST", `bops_gate=${agent}`), "pass", "any staff member may read a sample");
});

test("agentMayReach: the desk is open and the root matches exactly, so the '/' trap can't open the site", () => {
  assert.equal(agentMayReach("/realty/desk", "GET"), true);
  assert.equal(agentMayReach("/", "GET"), true, "Workspace, the root only");
  assert.equal(agentMayReach("/", "HEAD"), true);
  assert.equal(agentMayReach("/", "POST"), false, "no writes to the root");
  assert.equal(agentMayReach("/api/realty/replay", "GET"), false, "the owners' replay API");
  assert.equal(agentMayReach("/api/realty/replay", "POST"), false);
  assert.equal(agentMayReach("/api/members", "GET"), false, "the Workspace members API");
  assert.equal(agentMayReach("/api/random/path", "GET"), false, "a random API path");
  assert.equal(agentMayReach("/some/random/path", "GET"), false, "a random page is not the root's prefix");
  assert.equal(agentMayReach("/realty", "GET"), false, "the realty index is not a page");
  assert.equal(agentMayReach("/realty/posts", "GET"), true, "the list of all posts, exact");
  assert.equal(agentMayReach("/realty/posts/3fa9c2d1e8b74f60a1b2c3d4", "GET"), true, "one stored post");
  assert.equal(agentMayReach("/realty/posts/3fa9/extra", "GET"), false, "one id only");
  assert.equal(agentMayReach("/realty/learn", "GET"), true, "the teach page for an agent");
  assert.equal(agentMayReach("/realty/learn", "POST"), false, "a page takes no POST");
  assert.equal(agentMayReach("/api/realty/learn", "POST"), false, "the teach API needs a teacher");
  assert.equal(agentMayReach("/api/realty/learn", "POST", { teacher: true }), true, "...and a teacher may POST it");
  assert.equal(agentMayReach("/api/realty/learn/preview", "POST"), true, "the preview is for any staff member");
  assert.equal(agentMayReach("/api/realty/learn/preview", "GET"), false, "the preview takes POST only");
  assert.equal(agentMayReach("/api/realty/learn/area", "POST"), false, "teaching a place needs a teacher");
  assert.equal(agentMayReach("/api/realty/learn/area", "POST", { teacher: true }), true);
  assert.equal(agentMayReach("/api/realty/learn/taught", "PATCH"), false, "editing a past answer needs a teacher");
  assert.equal(agentMayReach("/api/realty/learn/taught", "PATCH", { teacher: true }), true);
  assert.equal(agentMayReach("/api/realty/learn/taught", "GET", { teacher: true }), false, "the taught list is not an API");
  assert.equal(agentMayReach("/api/state", "GET"), true, "the Bot Workspace's state, redacted for staff");
  assert.equal(agentMayReach("/api/state", "HEAD"), true);
  assert.equal(agentMayReach("/api/state", "POST"), false, "the state is read only");
  assert.equal(agentMayReach("/api/auth/status", "GET"), true, "the sign-in status");
  assert.equal(agentMayReach("/api/auth/start", "POST"), false, "signing in to Orgo is the owner's");
  assert.equal(agentMayReach("/api/chats", "POST"), true, "a staff member's own chat (made on first use)");
  assert.equal(agentMayReach("/api/chats", "GET"), false);
  assert.equal(agentMayReach("/api/chats/stf_6162_6b65727279/messages", "POST"), true, "a staff chat's messages");
  assert.equal(agentMayReach("/api/chats/stf_6162_6b65727279/read", "POST"), true);
  assert.equal(agentMayReach("/api/chats/bot:wendy/messages", "POST"), false, "the owner's chat id has a colon, so it isn't matched");
  assert.equal(agentMayReach("/api/chats/stf_6162/messages", "GET"), false);
  assert.equal(agentMayReach("/api/chats/stf_6162/messages", "DELETE"), false);
  assert.equal(agentMayReach("/api/chats/stf_6162/compact", "POST"), false);
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
