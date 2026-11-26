import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INTAKE_GROUPS } from "../node/periskope-backfill.ts";
import { setConsent } from "../node/periskope-intake.ts";
import { pollOnce } from "../node/periskope-poll.ts";
import { evaluateWebhookHealth, WEBHOOK_SILENCE_MS } from "../node/webhook-health.ts";
import { astStamp, WEBHOOK_HEALTH_LOG } from "../node/webhook-health-log.ts";
import { autoResubscribeOn, PERISKOPE_WEBHOOKS_URL, resubscribeWebhook } from "../node/webhook-resubscribe.ts";
import { OWNER_ALERT_TO, buildWebhookAlert } from "../node/webhook-alert.ts";
import { readWebhookStatus, recordWebhookAccepted, webhookStatusLabel, writeWebhookStatus, WEBHOOK_STATUS_FILE } from "../node/webhook-status.ts";

/**
 * Mechanisms 2 to 4 and 6, and the heartbeat, with fakes only: the Periskope GET (read messages), the webhook API
 * (GET/PATCH/POST), and Resend. Nothing here calls api.periskope.app or api.resend.com.
 */

const NOW = new Date("2026-11-14T15:00:00.000Z");
const API_TEXT_AT = "2026-11-14T14:50:00.000Z"; // the newest text the API shows, 10 minutes before NOW
const FIRST = INTAKE_GROUPS[0];
const HOOK = "https://bop.1on1realtors.com/api/intake/periskope";
const PERISKOPE_KEY = "pk-test-key-0001";
const RESEND_KEY = "re_test_key_0002";
const ENV = { PERISKOPE_SIGNING_KEY: "sign-test", BOPS_PUBLIC_URL: "https://bop.1on1realtors.com", RESEND_API_KEY: RESEND_KEY };
const TEXT_BODY = "Looking for a 3 bed apartment in West Hills, budget 2,000,000";
const SENDER = "18685550101";
const MIN = 60_000;

/* ---------------- Mechanism 2: the silence rule (pure) ---------------- */

test("the silence rule: DOWN only when the API's newest text is more than the threshold ahead of the last delivery", () => {
  assert.equal(WEBHOOK_SILENCE_MS, 30 * 60_000, "30 minutes");
  const at = (min: number) => new Date(Date.parse("2026-11-14T12:00:00.000Z") + min * MIN).toISOString();
  const now = new Date(at(200));

  // Delivery at 12:00, the API's newest at 12:45: 45 minutes ahead, over 30. DOWN.
  assert.deepEqual(evaluateWebhookHealth({ now, lastAcceptedAt: at(0), latestApiAt: at(45) }), { state: "DOWN", lagMs: 45 * MIN });
  // Delivery at 12:00, the API's newest at 12:20: 20 minutes ahead, within the threshold. UP.
  assert.equal(evaluateWebhookHealth({ now, lastAcceptedAt: at(0), latestApiAt: at(20) }).state, "UP");
  // The API is not ahead of the webhook at all (delivery newer than the API's newest). UP.
  assert.equal(evaluateWebhookHealth({ now, lastAcceptedAt: at(60), latestApiAt: at(45) }).state, "UP");
  // Exactly the threshold is not over it. UP.
  assert.equal(evaluateWebhookHealth({ now, lastAcceptedAt: at(0), latestApiAt: at(30) }).state, "UP");
  // The threshold can be passed in (tests, or an override): a 5-minute threshold makes the same 20 minutes DOWN.
  assert.equal(evaluateWebhookHealth({ now, lastAcceptedAt: at(0), latestApiAt: at(20), thresholdMs: 5 * MIN }).state, "DOWN");
});

test("the silence rule with no delivery yet: DOWN when the API's newest text is older than the threshold, UP while it is recent", () => {
  const now = new Date(NOW);
  const old = new Date(NOW.getTime() - 2 * 60 * MIN).toISOString();
  const recent = new Date(NOW.getTime() - 5 * MIN).toISOString();
  assert.equal(evaluateWebhookHealth({ now, lastAcceptedAt: null, latestApiAt: old }).state, "DOWN");
  assert.equal(evaluateWebhookHealth({ now, lastAcceptedAt: null, latestApiAt: recent }).state, "UP");
});

