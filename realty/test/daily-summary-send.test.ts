import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NOT_CONNECTED, type CrmSeam, type SeamAgent } from "../flow/crm-seam.ts";
import { SUMMARY_ENABLED_FLAG } from "../flow/daily-summary.ts";
import { TEST_ALERT_TO } from "../flow/automatch-alert.ts";
import { sendTestDailySummary, tickDailySummary } from "../node/daily-summary.ts";
import { RESEND_EMAILS_URL, type SendFetch } from "../node/automatch-alert-resend.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";

/**
 * Daily summary transport, scheduler idempotency, and the Miles-only test send. The fetch is always mocked.
 * Invented people and 555 numbers only. The fake API key below is not a real secret.
 */

const FAKE_KEY = "re_test_fake_key_only";
const SEVEN = new Date("2026-11-16T11:00:00.000Z"); // 7:00 AM AST
const BEFORE = new Date("2026-11-16T10:59:00.000Z"); // 6:59 AM AST
const SENT_AT = "2026-11-16T10:30:00.000Z";

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

function rootWithSent(kind: "sent" | "suppressed" = "sent"): string {
  const root = mkdtempSync(join(tmpdir(), "daily-summary-"));
  writeFileSync(
    join(root, "automatch-alert-sent.jsonl"),
    `${JSON.stringify({ requestId: "aaaaaaaaaaaaaaaaaaaaaaaa", listingKey: "url:https://1on1realtors.com/property/sample", at: SENT_AT, kind })}\n`,
  );
  return root;
}

const emptySeam: CrmSeam = {
  connected: true,
  async listings() {
    return { status: "ok", listings: [] };
  },
  async agents(): Promise<SeamAgent[]> {
    return [];
  },
};

test("the scheduler does nothing while DAILY_SUMMARY_ENABLED is off, and nothing before 7:00 AM AST", async () => {
  const root = rootWithSent();
  const { fetch, calls } = mockFetch(() => jsonResponse(200, { id: "should-not-send" }));
  const off = await tickDailySummary({ root, env: { RESEND_API_KEY: FAKE_KEY }, now: SEVEN, fetch, seam: emptySeam });
  assert.deepEqual(off, { action: "disabled" });
  const early = await tickDailySummary({
    root,
    env: { RESEND_API_KEY: FAKE_KEY, [SUMMARY_ENABLED_FLAG]: "true" },
    now: BEFORE,
    fetch,
    seam: emptySeam,
  });
  assert.equal(early.action, "not-due");
  assert.equal(calls.length, 0);
  assert.equal(new PeriskopeStore(root).dailySummarySentRows().length, 0);
});

test("a 7:00 AM tick with the flag on sends once, records the day, and a second tick does not send again", async () => {
  const root = rootWithSent();
  const { fetch, calls } = mockFetch(() => jsonResponse(200, { id: "sum_live_1" }));
  const env = { RESEND_API_KEY: FAKE_KEY, [SUMMARY_ENABLED_FLAG]: "true" };
  const first = await tickDailySummary({ root, env, now: SEVEN, fetch, seam: emptySeam });
  assert.deepEqual(first, { action: "sent", dayKey: "2026-11-16", id: "sum_live_1", alerts: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESEND_EMAILS_URL);
  const body = JSON.parse(String(calls[0].init.body)) as { to: string[]; cc?: string[]; bcc?: string[]; subject: string };
  assert.deepEqual(body.to, ["wendy@1on1realtors.com", "admin@1on1realtors.com"]);
  assert.ok(!("cc" in body) || !body.cc?.length);
  assert.deepEqual(body.bcc, ["miles@simplyintense.com"]);
  assert.equal(calls[0].init.headers && (calls[0].init.headers as Record<string, string>)["Idempotency-Key"], "daily-summary:2026-11-16");
  const stored = new PeriskopeStore(root).dailySummarySentRows();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].dayKey, "2026-11-16");
  assert.equal(stored[0].id, "sum_live_1");
  const second = await tickDailySummary({ root, env, now: new Date("2026-11-16T14:00:00.000Z"), fetch, seam: emptySeam });
  assert.deepEqual(second, { action: "already-sent", dayKey: "2026-11-16", id: "sum_live_1" });
  assert.equal(calls.length, 1, "the second tick must not send");
});

