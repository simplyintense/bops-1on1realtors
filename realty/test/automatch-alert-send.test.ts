import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ALERT_ENABLED_FLAG,
  ALERT_NAME,
  TEST_ALERT_TO,
  alertFromHeader,
  alertIdempotencyKey,
  alertReplyTo,
  buildAutoMatchAlert,
  buildTestAutoMatchAlert,
  scrubMailError,
  type AutoMatchAlert,
} from "../flow/automatch-alert.ts";
import { deliverAlerts, sendTestAutoMatchAlert } from "../node/automatch-alert.ts";
import { RESEND_EMAILS_URL, sendResendEmail, type SendFetch } from "../node/automatch-alert-resend.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import type { StatusRow } from "../flow/match-status.ts";

/**
 * Resend transport and the one-off [TEST] send. The fetch is always mocked. Invented people and 555 numbers only.
 * The fake API key below is not a real secret.
 */

const NOW = new Date("2026-11-15T20:00:00.000Z");
const FAKE_KEY = "re_test_fake_key_only";
const BASE = "https://bop.example";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): { fetch: SendFetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: SendFetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch, calls };
}

const SAMPLE: AutoMatchAlert = buildAutoMatchAlert(
  {
    score: 90,
    reason: "Test",
    listingKey: "url:https://1on1realtors.com/property/sample-townhouse",
    ask: {
      postId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      area: "Maraval",
      beds: 3,
      budget: 2_500_000,
      currency: "TTD",
      type: "townhouse",
      listingType: "sale",
      lastSeenAt: NOW.toISOString(),
      postedAt: NOW.toISOString(),
      senderName: "Alex Tester",
      firm: "Example Realty Co",
      senderPhone: "+18685550100",
    },
    listing: {
      title: "Sample Townhouse, Maraval",
      url: "https://1on1realtors.com/property/sample-townhouse",
      price: 2_500_000,
      currency: "TTD",
      ttdEquiv: null,
      agentId: 7,
      agentName: "Dana Holder",
      area: "Maraval",
      beds: 3,
      type: "townhouse",
    },
    agentEmail: "dana@1on1.example",
  },
  { statuses: [] as StatusRow[], baseUrl: BASE, now: NOW, fromName: ALERT_NAME, fromEmail: "alerts@1on1realtors.com", cc: ["admin@1on1realtors.com"], bcc: ["miles@simplyintense.com"] },
);

test("scrubMailError strips bearer tokens and Resend keys", () => {
  const raw = `Bearer ${FAKE_KEY} failed; RESEND_API_KEY=${FAKE_KEY} also ${FAKE_KEY}`;
  const clean = scrubMailError(raw);
  assert.doesNotMatch(clean, /re_test_fake_key_only/);
  assert.match(clean, /\[redacted\]/);
});