test("the silence rule with no API messages at all: UP, nothing to miss", () => {
  assert.deepEqual(evaluateWebhookHealth({ now: NOW, lastAcceptedAt: null, latestApiAt: null }), { state: "UP", lagMs: null });
  assert.equal(evaluateWebhookHealth({ now: NOW, lastAcceptedAt: "2026-11-01T00:00:00.000Z", latestApiAt: null }).state, "UP");
});

/* ---------------- Mechanism 2 wired into the poller (fakes) ---------------- */

function pollMsg(over: Record<string, unknown> = {}) {
  return {
    message_id: "health-msg-1",
    chat_id: FIRST.chatId,
    sender_phone: SENDER,
    author: SENDER,
    from_me: false,
    body: TEXT_BODY,
    message_type: "chat",
    has_media: false,
    timestamp: API_TEXT_AT,
    ...over,
  };
}

/** A read-only Periskope GET fake: the first group has the given text messages; the rest are empty. */
function pollFetcher(messages = [pollMsg()]) {
  return async (url: string) => {
    if (url.includes("/messages")) return { status: 200, body: { messages: url.includes(encodeURIComponent(FIRST.chatId)) ? messages : [] } };
    return { status: 200, body: { members: {} } };
  };
}

async function consented(root: string) {
  for (const g of INTAKE_GROUPS) {
    await setConsent(
      { chatId: g.chatId, groupName: g.chatName, noticeWaivedAt: "2026-11-14T13:39:00.000Z", noticeWaivedBy: "owner", adminOkAt: "2026-11-14T13:39:00.000Z", adminOkBy: "Miles Abraham" },
      { root, env: {}, now: () => NOW },
    );
  }
}

type Call = { method: string; url: string; auth: string | null; body: Record<string, unknown> | null };

/**
 * The webhook API and Resend, faked. `rows` is what GET /v1/webhooks lists (it may include rows for other URLs and other
 * events: the code must ignore them). `resend` is the status for each Resend send in order (default 200).
 */
function fakeWebhookApi(rows: Record<string, unknown>[] = [], resend: number[] = []) {
  const calls: Call[] = [];
  const resendStatus = [...resend];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, auth, body });
    if (url.startsWith("https://api.resend.com/")) {
      const status = resendStatus.shift() ?? 200;
      return status === 200 ? Response.json({ id: `re_fake_${calls.length}` }) : new Response(JSON.stringify({ message: "nope" }), { status });
    }
    if (url.startsWith(PERISKOPE_WEBHOOKS_URL) && method === "GET") return Response.json({ webhooks: rows });
    if (url.startsWith(PERISKOPE_WEBHOOKS_URL) && method === "PATCH") return Response.json({ id: "row-1", is_subscribed: true });
    if (url === PERISKOPE_WEBHOOKS_URL && method === "POST") return Response.json({ id: "row-new" }, { status: 201 });
    return new Response("{}", { status: 404 });
  };
  return {
    fetch,
    calls,
    periskopeCalls: () => calls.filter((c) => c.url.startsWith("https://api.periskope.app/")),
    resendCalls: () => calls.filter((c) => c.url.startsWith("https://api.resend.com/")),
  };
}

function world(lastAcceptedAt: string | null) {
  const root = mkdtempSync(join(tmpdir(), "webhook-health-"));
  if (lastAcceptedAt) writeWebhookStatus(root, { lastAcceptedAt, lastEventType: "message.created", lastGroupName: FIRST.chatName, lastOutcome: "added", acceptedCount: 3 });
  return root;
}

const liveRow = [{ id: "row-1", hook_url: HOOK, integration_name: "message.created", is_subscribed: true }];
const pausedRow = [{ id: "row-1", hook_url: HOOK, integration_name: "message.created", is_subscribed: false }];

test("pollOnce marks the webhook DOWN when the API is ahead of the last delivery by over 30 minutes, and UP when it isn't", async () => {
  const down = world("2026-11-14T13:00:00.000Z");
  await consented(down);
  const api = fakeWebhookApi(liveRow);
  const r1 = await pollOnce({ root: down, env: { ...ENV }, apiKey: PERISKOPE_KEY, now: () => NOW, fetcher: pollFetcher() as never, crm: null, webhookFetch: api.fetch });
  assert.deepEqual(r1.health, { state: "DOWN", lagMs: 110 * MIN });

  const up = world("2026-11-14T14:45:00.000Z");
  await consented(up);
  const api2 = fakeWebhookApi();
  const r2 = await pollOnce({ root: up, env: { ...ENV }, apiKey: PERISKOPE_KEY, now: () => NOW, fetcher: pollFetcher() as never, crm: null, webhookFetch: api2.fetch });
  assert.equal(r2.health?.state, "UP");
  assert.equal(api2.periskopeCalls().filter((c) => c.method !== "GET").length, 0, "UP never reconnects");
});

