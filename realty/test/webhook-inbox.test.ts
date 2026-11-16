import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GroupConsent } from "../flow/periskope.ts";
import { flushWebhookInbox, handleWebhook, setConsent } from "../node/periskope-intake.ts";
import { pollOnce } from "../node/periskope-poll.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { readInbox, WEBHOOK_INBOX_FILE } from "../node/webhook-inbox.ts";

/** Mechanism 1: a verified delivery is queued durably, answered 200, and retried by the handler and the poller. Fakes only. */

const KEY = "test-signing-key";
const CHAT = "120363000000000001@g.us";
const GROUP = "Co-broke Tobago";
const SENDER = "18685550202@c.us";
const NOW = new Date("2026-11-13T20:00:00.000Z");
const sign = (raw: string) => createHmac("sha256", KEY).update(raw).digest("hex");

const envelope = (messageId: string) => ({
  event_type: "message.created",
  org_id: "org-1",
  timestamp: "2026-11-13T20:00:00Z",
  data: {
    message_id: messageId,
    chat_id: CHAT,
    chat_name: GROUP,
    sender_phone: SENDER,
    body: "3 bed townhouse Maraval TT$1.2M co-broke 50/50",
    from_me: false,
    message_type: "chat",
    has_media: false,
    media: null,
  },
});

function world() {
  const root = mkdtempSync(join(tmpdir(), "webhook-inbox-"));
  const env = { PERISKOPE_SIGNING_KEY: KEY, PERISKOPE_ALLOWED_GROUPS: GROUP, PERISKOPE_ALLOWED_CHAT_IDS: CHAT };
  const opts = { root, env, now: () => NOW, crm: null, market: null, ours: null };
  const post = (payload: unknown, sig?: string | null) => {
    const raw = JSON.stringify(payload);
    return handleWebhook(Buffer.from(raw), sig === undefined ? sign(raw) : sig, opts);
  };
  return { root, env, opts, post, store: () => new PeriskopeStore(root) };
}

async function withConsent(w: ReturnType<typeof world>) {
  const consent: GroupConsent = { chatId: CHAT, groupName: GROUP, noticePostedAt: "2026-11-01T12:00:00.000Z", noticeWaivedAt: null, noticeWaivedBy: null, adminOkBy: "Office admin", adminOkAt: "2026-11-02T12:00:00.000Z", active: true };
  await setConsent(consent, w.opts);
}

/** Makes posts.jsonl unreadable and unwritable for the store, whoever runs the test: a directory where the file goes. */
function blockPosts(root: string) {
  mkdirSync(join(root, "posts.jsonl"), { recursive: true });
}
function unblockPosts(root: string) {
  rmSync(join(root, "posts.jsonl"), { recursive: true, force: true });
}

test("a verified delivery whose store write throws is answered 200 {accepted} and stays queued for a retry", async () => {
  const w = world();
  await withConsent(w);
  blockPosts(w.root);
  const { status, body } = await w.post(envelope("m-blocked"));
  assert.equal(status, 200);
  assert.deepEqual(body, { result: "accepted" });

  const queued = readInbox(w.root);
  assert.equal(queued.length, 1, "the verified delivery is still queued");
  assert.equal(queued[0].attempts, 1, "one failed attempt is recorded");
  assert.equal(Buffer.from(queued[0].body, "base64").toString("utf8"), JSON.stringify(envelope("m-blocked")), "the raw signed bytes are kept");
  assert.ok(Number.isFinite(Date.parse(queued[0].receivedAt)));
});

test("the poller's retry handles a queued delivery once, removes it, and stores the message", async () => {
  const w = world();
  await withConsent(w);
  blockPosts(w.root);
  await w.post(envelope("m-retry"));
  assert.equal(readInbox(w.root).length, 1);

  unblockPosts(w.root);
  const flushed = await flushWebhookInbox(w.opts);
  assert.deepEqual(flushed, { attempted: 1, done: 1, pending: 0 });
  assert.equal(readInbox(w.root).length, 0);
  assert.equal(w.store().posts().filter((p) => p.messageId === "m-retry").length, 1);

  const again = await flushWebhookInbox(w.opts);
  assert.deepEqual(again, { attempted: 0, done: 0, pending: 0 }, "nothing left to retry");
});

test("pollOnce drains the inbox: a delivery queued while the store was down is handled by the next poll", async () => {
  const w = world();
  await withConsent(w);
  blockPosts(w.root);
  await w.post(envelope("m-poll-retry"));
  unblockPosts(w.root);

  const empty = async () => ({ status: 200, body: { messages: [] } });
  const poll = await pollOnce({ root: w.root, env: w.env, apiKey: "test-key", now: () => NOW, fetcher: empty as never, crm: null });
  assert.equal(poll.ok, true);
  assert.equal(readInbox(w.root).length, 0);
  assert.equal(w.store().posts().filter((p) => p.messageId === "m-poll-retry").length, 1);
});