test("sendResendEmail POSTs text and HTML with the Idempotency-Key and does not put empty cc/bcc on the body", async () => {
  const { fetch, calls } = mockFetch(() => jsonResponse(200, { id: "msg_test_1" }));
  const result = await sendResendEmail(
    {
      from: "1on1 Auto-Match Alert <alerts@1on1realtors.com>",
      to: [TEST_ALERT_TO],
      cc: [],
      bcc: [],
      replyTo: "admin@1on1realtors.com",
      subject: "[TEST] 1on1 Auto-Match Alert: townhouse · 3 bed · Maraval · TT$2.5M",
      text: "Hello",
      html: "<p>Hello</p>",
      idempotencyKey: "automatch-alert-test:1",
    },
    { apiKey: FAKE_KEY, fetch },
  );
  assert.deepEqual(result, { ok: true, id: "msg_test_1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESEND_EMAILS_URL);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${FAKE_KEY}`);
  assert.equal(headers.get("Idempotency-Key"), "automatch-alert-test:1");
  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.equal(body.from, "1on1 Auto-Match Alert <alerts@1on1realtors.com>");
  assert.deepEqual(body.to, [TEST_ALERT_TO]);
  assert.equal(body.reply_to, "admin@1on1realtors.com");
  assert.equal(body.subject, "[TEST] 1on1 Auto-Match Alert: townhouse · 3 bed · Maraval · TT$2.5M");
  assert.equal(body.text, "Hello");
  assert.equal(body.html, "<p>Hello</p>");
  assert.ok(!("cc" in body));
  assert.ok(!("bcc" in body));
});

test("a 5xx or network failure is retryable and not ok; a 409 idempotent replay is success", async () => {
  const five = await sendResendEmail(
    { from: "a@b.c", to: ["x@y.z"], replyTo: "r@s.t", subject: "s", text: "t", html: "<p>t</p>", idempotencyKey: "k1" },
    { apiKey: FAKE_KEY, fetch: async () => jsonResponse(503, { message: "try later" }) },
  );
  assert.deepEqual(five, { ok: false, retryable: true, status: 503, error: "try later" });
  const net = await sendResendEmail(
    { from: "a@b.c", to: ["x@y.z"], replyTo: "r@s.t", subject: "s", text: "t", html: "<p>t</p>", idempotencyKey: "k2" },
    { apiKey: FAKE_KEY, fetch: async () => { throw new Error(`Bearer ${FAKE_KEY} network down`); } },
  );
  assert.equal(net.ok, false);
  if (!net.ok) {
    assert.equal(net.retryable, true);
    assert.doesNotMatch(net.error, /re_test_fake_key_only/);
  }
  const dup = await sendResendEmail(
    { from: "a@b.c", to: ["x@y.z"], replyTo: "r@s.t", subject: "s", text: "t", html: "<p>t</p>", idempotencyKey: "k3" },
    { apiKey: FAKE_KEY, fetch: async () => jsonResponse(409, { id: "msg_existing", message: "idempotency key already used" }) },
  );
  assert.deepEqual(dup, { ok: true, id: "msg_existing", duplicate: true });
});

test("the one-off test send works with AUTOMATCH_ALERT_ENABLED off, To Miles only, no CC or BCC, and is not recorded as a sent match", async () => {
  const { fetch, calls } = mockFetch(() => jsonResponse(200, { id: "msg_test_prod" }));
  const env = { [ALERT_ENABLED_FLAG]: "false", RESEND_API_KEY: FAKE_KEY };
  const result = await sendTestAutoMatchAlert({ env, now: NOW, fetch, baseUrl: BASE });
  assert.deepEqual(result, { ok: true, id: "msg_test_prod" });
  const body = JSON.parse(String(calls[0].init.body)) as { to: string[]; cc?: string[]; bcc?: string[]; subject: string; from: string; reply_to: string };
  assert.deepEqual(body.to, [TEST_ALERT_TO]);
  assert.ok(!("cc" in body));
  assert.ok(!("bcc" in body));
  assert.match(body.subject, /^\[TEST\] /);
  assert.equal(body.from, alertFromHeader(env));
  assert.equal(body.reply_to, alertReplyTo(env));
  const headers = new Headers(calls[0].init.headers);
  assert.match(headers.get("Idempotency-Key") ?? "", /^automatch-alert-test:/);
  const preview = buildTestAutoMatchAlert(NOW, { baseUrl: BASE });
  assert.equal(preview.to, TEST_ALERT_TO);
  assert.deepEqual(preview.cc, []);
  assert.deepEqual(preview.bcc, []);
});

test("test send without a key fails clearly and does not call fetch", async () => {
  let called = 0;
  const result = await sendTestAutoMatchAlert({ env: {}, now: NOW, fetch: async () => { called += 1; return jsonResponse(200, { id: "nope" }); } });
  assert.deepEqual(result, { ok: false, error: "RESEND_API_KEY is not set" });
  assert.equal(called, 0);
});

test("deliverAlerts marks a key sent only after a 2xx, retries after a 5xx, and upgrades a suppressed row", async () => {
  const root = mkdtempSync(join(tmpdir(), "automatch-alert-send-"));
  const store = new PeriskopeStore(root);
  const env = { RESEND_API_KEY: FAKE_KEY };
  store.recordAutomatchAlertSent([{ requestId: SAMPLE.requestId, listingKey: SAMPLE.listingKey, at: NOW.toISOString(), kind: "suppressed" }]);
  const fail = mockFetch(() => jsonResponse(500, { message: "unavailable" }));
  const first = await deliverAlerts([SAMPLE], { env, now: NOW, store, fetch: fail.fetch });
  assert.deepEqual(first, { sent: 0, failed: 1 });
  assert.equal(store.automatchAlertSentRows()[0]?.kind, "suppressed", "a failed send must not be marked sent");
  const ok = mockFetch(() => jsonResponse(200, { id: "msg_live_1" }));
  const second = await deliverAlerts([SAMPLE], { env, now: NOW, store, fetch: ok.fetch });
  assert.deepEqual(second, { sent: 1, failed: 0 });
  const rows = store.automatchAlertSentRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "sent");
  const body = JSON.parse(String(ok.calls[0].init.body)) as { to: string[]; cc?: string[]; bcc?: string[] };
  assert.deepEqual(body.to, ["dana@1on1.example"]);
  assert.deepEqual(body.cc, ["admin@1on1realtors.com"]);
  assert.deepEqual(body.bcc, ["miles@simplyintense.com"]);
  const headers = new Headers(ok.calls[0].init.headers);
  assert.equal(headers.get("Idempotency-Key"), alertIdempotencyKey(SAMPLE.requestId, SAMPLE.listingKey));
});

test("the CLI --test-send without a key exits 1, prints no body, and never mentions a secret value", () => {
  const cli = new URL("../cli/automatch-alert.ts", import.meta.url).pathname;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "--test-send"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /RESEND_API_KEY is not set/);
  assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /re_[A-Za-z0-9_]+/);
});