test("no delivery yet and the API's newest text is 2 hours old: DOWN. Without a configured webhook the checks don't run at all", async () => {
  const root = world(null);
  await consented(root);
  const api = fakeWebhookApi(liveRow);
  const r = await pollOnce({ root, env: { ...ENV }, apiKey: PERISKOPE_KEY, now: () => NOW, fetcher: pollFetcher([pollMsg({ timestamp: "2026-11-14T13:00:00.000Z" })]) as never, crm: null, webhookFetch: api.fetch });
  assert.equal(r.health?.state, "DOWN");

  const plain = world("2026-11-14T13:00:00.000Z");
  await consented(plain);
  const none = fakeWebhookApi();
  const p = await pollOnce({ root: plain, env: { PERISKOPE_SIGNING_KEY: "", RESEND_API_KEY: "" }, apiKey: PERISKOPE_KEY, now: () => NOW, fetcher: pollFetcher() as never, crm: null, webhookFetch: none.fetch });
  assert.equal(p.health, undefined);
  assert.equal(none.calls.length, 0, "no webhook API call without a configured webhook");
  assert.equal(existsSync(join(plain, WEBHOOK_HEALTH_LOG)), false);
});

/* ---------------- Mechanism 3: reconnect ---------------- */

test("the kill-switch: unset, empty, 1, true, yes and on keep reconnect ON; 0, false, no and off (any case) turn it OFF", () => {
  for (const v of [undefined, "", "  ", "1", "true", "TRUE", "yes", "on", "anything-else"]) assert.equal(autoResubscribeOn({ PERISKOPE_AUTO_RESUBSCRIBE: v }), true, `on for ${JSON.stringify(v)}`);
  for (const v of ["0", "false", "FALSE", "no", "No", "off", " OFF "]) assert.equal(autoResubscribeOn({ PERISKOPE_AUTO_RESUBSCRIBE: v }), false, `off for ${JSON.stringify(v)}`);
});

test("reconnect resumes OUR exact URL's paused message.created row with PATCH isSubscribed true, and leaves other rows alone", async () => {
  const api = fakeWebhookApi([
    { id: "other-url", hook_url: "https://elsewhere.example/hook", integration_name: "message.created", is_subscribed: false },
    { id: "other-event", hook_url: HOOK, integration_name: "message.updated", is_subscribed: false },
    { id: "row-42", hook_url: HOOK, integration_name: "message.created", is_subscribed: false },
  ]);
  const r = await resubscribeWebhook({ apiKey: PERISKOPE_KEY, hookUrl: HOOK, fetch: api.fetch });
  assert.deepEqual(r, { ok: true, action: "resumed" });
  const mutating = api.periskopeCalls().filter((c) => c.method !== "GET");
  assert.equal(mutating.length, 1);
  assert.equal(mutating[0].method, "PATCH");
  assert.equal(mutating[0].url, `${PERISKOPE_WEBHOOKS_URL}/row-42`);
  assert.deepEqual(mutating[0].body, { isSubscribed: true });
  assert.equal(api.periskopeCalls()[0].url, `${PERISKOPE_WEBHOOKS_URL}?hook_url=${encodeURIComponent(HOOK)}&integration_name=message.created`);
  assert.equal(api.periskopeCalls()[0].auth, `Bearer ${PERISKOPE_KEY}`, "bearer auth with the existing key");
});

test("reconnect POSTs hookUrl + message.created when there is no row for our URL, and does nothing when the row is already live", async () => {
  const none = fakeWebhookApi([]);
  assert.deepEqual(await resubscribeWebhook({ apiKey: PERISKOPE_KEY, hookUrl: HOOK, fetch: none.fetch }), { ok: true, action: "created" });
  const post = none.periskopeCalls().find((c) => c.method === "POST");
  assert.deepEqual(post?.body, { hookUrl: HOOK, integrationName: "message.created" });

  const live = fakeWebhookApi(liveRow);
  assert.deepEqual(await resubscribeWebhook({ apiKey: PERISKOPE_KEY, hookUrl: HOOK, fetch: live.fetch }), { ok: true, action: "already_subscribed" });
  assert.equal(live.periskopeCalls().filter((c) => c.method !== "GET").length, 0);
});

