import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { ingestEvent, setConsent } from "../node/periskope-intake.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { pollOnce } from "../node/periskope-poll.ts";
import {
  autoMatchGateState,
  fullSyncDue,
  FULL_RUN_EVERY_MS,
  hasPendingInbound,
  noteInboundRequest,
  resetAutoMatchGateForTests,
  runFullAutoMatchSync,
} from "../node/automatch-alert.ts";

/** The Auto-Match gate: a full re-score only after a new inbound buyer request, or once an hour from the poller. */

const KEY = "test-signing-key";
const CHAT = "120363000000000002@g.us";
const GROUP = "Co-broke Tobago";
const SENDER = "18685550303@c.us";
const REQUEST_TEXT = "Client looking for 2 bed rental Westmoorings under 8k";
const OTHER_TEXT = "see you at the office";
const NOW = new Date("2026-11-13T20:00:00.000Z");

/** No CRM env: automatchRun gets the not-connected seam and returns without any network call. */
const ENV = { PERISKOPE_SIGNING_KEY: KEY, PERISKOPE_ALLOWED_GROUPS: GROUP };

const envelope = (dataOver: Record<string, unknown> = {}) => ({
  event_type: "message.created",
  org_id: "org-1",
  timestamp: "2026-11-13T20:00:00Z",
  data: {
    message_id: "false_" + CHAT + "_gate0001",
    chat_id: CHAT,
    chat_name: GROUP,
    sender_phone: SENDER,
    body: REQUEST_TEXT,
    from_me: false,
    message_type: "chat",
    has_media: false,
    media: null,
    ...dataOver,
  },
});

const okConsent = {
  chatId: CHAT,
  groupName: GROUP,
  noticePostedAt: "2026-11-01T12:00:00.000Z",
  adminOkBy: "Office admin",
  adminOkAt: "2026-11-02T12:00:00.000Z",
  active: true,
};

function world() {
  const root = mkdtempSync(join(tmpdir(), "automatch-gate-"));
  const opts = { root, env: ENV, now: () => NOW, crm: null, market: null, ours: null };
  return { root, opts, store: () => new PeriskopeStore(root) };
}

beforeEach(() => {
  resetAutoMatchGateForTests();
});

test("an outbound message (from_me) runs no full sync and leaves nothing pending", async () => {
  const w = world();
  await setConsent(okConsent, w.opts);
  await ingestEvent(envelope({ from_me: true, message_id: "false_" + CHAT + "_out0001" }), w.opts);
  assert.equal(autoMatchGateState().fullRuns, 0);
  assert.equal(hasPendingInbound(), false);
});

test("chatter from someone else ('other') runs no full sync", async () => {
  const w = world();
  await setConsent(okConsent, w.opts);
  await ingestEvent(envelope({ body: OTHER_TEXT, message_id: "false_" + CHAT + "_chat0001" }), w.opts);
  assert.equal(autoMatchGateState().fullRuns, 0);
  assert.equal(hasPendingInbound(), false);
});

test("a new inbound buyer request runs exactly one full sync; re-ingesting the same id runs no more", async () => {
  const w = world();
  await setConsent(okConsent, w.opts);
  await ingestEvent(envelope(), w.opts);
  assert.equal(autoMatchGateState().fullRuns, 1);
  assert.equal(hasPendingInbound(), false);
  assert.equal(w.store().demand().filter((p) => p.messageId === "false_" + CHAT + "_gate0001").length, 1);

  await ingestEvent(envelope(), w.opts);
  assert.equal(autoMatchGateState().fullRuns, 1);
  assert.equal(hasPendingInbound(), false);
});

test("after a full run, fullSyncDue is false until 60 minutes pass or a new request arrives", async () => {
  await runFullAutoMatchSync({ root: world().root, env: ENV, now: NOW });
  assert.equal(autoMatchGateState().fullRuns, 1);
  assert.equal(fullSyncDue(NOW.getTime() + 10 * 60_000), false);
  assert.equal(fullSyncDue(NOW.getTime() + FULL_RUN_EVERY_MS - 1), false);
  assert.equal(fullSyncDue(NOW.getTime() + FULL_RUN_EVERY_MS), true);
});

test("a poll with nothing new, 10 minutes after a full run, does not run a full sync", async () => {
  const w = world();
  await runFullAutoMatchSync({ root: w.root, env: ENV, now: NOW });
  const later = new Date(NOW.getTime() + 10 * 60_000);
  const fetcher = async (url: string) => (url.includes("/messages") ? { status: 200, body: { messages: [] } } : { status: 200, body: { members: {} } });
  const r = await pollOnce({ root: w.root, env: ENV, apiKey: "test-key", now: () => later, fetcher, crm: null });
  assert.equal(r.ok, true);
  assert.equal(autoMatchGateState().fullRuns, 1);
});

test("60+ minutes with nothing new: a poll runs one full sync", async () => {
  const w = world();
  await runFullAutoMatchSync({ root: w.root, env: ENV, now: NOW });
  const later = new Date(NOW.getTime() + FULL_RUN_EVERY_MS);
  assert.equal(fullSyncDue(later.getTime()), true);
  const fetcher = async (url: string) => (url.includes("/messages") ? { status: 200, body: { messages: [] } } : { status: 200, body: { members: {} } });
  const r = await pollOnce({ root: w.root, env: ENV, apiKey: "test-key", now: () => later, fetcher, crm: null });
  assert.equal(r.ok, true);
  assert.equal(autoMatchGateState().fullRuns, 2);
  assert.equal(autoMatchGateState().lastFullAt, later.getTime());
});

test("noteInboundRequest makes a full sync due immediately, even right after a full run", async () => {
  await runFullAutoMatchSync({ root: world().root, env: ENV, now: NOW });
  assert.equal(fullSyncDue(NOW.getTime()), false);
  noteInboundRequest();
  assert.equal(hasPendingInbound(), true);
  assert.equal(fullSyncDue(NOW.getTime()), true);
});

test("the poll gates its full sync on fullSyncDue, and the intake gates on pending inbound", () => {
  const poll = readFileSync(new URL("../node/periskope-poll.ts", import.meta.url), "utf8");
  assert.match(poll, /if \(fullSyncDue\(at\.getTime\(\)\)\) await runFullAutoMatchSync\(\{ root, env, now: at \}\)/);
  assert.match(poll, /reason: "no new inbound requests"/);
  const intake = readFileSync(new URL("../node/periskope-intake.ts", import.meta.url), "utf8");
  assert.match(intake, /if \(!hasPendingInbound\(\)\) return Promise\.resolve\(\);/);
  assert.match(intake, /noteInboundRequest\(\);/);
});
