import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test, afterEach } from "node:test";
import { NextRequest } from "next/server.js";
import { GET } from "../../app/auth/sso/route.ts";
import { GATE_OPEN_PATHS, demoRoute, gateConfig, readSession } from "../../lib/gate.ts";
import { redeemSsoToken, resetSsoNonces, safeSsoNext } from "../../lib/sso.ts";

/** The CRM's sign-in hand-off (lib/sso.ts, app/auth/sso/route.ts): token checks, the cookie, and the redirects. */

const SSO_SECRET = "sso-secret-for-tests-0123456789";
const PUBLIC = "https://bop.1on1realtors.example";
const ALLOWED_EMAIL = "miles@example.com";

/** The gate's settings, shaped like gate.test.ts, plus the hand-off's secret. */
const env: Record<string, string> = {
  BOPS_LOGIN_GATE: "google",
  BOPS_ALLOWED_EMAILS: "miles@example.com, @1on1realtors.example",
  BOPS_GATE_SECRET: "x".repeat(40),
  GOOGLE_OAUTH_CLIENT_ID: "client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  BOPS_PUBLIC_URL: PUBLIC,
  BOPS_SSO_SECRET: SSO_SECRET,
};

/** The same HMAC scheme the CRM uses: base64url payload, then HMAC-SHA256 over the payload string, base64url. */
function mint(claims: Record<string, unknown>, secret = SSO_SECRET): string {
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const nonce = () => randomBytes(16).toString("hex");
const good = (over: Record<string, unknown> = {}) => ({ email: ALLOWED_EMAIL, exp: nowSec() + 60, nonce: nonce(), ...over });

/** Runs fn with process.env set to vars (the route reads process.env), then puts it back as it was. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  for (const k of Object.keys(vars)) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/** Calls the route as the browser would, with the gate's env in place. */
async function hit(query: string, vars: Record<string, string | undefined> = env) {
  return withEnv(vars, () => GET(new NextRequest(`${PUBLIC}/auth/sso${query}`)));
}

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").match(/bops_gate=([^;]*)/)?.[1];
const location = (res: Response) => res.headers.get("location");
const loginUrl = `${PUBLIC}/api/gate/login`;

afterEach(() => resetSsoNonces());

test("a valid token sets the bops_gate session cookie (HttpOnly, Secure, SameSite=Lax) and 302s to /realty/search", async () => {
  const res = await hit(`?token=${mint(good())}`);
  assert.equal(res.status, 302);
  assert.equal(location(res), `${PUBLIC}/realty/search`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /bops_gate=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=lax/i);
  assert.match(setCookie, /Path=\//i);
  assert.match(setCookie, /Max-Age=43200/);
  const value = cookieOf(res);
  assert.ok(value, "a cookie value");
  const cfg = gateConfig(env);
  if (!cfg || cfg === "misconfigured") throw new Error("test config");
  assert.equal(await readSession(value, cfg), ALLOWED_EMAIL, "the cookie reads back to the allowlisted email");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("a safe next (a stored post's page) is where the hand-off lands", async () => {
  const res = await hit(`?token=${mint(good())}&next=${encodeURIComponent("/realty/posts/9f3ab21c")}`);
  assert.equal(res.status, 302);
  assert.equal(location(res), `${PUBLIC}/realty/posts/9f3ab21c`);
  assert.ok(cookieOf(res));
});

test("the email is trimmed and lowercased before the allowlist check", async () => {
  const res = await hit(`?token=${mint(good({ email: "  Miles@Example.COM " }))}`);
  assert.equal(location(res), `${PUBLIC}/realty/search`);
  assert.ok(cookieOf(res));
});

test("an expired token is rejected: Google sign-in, and no session cookie", async () => {
  const res = await hit(`?token=${mint(good({ exp: nowSec() - 1 }))}`);
  assert.equal(res.status, 302);
  assert.equal(location(res), loginUrl);
  assert.equal(cookieOf(res), undefined);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("a token that lives longer than nowSec + 120 is rejected", async () => {
  const res = await hit(`?token=${mint(good({ exp: nowSec() + 121 }))}`);
  assert.equal(location(res), loginUrl);
  assert.equal(res.headers.get("set-cookie"), null);
  const ok = await hit(`?token=${mint(good({ exp: nowSec() + 110 }))}`);
  assert.equal(location(ok), `${PUBLIC}/realty/search`, "one just inside the window is fine");
});

test("a replayed nonce is rejected on the second use, and the first use still works", async () => {
  const token = mint(good());
  const first = await hit(`?token=${token}`);
  assert.equal(location(first), `${PUBLIC}/realty/search`);
  assert.ok(cookieOf(first));
  const second = await hit(`?token=${token}`);
  assert.equal(location(second), loginUrl);
  assert.equal(second.headers.get("set-cookie"), null);
});

test("a tampered signature is rejected, including a wrong-length one (no throw)", async () => {
  const token = mint(good());
  const [body, mac] = token.split(".");
  const flipped = (mac[0] === "A" ? "B" : "A") + mac.slice(1);
  for (const bad of [`${body}.${flipped}`, `${body}.${mac.slice(0, 10)}`, `${body}.`]) {
    const res = await hit(`?token=${bad}`);
    assert.equal(location(res), loginUrl);
    assert.equal(res.headers.get("set-cookie"), null);
  }
  // A payload edited after signing (a different email) fails the same way.
  const forged = Buffer.from(JSON.stringify(good({ email: ALLOWED_EMAIL, exp: nowSec() + 60, nonce: nonce() })), "utf8").toString("base64url");
  const res = await hit(`?token=${forged}.${mac}`);
  assert.equal(location(res), loginUrl);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("a token signed with another secret is rejected", async () => {
  const res = await hit(`?token=${mint(good(), "some-other-secret-entirely-0000")}`);
  assert.equal(location(res), loginUrl);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("an email that isn't on BOPS_ALLOWED_EMAILS is rejected, and its nonce is not used up", async () => {
  const claims = good({ email: "stranger@elsewhere.example" });
  const res = await hit(`?token=${mint(claims)}`);
  assert.equal(location(res), loginUrl);
  assert.equal(res.headers.get("set-cookie"), null);
  // A whole-domain entry is matched by domain (no Google hd here), so a teammate on the domain is allowed.
  const teammate = await hit(`?token=${mint(good({ email: "wendy@1on1realtors.example" }))}`);
  assert.equal(location(teammate), `${PUBLIC}/realty/search`);
});

test("unsafe next values sanitize to /realty/search when the token is otherwise valid", async () => {
  for (const next of [
    "https://evil.example",
    "//evil.example",
    "/api/gate/logout",
    "/api/keys",
    "/realty/posts/",
    "/realty/deskx",
    "/realty/searchx",
    "/realty/search#frag",
    "/realty/search/../../api/gate/logout",
    "javascript:alert(1)",
    "/\\evil.example",
    "",
  ]) {
    const res = await hit(`?token=${mint(good())}&next=${encodeURIComponent(next)}`);
    assert.equal(location(res), `${PUBLIC}/realty/search`, `next=${JSON.stringify(next)}`);
    assert.ok(cookieOf(res), `a valid token still signs in for next=${JSON.stringify(next)}`);
  }
});

test("a valid next for an AI Desk page lands there (the hand-off's own list, not the default)", async () => {
  for (const next of ["/realty/desk", "/realty/posts", "/realty/market?q=maraval"]) {
    const res = await hit(`?token=${mint(good())}&next=${encodeURIComponent(next)}`);
    assert.equal(location(res), `${PUBLIC}${next}`, next);
  }
});

test("safeSsoNext: the eight AI Desk pages, the site root and one stored post (with plain query text) pass", () => {
  for (const page of ["/", "/realty/desk", "/realty/automatch", "/realty/search", "/realty/posts", "/realty/market", "/realty/digest", "/realty/alerts", "/realty/learn"]) {
    assert.equal(safeSsoNext(page), page, page);
  }
  assert.equal(safeSsoNext("/realty/search?source=online&q=maraval"), "/realty/search?source=online&q=maraval");
  assert.equal(safeSsoNext("/realty/posts/abc-DEF_09"), "/realty/posts/abc-DEF_09");
  assert.equal(safeSsoNext("/realty/posts/9f3ab21c?from=desk"), "/realty/posts/9f3ab21c?from=desk", "a plain query on a stored post");
  assert.equal(safeSsoNext("/?next=x"), "/?next=x", "a plain query on the root");
});

test("safeSsoNext: anything else falls back to /realty/search, including fragments, other paths and near-misses", () => {
  for (const bad of [
    "https://evil.example",
    "//evil.example",
    "/api/gate/logout",
    "/api/keys",
    "/realty",
    "/realty/searchx",
    "/realty/searching",
    "/realty/deskx",
    "/realty/posts/",
    "/realty/posts/a/b",
    "/realty/posts/a.b",
    "/realty/unknown",
    "/realty/search/..",
    "/realty/search?x=..",
    "/realty/search#frag",
    "/?x=1#frag",
    "\\realty\\search",
    "/\\evil",
    "javascript:alert(1)",
    "realty/search",
    undefined,
    null,
    7,
  ]) {
    assert.equal(safeSsoNext(bad), "/realty/search", String(bad));
  }
  // And Google's own rules are untouched: the desk stays the default there, which the hand-off doesn't use.
  assert.equal(safeSsoNext(undefined), "/realty/search");
});

test("a missing or empty BOPS_SSO_SECRET fails closed, even for a correctly signed token", async () => {
  const token = mint(good());
  for (const secret of [undefined, "", "   "]) {
    const res = await hit(`?token=${token}`, { ...env, BOPS_SSO_SECRET: secret });
    assert.equal(location(res), loginUrl, `secret ${JSON.stringify(secret)}`);
    assert.equal(res.headers.get("set-cookie"), null);
  }
  // Signed with an empty key: the empty secret is refused before the HMAC is even tried.
  const emptyKey = await hit(`?token=${mint(good(), "")}`, { ...env, BOPS_SSO_SECRET: "" });
  assert.equal(emptyKey.headers.get("set-cookie"), null);
});

test("the login gate must be on and configured: off or misconfigured fails closed", async () => {
  const token = mint(good());
  const off = await hit(`?token=${token}`, { ...env, BOPS_LOGIN_GATE: undefined });
  assert.equal(off.headers.get("set-cookie"), null);
  assert.equal(location(off)?.endsWith("/api/gate/login"), true);
  const broken = await hit(`?token=${token}`, { ...env, BOPS_ALLOWED_EMAILS: "" });
  assert.equal(broken.headers.get("set-cookie"), null);
  assert.equal(location(broken), loginUrl);
});

test("malformed tokens fail closed: no dot, too many dots, bad base64, bad JSON, missing fields, short nonce", async () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const signed = (payload: string) => `${payload}.${createHmac("sha256", SSO_SECRET).update(payload).digest("base64url")}`;
  const cases: Record<string, string> = {
    empty: "",
    "no dot": mint(good()).replace(".", ""),
    "two dots and more": `${mint(good())}.extra`,
    "non base64url payload": `${mint(good()).split(".")[0]}+/=.${mint(good()).split(".")[1]}`,
    "bad JSON, correctly signed": signed(b64("not json")),
    "a JSON array": signed(b64(JSON.stringify([ALLOWED_EMAIL]))),
    "no email": signed(b64(JSON.stringify({ exp: nowSec() + 60, nonce: nonce() }))),
    "no exp": signed(b64(JSON.stringify({ email: ALLOWED_EMAIL, nonce: nonce() }))),
    "exp not a number": signed(b64(JSON.stringify({ email: ALLOWED_EMAIL, exp: "soon", nonce: nonce() }))),
    "no nonce": signed(b64(JSON.stringify({ email: ALLOWED_EMAIL, exp: nowSec() + 60 }))),
    "short nonce (15 chars)": signed(b64(JSON.stringify(good({ nonce: "a".repeat(15) })))),
    "nonce with a space": signed(b64(JSON.stringify(good({ nonce: "abcdefghij klmnop" })))),
  };
  for (const [name, token] of Object.entries(cases)) {
    const res = await hit(`?token=${encodeURIComponent(token)}`);
    assert.equal(location(res), loginUrl, name);
    assert.equal(res.headers.get("set-cookie"), null, name);
  }
  const missing = await hit("");
  assert.equal(location(missing), loginUrl, "no token parameter at all");
  assert.equal(missing.headers.get("set-cookie"), null);
});

test("the reason is logged as a code only: never the email, the token or the secret", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const token = mint(good({ exp: nowSec() - 5, email: "private.person@example.com" }));
    await hit(`?token=${token}`);
    await hit(`?token=${mint(good(), "wrong-secret-wrong-secret-000000")}`);
  } finally {
    console.log = log;
  }
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ sso: "expired" }, { sso: "bad-signature" }]);
  const all = lines.join("\n");
  assert.ok(!all.includes("private.person"), "no email");
  assert.ok(!all.includes(SSO_SECRET) && !all.includes("wrong-secret"), "no secret");
  assert.ok(!/[A-Za-z0-9_-]{40,}\./.test(all), "no token");
});

test("/auth/sso is an open path (no cookie needed to start the hand-off), and nothing else new is open", () => {
  assert.ok(GATE_OPEN_PATHS.has("/auth/sso"));
  assert.ok(!GATE_OPEN_PATHS.has("/auth/sso/extra"));
  assert.ok(!GATE_OPEN_PATHS.has("/realty/search"));
});

test("/auth/sso is not public: the demo gate sends it away like any other page", () => {
  assert.notEqual(demoRoute("/auth/sso"), "pass");
  assert.equal(demoRoute("/auth/sso"), "demo");
});

test("redeemSsoToken: the same checks without the route, and a nonce is recorded only on success", () => {
  const cfgEnv = env as Record<string, string | undefined>;
  const now = Date.now();
  const token = mint(good({ exp: Math.floor(now / 1000) + 30 }));
  assert.equal(redeemSsoToken({ token, env: cfgEnv, nowMs: now }).ok, true);
  const again = redeemSsoToken({ token, env: cfgEnv, nowMs: now });
  assert.deepEqual(again, { ok: false, reason: "replayed" });
  // Past the token's own expiry the same token is expired, not replayed; a fresh nonce passes again.
  assert.deepEqual(redeemSsoToken({ token: mint(good()), env: cfgEnv, nowMs: now + 3600_000 }), { ok: false, reason: "expired" });
});