test("a failed reconnect returns a code (status, never a body) and never throws", async () => {
  const broken: typeof fetch = async () => new Response("secret body text", { status: 500 });
  const r = await resubscribeWebhook({ apiKey: PERISKOPE_KEY, hookUrl: HOOK, fetch: broken });
  assert.deepEqual(r, { ok: false, action: "failed", code: "list_500" });
  const net: typeof fetch = async () => {
    throw new Error("socket hang up");
  };
  assert.deepEqual(await resubscribeWebhook({ apiKey: PERISKOPE_KEY, hookUrl: HOOK, fetch: net }), { ok: false, action: "failed", code: "network" });
});

test("the kill-switch off: a DOWN poll makes no webhook API call, but still alerts", async () => {
  const root = world("2026-11-14T13:00:00.000Z");
  await consented(root);
  const api = fakeWebhookApi(pausedRow);
  await pollOnce({ root, env: { ...ENV, PERISKOPE_AUTO_RESUBSCRIBE: "off" }, apiKey: PERISKOPE_KEY, now: () => NOW, fetcher: pollFetcher() as never, crm: null, webhookFetch: api.fetch });
  assert.equal(api.periskopeCalls().length, 0, "no GET, PATCH or POST to the webhook API");
  assert.equal(api.resendCalls().length, 1, "the DOWN email still goes out");
  assert.equal(readWebhookStatus(root).health?.lastReconnectAt ?? null, null);
});

test("reconnect is attempted at most once an hour while DOWN", async () => {
  const root = world("2026-11-14T13:00:00.000Z");
  await consented(root);
  const api = fakeWebhookApi(pausedRow);
  const poll = (at: Date) => pollOnce({ root, env: { ...ENV }, apiKey: PERISKOPE_KEY, now: () => at, fetcher: pollFetcher() as never, crm: null, webhookFetch: api.fetch });
  const gets = () => api.periskopeCalls().filter((c) => c.method === "GET").length;
  await poll(NOW);
  assert.equal(gets(), 1);
  await poll(new Date(NOW.getTime() + 10 * MIN));
  await poll(new Date(NOW.getTime() + 50 * MIN));
  assert.equal(gets(), 1, "no second attempt within the hour");
  await poll(new Date(NOW.getTime() + 61 * MIN));
  assert.equal(gets(), 2, "a new attempt after the hour");
});

/* ---------------- Mechanism 4: alerts ---------------- */

test("DOWN sends one email to Miles only (no CC, no BCC); a second DOWN in the same incident sends nothing; recovery sends one more", async () => {
  const root = world("2026-11-14T13:00:00.000Z");
  await consented(root);
  // Paused row, so the reconnect works and the DOWN email carries it.
  const api = fakeWebhookApi(pausedRow);
  const poll = (at: Date) => pollOnce({ root, env: { ...ENV }, apiKey: PERISKOPE_KEY, now: () => at, fetcher: pollFetcher() as never, crm: null, webhookFetch: api.fetch });

  const first = await poll(NOW);
  assert.equal(first.health?.state, "DOWN");
  assert.equal(api.resendCalls().length, 1, "one DOWN email");
  const sent = api.resendCalls()[0].body as Record<string, unknown>;
  assert.deepEqual(sent.to, [OWNER_ALERT_TO]);
  assert.equal(OWNER_ALERT_TO, "miles@simplyintense.com");
  assert.equal(sent.cc, undefined, "no CC");
  assert.equal(sent.bcc, undefined, "no BCC");
  assert.match(String(sent.subject), /DOWN/);
  assert.match(String(sent.text), /Auto-resubscribe: resumed/, "the reconnect outcome rides on the DOWN email");
  assert.doesNotMatch(String(sent.text) + String(sent.html), /Looking for|18685550101|Maraval/, "no message text, no phone");
  assert.equal(api.resendCalls()[0].auth, `Bearer ${RESEND_KEY}`);

  // Still DOWN, 10 minutes later and 50 minutes later: no more email (the hourly reconnect is not due yet either).
  await poll(new Date(NOW.getTime() + 10 * MIN));
  await poll(new Date(NOW.getTime() + 50 * MIN));
  assert.equal(api.resendCalls().length, 1, "a second DOWN in the same incident does not send");

  // The webhook delivers again (a message accepted now, newer than the API's newest): recovery, one email.
  recordWebhookAccepted(root, { at: new Date(NOW.getTime() + 55 * MIN).toISOString(), eventType: "message.created", groupName: FIRST.chatName, outcome: "added" });
  const up = await poll(new Date(NOW.getTime() + 60 * MIN));
  assert.equal(up.health?.state, "UP");
  assert.equal(api.resendCalls().length, 2, "one recovery email");
  assert.match(String((api.resendCalls()[1].body as Record<string, unknown>).subject), /delivering again/);
  await poll(new Date(NOW.getTime() + 70 * MIN));
  assert.equal(api.resendCalls().length, 2, "UP stays quiet");
});