test("a failed send is not recorded, so a later tick can retry", async () => {
  const root = rootWithSent();
  const { fetch, calls } = mockFetch(() => jsonResponse(500, { message: "temporarily down" }));
  const env = { RESEND_API_KEY: FAKE_KEY, [SUMMARY_ENABLED_FLAG]: "true" };
  const failed = await tickDailySummary({ root, env, now: SEVEN, fetch, seam: emptySeam });
  assert.equal(failed.action, "failed");
  assert.equal(new PeriskopeStore(root).dailySummarySentRows().length, 0);
  const { fetch: okFetch, calls: okCalls } = mockFetch(() => jsonResponse(200, { id: "sum_retry" }));
  const retried = await tickDailySummary({ root, env, now: SEVEN, fetch: okFetch, seam: emptySeam });
  assert.deepEqual(retried, { action: "sent", dayKey: "2026-11-16", id: "sum_retry", alerts: 1 });
  assert.equal(okCalls.length, 1);
  assert.equal(calls.length, 1);
});

test("a test send goes only to Miles, works with the flag off, and does not record the day", async () => {
  const root = rootWithSent();
  const { fetch, calls } = mockFetch(() => jsonResponse(200, { id: "sum_test_1" }));
  const r = await sendTestDailySummary({ root, env: { RESEND_API_KEY: FAKE_KEY, [SUMMARY_ENABLED_FLAG]: "false" }, now: SEVEN, fetch, seam: emptySeam });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.id, "sum_test_1");
  assert.deepEqual(r.summary.to, [TEST_ALERT_TO]);
  assert.deepEqual(r.summary.cc, []);
  assert.deepEqual(r.summary.bcc, []);
  const body = JSON.parse(String(calls[0].init.body)) as { to: string[]; cc?: string[]; bcc?: string[]; subject: string };
  assert.deepEqual(body.to, ["miles@simplyintense.com"]);
  assert.ok(!("cc" in body));
  assert.ok(!("bcc" in body));
  assert.match(body.subject, /^\[TEST\] /);
  assert.equal(new PeriskopeStore(root).dailySummarySentRows().length, 0);
});

test("without a Resend key the morning tick does not record the day", async () => {
  const root = rootWithSent();
  const r = await tickDailySummary({ root, env: { [SUMMARY_ENABLED_FLAG]: "true" }, now: SEVEN, seam: emptySeam });
  assert.deepEqual(r, { action: "no-transport", dayKey: "2026-11-16" });
  assert.equal(new PeriskopeStore(root).dailySummarySentRows().length, 0);
});

test("the store records one row per day and ignores a second write", () => {
  const root = mkdtempSync(join(tmpdir(), "daily-summary-store-"));
  const store = new PeriskopeStore(root);
  assert.equal(store.recordDailySummarySent({ dayKey: "2026-11-16", at: SEVEN.toISOString(), id: "a" }), true);
  assert.equal(store.recordDailySummarySent({ dayKey: "2026-11-16", at: SEVEN.toISOString(), id: "b" }), false);
  assert.equal(store.dailySummarySentRows().length, 1);
  assert.equal(store.dailySummarySentRows()[0].id, "a");
});

test("the unused not-connected seam is leftover-safe for the loader when a test wants no CRM", async () => {
  const root = rootWithSent();
  const { fetch, calls } = mockFetch(() => jsonResponse(200, { id: "sum_nc" }));
  const r = await tickDailySummary({
    root,
    env: { RESEND_API_KEY: FAKE_KEY, [SUMMARY_ENABLED_FLAG]: "true" },
    now: SEVEN,
    fetch,
    seam: NOT_CONNECTED,
  });
  assert.equal(r.action, "sent");
  assert.equal(calls.length, 1);
});