test("a delivery that can't be queued at all is the only 5xx: nothing is processed, so Periskope sends it again", async () => {
  const w = world();
  await withConsent(w);
  // The queue file is a directory: the append fails whoever runs the test.
  mkdirSync(join(w.root, WEBHOOK_INBOX_FILE), { recursive: true });
  const { status, body } = await w.post(envelope("m-unqueued"));
  assert.equal(status, 500);
  assert.equal(body.error, "could not queue");
  assert.equal(w.store().posts().filter((p) => p.messageId === "m-unqueued").length, 0);
});

test("a delivery that handles cleanly is answered with the ingest result and leaves nothing queued; the queue file is 0600 in a 0700 directory", async () => {
  const w = world();
  await withConsent(w);
  const { status, body } = await w.post(envelope("m-clean"));
  assert.equal(status, 200);
  assert.match(String(body.result), /listing recorded|not enough fields|dropped|ignored|buyer request/);
  assert.equal(readInbox(w.root).length, 0);
  assert.equal(w.store().posts().filter((p) => p.messageId === "m-clean").length, 1);

  // A queued item leaves the file 0600 in the 0700 root.
  const bad = world();
  await withConsent(bad);
  blockPosts(bad.root);
  await bad.post(envelope("m-mode"));
  unblockPosts(bad.root);
  assert.equal(statSync(join(bad.root, WEBHOOK_INBOX_FILE)).mode & 0o777, 0o600);
  assert.equal(statSync(bad.root).mode & 0o777, 0o700);
});

test("a bad signature or a missing key queues nothing", async () => {
  const w = world();
  await withConsent(w);
  assert.equal((await w.post(envelope("m-bad-sig"), "deadbeef")).status, 401);
  const noKey = await handleWebhook(Buffer.from(JSON.stringify(envelope("m-no-key"))), sign(JSON.stringify(envelope("m-no-key"))), { ...w.opts, env: {} });
  assert.equal(noKey.status, 503);
  assert.deepEqual(readInbox(w.root), []);
});

test("ackFirst (the route): answered 200 {queued} at once even while the intake lock is busy, then handled in the background", async () => {
  const { exclusive, webhookBackgroundIdle } = await import("../node/periskope-intake.ts");
  const w = world();
  await withConsent(w);
  // Something long holds the lock, the way the 10-minute poll does.
  let release!: () => void;
  const held = exclusive(() => new Promise<void>((r) => (release = r)));
  const raw = JSON.stringify(envelope("m-fast"));
  const started = Date.now();
  const r = await handleWebhook(Buffer.from(raw), sign(raw), { ...w.opts, ackFirst: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: "queued" });
  assert.ok(Date.now() - started < 1000, "the answer does not wait for the lock");
  assert.equal(readInbox(w.root).length, 1, "queued durably before the answer");
  assert.equal(w.store().posts().filter((p) => p.messageId === "m-fast").length, 0, "not handled yet: the lock is held");

  release();
  await held;
  await webhookBackgroundIdle();
  assert.equal(w.store().posts().filter((p) => p.messageId === "m-fast").length, 1, "handled once the lock is free");
  assert.equal(readInbox(w.root).length, 0);
});

test("a delivery queued while a drain is running is not lost when the drain finishes", async () => {
  const { exclusive, webhookBackgroundIdle } = await import("../node/periskope-intake.ts");
  const w = world();
  await withConsent(w);
  let release!: () => void;
  const held = exclusive(() => new Promise<void>((r) => (release = r)));
  const a = JSON.stringify(envelope("m-first"));
  const b = JSON.stringify(envelope("m-second"));
  await handleWebhook(Buffer.from(a), sign(a), { ...w.opts, ackFirst: true });
  release();
  await held;
  // The first drain is now in flight; the second delivery lands mid-drain.
  await handleWebhook(Buffer.from(b), sign(b), { ...w.opts, ackFirst: true });
  await webhookBackgroundIdle();
  await flushWebhookInbox(w.opts);
  const ids = w.store().posts().map((p) => p.messageId);
  assert.ok(ids.includes("m-first") && ids.includes("m-second"), "both deliveries are stored");
  assert.equal(readInbox(w.root).length, 0);
});

test("ackFirst: a delivery whose processing throws stays queued and the poller's retry handles it", async () => {
  const { webhookBackgroundIdle } = await import("../node/periskope-intake.ts");
  const w = world();
  await withConsent(w);
  blockPosts(w.root);
  const raw = JSON.stringify(envelope("m-bg-fail"));
  const r = await handleWebhook(Buffer.from(raw), sign(raw), { ...w.opts, ackFirst: true });
  assert.equal(r.status, 200);
  await webhookBackgroundIdle();
  const q = readInbox(w.root);
  assert.equal(q.length, 1);
  assert.equal(q[0].attempts, 1);
  unblockPosts(w.root);
  assert.deepEqual(await flushWebhookInbox(w.opts), { attempted: 1, done: 1, pending: 0 });
});