test("a failed DOWN send stays pending and is retried on the next poll, then not again", async () => {
  const root = world("2026-11-14T13:00:00.000Z");
  await consented(root);
  const api = fakeWebhookApi(pausedRow, [500]);
  const poll = (at: Date) => pollOnce({ root, env: { ...ENV }, apiKey: PERISKOPE_KEY, now: () => at, fetcher: pollFetcher() as never, crm: null, webhookFetch: api.fetch });
  await poll(NOW);
  assert.equal(api.resendCalls().length, 1, "the send failed");
  assert.equal(readWebhookStatus(root).health?.pendingAlert, "down", "still pending");
  await poll(new Date(NOW.getTime() + 10 * MIN));
  assert.equal(api.resendCalls().length, 2, "retried");
  assert.equal(readWebhookStatus(root).health?.pendingAlert ?? null, null);
  await poll(new Date(NOW.getTime() + 20 * MIN));
  assert.equal(api.resendCalls().length, 2, "not sent again");
});

test("with no Resend key the alert is skipped and logged, not retried forever", async () => {
  // The poll reads its env from process.env too (runtimeEnv), so a key set in the shell would send. Clear it for this test only.
  const savedKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const root = world("2026-11-14T13:00:00.000Z");
    await consented(root);
    const api = fakeWebhookApi(pausedRow);
    await pollOnce({ root, env: { PERISKOPE_SIGNING_KEY: "sign-test", BOPS_PUBLIC_URL: "https://bop.1on1realtors.com" }, apiKey: PERISKOPE_KEY, now: () => NOW, fetcher: pollFetcher() as never, crm: null, webhookFetch: api.fetch });
    assert.equal(api.resendCalls().length, 0);
    assert.equal(readWebhookStatus(root).health?.pendingAlert ?? null, null);
    assert.ok(journal(root).some((e) => e.type === "alert_skipped"));
  } finally {
    if (savedKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedKey;
  }
});

test("the alert body is counts, chat names and time ranges only (the gap section), with no ids or phones", () => {
  const m = buildWebhookAlert({
    kind: "down",
    lagMs: 45 * MIN,
    lastAcceptedAt: "2026-11-14T13:00:00.000Z",
    incidentSince: "2026-11-14T14:00:00.000Z",
    reconnect: "resumed",
    gap: {
      checkedAt: NOW.toISOString(),
      windowFrom: "2026-11-13T15:00:00.000Z",
      windowTo: NOW.toISOString(),
      apiMessages: 9,
      missing: 2,
      chats: [{ chatName: FIRST.chatName, missing: 2, earliest: "2026-11-14T13:10:00.000Z", latest: "2026-11-14T13:40:00.000Z" }],
    },
  });
  assert.match(m.text, /2 text message\(s\) from the API are not in the store/);
  assert.ok(m.text.includes(`- ${FIRST.chatName}: 2 missing, 2026-11-14 09:10 AST to 2026-11-14 09:40 AST`));
  assert.doesNotMatch(m.text, /message_id|chat_id|@g\.us|@c\.us/);
});

/* ---------------- Mechanism 6: the journal ---------------- */

