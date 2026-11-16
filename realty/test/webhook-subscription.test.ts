import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkSubscription, SUBSCRIPTION_CHECK_MS } from "../node/webhook-health.ts";
import { WEBHOOK_HEALTH_LOG } from "../node/webhook-health-log.ts";
import { PERISKOPE_WEBHOOKS_URL } from "../node/webhook-resubscribe.ts";
import { readWebhookStatus, webhookStatusLabel, WEBHOOK_STATUS_FILE } from "../node/webhook-status.ts";

/** The subscription watchdog with fakes only: the webhook API (GET/PATCH) and Resend. No live calls. */

const HOOK = "https://bop.1on1realtors.com/api/intake/periskope";
const ENV = { PERISKOPE_SIGNING_KEY: "sign-test", BOPS_PUBLIC_URL: "https://bop.1on1realtors.com", RESEND_API_KEY: "re_test_key" };
const NOW = new Date("2026-11-16T13:20:00.000Z");
const MIN = 60_000;

function fakeApi(start: { subscribed: boolean } | null) {
  let row = start ? { id: "row-1", hook_url: HOOK, integration_name: "message.created", is_subscribed: start.subscribed } : null;
  const calls: { method: string; url: string; body?: string }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url: String(url), body: init.body as string | undefined });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (String(url).startsWith("https://api.resend.com")) return json(200, { id: "email-1" });
    if (method === "GET" && String(url).startsWith(PERISKOPE_WEBHOOKS_URL)) return json(200, row ? [row] : []);
    if (method === "PATCH" && row) {
      row = { ...row, is_subscribed: JSON.parse(String(init.body)).isSubscribed };
      return json(200, row);
    }
    return json(404, {});
  }) as typeof fetch;
  return { f, calls, pause: () => row && (row.is_subscribed = false), row: () => row };
}

const world = () => mkdtempSync(join(tmpdir(), "webhook-sub-"));
const journal = (root: string) => (existsSync(join(root, WEBHOOK_HEALTH_LOG)) ? readFileSync(join(root, WEBHOOK_HEALTH_LOG), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

test("the watchdog runs every few minutes, well inside the 30-minute silence threshold", () => {
  assert.ok(SUBSCRIPTION_CHECK_MS <= 5 * MIN);
});

test("a live subscription: one GET, no PATCH, no email", async () => {
  const root = world();
  const api = fakeApi({ subscribed: true });
  const r = await checkSubscription({ root, env: ENV, now: NOW, apiKey: "pk", fetch: api.f });
  assert.equal(r.state, "subscribed");
  assert.equal(r.reconnect, null);
  assert.deepEqual(api.calls.map((c) => c.method), ["GET"]);
  assert.equal(readWebhookStatus(root).health?.subscription?.state, "subscribed");
  // A second healthy check journals nothing new.
  const before = journal(root).length;
  await checkSubscription({ root, env: ENV, now: new Date(NOW.getTime() + 2 * MIN), apiKey: "pk", fetch: api.f });
  assert.equal(journal(root).length, before);
});

test("Periskope paused us: the watchdog PATCHes it back on, emails Miles, and records the attempt", async () => {
  const root = world();
  const api = fakeApi({ subscribed: false });
  const r = await checkSubscription({ root, env: ENV, now: NOW, apiKey: "pk", fetch: api.f });
  assert.equal(r.state, "paused");
  assert.deepEqual(r.reconnect, { ok: true, action: "resumed" });
  assert.equal(api.row()?.is_subscribed, true);
  const patch = api.calls.find((c) => c.method === "PATCH");
  assert.ok(patch && patch.url === `${PERISKOPE_WEBHOOKS_URL}/row-1`);
  assert.deepEqual(JSON.parse(String(patch.body)), { isSubscribed: true });
  const email = api.calls.find((c) => c.url.startsWith("https://api.resend.com"));
  assert.ok(email, "an email on the attempt");
  const sent = JSON.parse(String(email.body));
  assert.deepEqual(sent.to, ["miles@simplyintense.com"]);
  assert.match(sent.subject, /unsubscribed/);
  const h = readWebhookStatus(root).health;
  assert.equal(h?.lastReconnectAt, NOW.toISOString());
  assert.equal(h?.subscription?.state, "subscribed");
  const types = journal(root).map((e) => e.type);
  assert.ok(types.includes("subscription") && types.includes("reconnect") && types.includes("alert_sent"));
});

test("at most one attempt an hour: a second pause within the hour is deferred (no PATCH), then retried after the hour", async () => {
  const root = world();
  const api = fakeApi({ subscribed: false });
  await checkSubscription({ root, env: ENV, now: NOW, apiKey: "pk", fetch: api.f });
  api.pause();
  const soon = await checkSubscription({ root, env: ENV, now: new Date(NOW.getTime() + 20 * MIN), apiKey: "pk", fetch: api.f });
  assert.equal(soon.reconnect, null);
  assert.equal(soon.deferred, "hourly limit");
  assert.equal(api.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.match(webhookStatusLabel(readWebhookStatus(root)), /Webhook unsubscribed/);
  const later = await checkSubscription({ root, env: ENV, now: new Date(NOW.getTime() + 61 * MIN), apiKey: "pk", fetch: api.f });
  assert.deepEqual(later.reconnect, { ok: true, action: "resumed" });
  assert.equal(api.calls.filter((c) => c.method === "PATCH").length, 2);
});

test("the kill switch: PERISKOPE_AUTO_RESUBSCRIBE=off reads the state but never PATCHes", async () => {
  const root = world();
  const api = fakeApi({ subscribed: false });
  const r = await checkSubscription({ root, env: { ...ENV, PERISKOPE_AUTO_RESUBSCRIBE: "off" }, now: NOW, apiKey: "pk", fetch: api.f });
  assert.equal(r.deferred, "switched off");
  assert.equal(api.calls.filter((c) => c.method !== "GET").length, 0);
});

test("a failed GET is recorded as unknown, changes nothing, and never throws", async () => {
  const root = world();
  const f = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const r = await checkSubscription({ root, env: ENV, now: NOW, apiKey: "pk", fetch: f });
  assert.equal(r.state, "unknown");
  assert.equal(readWebhookStatus(root).health?.subscription?.code, "network");
  assert.ok(existsSync(join(root, WEBHOOK_STATUS_FILE)));
});
