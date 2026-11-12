import assert from "node:assert/strict";
import { test } from "node:test";
import { demoRoute, emailAllowed, emailFromIdToken, gateConfig, makeSession, parseAllowlist, publicDemo, readSession, readValue, safeNext, signValue } from "../../lib/gate.ts";

/** The hosted login gate (lib/gate.ts). */

const env = {
  BOPS_LOGIN_GATE: "google",
  BOPS_ALLOWED_EMAILS: "miles@example.com, @1on1realtors.example",
  BOPS_GATE_SECRET: "x".repeat(40),
  GOOGLE_OAUTH_CLIENT_ID: "client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  BOPS_PUBLIC_URL: "https://bop.1on1realtors.example",
};
const cfg = gateConfig(env);
if (!cfg || cfg === "misconfigured") throw new Error("test config");

test("off unless asked for; on but incomplete fails closed", () => {
  assert.equal(gateConfig({}), null);
  assert.equal(gateConfig({ ...env, BOPS_GATE_SECRET: "short" }), "misconfigured");
  assert.equal(gateConfig({ ...env, BOPS_ALLOWED_EMAILS: "" }), "misconfigured");
  assert.equal(gateConfig({ ...env, BOPS_PUBLIC_URL: "http://plain.example" }), "misconfigured");
});

test("allowlist: exact emails and whole domains, nothing else", () => {
  const list = parseAllowlist("Miles@Example.com, @1on1realtors.example, not-an-email");
  assert.deepEqual(list, ["miles@example.com", "@1on1realtors.example"]);
  assert.ok(emailAllowed("MILES@example.com", list));
  assert.ok(emailAllowed("wendy@1on1realtors.example", list));
  assert.ok(!emailAllowed("wendy@evil1on1realtors.example", list));
  assert.ok(!emailAllowed("someone@example.com", list));
});

test("sessions: signed, expire, and end when the email leaves the list", async () => {
  const s = await makeSession("wendy@1on1realtors.example", cfg);
  assert.equal(await readSession(s, cfg), "wendy@1on1realtors.example");
  assert.equal(await readSession(s, cfg, Date.now() + 13 * 3600_000), null);
  assert.equal(await readSession(s, { ...cfg, allowed: ["miles@example.com"] }), null);
  assert.equal(await readSession(s, { ...cfg, secret: "y".repeat(40) }), null);
  const [body] = s.split(".");
  const forged = Buffer.from(JSON.stringify({ email: "x@1on1realtors.example", exp: 9e9 })).toString("base64url");
  assert.equal(await readSession(`${forged}.${s.split(".")[1]}`, cfg), null);
  assert.ok(body);
  // A state cookie can't pass as a session.
  assert.equal(await readValue("session", await signValue("state", { email: "miles@example.com", exp: 9e9 }, cfg.secret), cfg.secret), null);
});

test("ID token checks: issuer, audience, expiry, verified email", () => {
  const tok = (c: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(c)).toString("base64url")}.s`;
  const good = { iss: "https://accounts.google.com", aud: "client-id", exp: Date.now() / 1000 + 600, email: "Miles@Example.com", email_verified: true };
  assert.equal(emailFromIdToken(tok(good), "client-id"), "miles@example.com");
  assert.equal(emailFromIdToken(tok({ ...good, aud: "other" }), "client-id"), null);
  assert.equal(emailFromIdToken(tok({ ...good, iss: "https://evil.example" }), "client-id"), null);
  assert.equal(emailFromIdToken(tok({ ...good, exp: 1 }), "client-id"), null);
  assert.equal(emailFromIdToken(tok({ ...good, email_verified: false }), "client-id"), null);
});

test("redirects after sign-in stay on the site", () => {
  assert.equal(safeNext("/chats?x=1"), "/chats?x=1");
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("https://evil.example"), "/");
  assert.equal(safeNext("/\\evil.example"), "/");
});

test("public demo: on with ONEON1_PUBLIC_DEMO=1 or on Vercel, off only on purpose", () => {
  assert.equal(publicDemo({}), false);
  assert.equal(publicDemo({ ONEON1_PUBLIC_DEMO: "1" }), true);
  assert.equal(publicDemo({ VERCEL: "1" }), true);
  assert.equal(publicDemo({ VERCEL: "1", ONEON1_PUBLIC_DEMO: "0" }), false);
});

test("public demo: only the demo page, its assets and health; every other API call refused", () => {
  assert.equal(demoRoute("/realty-demo"), "pass");
  assert.equal(demoRoute("/api/health"), "pass");
  assert.equal(demoRoute("/_next/static/chunks/a.js"), "pass");
  assert.equal(demoRoute("/logos/gmail.svg"), "pass");
  assert.equal(demoRoute("/"), "demo");
  assert.equal(demoRoute("/pip"), "demo");
  for (const p of ["/api/state", "/api/auth/start", "/api/keys", "/api/mail", "/api/phone/agentphone", "/api/gate/login", "/api/apps/call", "/api/health/x", "/api/logo.svg"]) {
    assert.equal(demoRoute(p), "deny", p);
  }
});