function journal(root: string): { at: string; ast: string; type: string; [k: string]: unknown }[] {
  const file = join(root, WEBHOOK_HEALTH_LOG);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("after a fake DOWN and its alert, webhook-health.jsonl has the expected events, each with ISO and AST times, 0600 in a 0700 root", async () => {
  const root = world("2026-11-14T13:00:00.000Z");
  await consented(root);
  const api = fakeWebhookApi(pausedRow);
  await pollOnce({ root, env: { ...ENV }, apiKey: PERISKOPE_KEY, now: () => NOW, fetcher: pollFetcher() as never, crm: null, webhookFetch: api.fetch });
  const lines = journal(root);
  const types = lines.map((l) => l.type);
  assert.ok(types.includes("detect"), "the detection");
  assert.ok(types.includes("reconnect"), "the reconnect attempt");
  assert.ok(types.includes("alert_sent"), "the alert send");
  const detect = lines.find((l) => l.type === "detect");
  assert.equal(detect?.state, "DOWN");
  for (const l of lines) {
    assert.equal(l.at, NOW.toISOString(), "ISO time");
    assert.equal(l.ast, "2026-11-14 11:00 AST", "Port of Spain time");
  }
  assert.equal(astStamp("2026-11-14T15:00:00.000Z"), "2026-11-14 11:00 AST");
  assert.equal(statSync(join(root, WEBHOOK_HEALTH_LOG)).mode & 0o777, 0o600);
  assert.equal(statSync(root).mode & 0o777, 0o700);
});

test("no secret, phone, message text or chat id reaches the journal, the status file or the email", async () => {
  const root = world("2026-11-14T13:00:00.000Z");
  await consented(root);
  const api = fakeWebhookApi(pausedRow);
  await pollOnce({ root, env: { ...ENV }, apiKey: PERISKOPE_KEY, now: () => NOW, fetcher: pollFetcher() as never, crm: null, webhookFetch: api.fetch });
  const everything = [
    readFileSync(join(root, WEBHOOK_HEALTH_LOG), "utf8"),
    readFileSync(join(root, WEBHOOK_STATUS_FILE), "utf8"),
    JSON.stringify(api.resendCalls().map((c) => c.body)), // the email as sent, not the auth header the request carries
  ].join("\n");
  for (const secret of [PERISKOPE_KEY, RESEND_KEY, "sign-test"]) assert.ok(!everything.includes(secret), "no secret");
  assert.ok(!everything.includes(SENDER), "no phone");
  assert.ok(!everything.includes(TEXT_BODY), "no message text");
  assert.ok(!everything.includes(FIRST.chatId), "no chat id");
});

/* ---------------- Heartbeat: the status line ---------------- */

test("the desk and digest line shows DOWN (and the gap count) next to the last message time, and is unchanged without health", () => {
  const base = { lastAcceptedAt: "2026-11-13T11:58:00.000Z", lastEventType: "message.created", lastGroupName: FIRST.chatName, lastOutcome: "added" as const, acceptedCount: 1 };
  assert.equal(webhookStatusLabel(base), "Live feed: last message 7:58 AM");
  const health = { state: "DOWN" as const, lagMs: 3 * 60 * MIN, checkedAt: NOW.toISOString(), downSince: NOW.toISOString(), pendingAlert: null, lastReconnectAt: null, lastReconnect: null, gap: { checkedAt: NOW.toISOString(), missing: 4, chats: 2 } };
  assert.equal(webhookStatusLabel({ ...base, health }), "Live feed: last message 7:58 AM · Webhook DOWN · 4 missing in the last 24h");
  assert.equal(webhookStatusLabel({ ...base, health: { ...health, state: "UP", gap: null } }), "Live feed: last message 7:58 AM");
});

test("an accepted delivery keeps the poller's health block; the counters move", () => {
  const root = world(null);
  writeWebhookStatus(root, { lastAcceptedAt: null, lastEventType: null, lastGroupName: null, lastOutcome: null, acceptedCount: 0, health: { state: "DOWN", lagMs: 1, checkedAt: NOW.toISOString(), downSince: NOW.toISOString(), pendingAlert: "down", lastReconnectAt: null, lastReconnect: null, gap: null } });
  recordWebhookAccepted(root, { at: NOW.toISOString(), eventType: "message.created", groupName: FIRST.chatName, outcome: "added" });
  const s = readWebhookStatus(root);
  assert.equal(s.acceptedCount, 1);
  assert.equal(s.health?.state, "DOWN", "health survives an accepted delivery");
});
