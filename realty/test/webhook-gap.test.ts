import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INTAKE_GROUPS } from "../node/periskope-backfill.ts";
import { setConsent } from "../node/periskope-intake.ts";
import { pollOnce } from "../node/periskope-poll.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { gapReportOf, GAP_REPORT_FILE, readGapReport, runGapReport } from "../node/webhook-gap.ts";
import { writeWebhookStatus } from "../node/webhook-status.ts";

/**
 * Mechanism 5: the gap report. The API returns message ids the store doesn't have: the report counts them, and nothing is
 * ingested or written as a post. Fakes only; no real Periskope call.
 */

const NOW = new Date("2026-11-14T15:00:00.000Z");
const FIRST = INTAKE_GROUPS[0];
const PHONE = "18685550303";

function msg(id: string, over: Record<string, unknown> = {}) {
  return {
    message_id: id,
    chat_id: FIRST.chatId,
    sender_phone: PHONE,
    author: PHONE,
    from_me: false,
    body: "Looking for a 2 bed in Westmoorings",
    message_type: "chat",
    has_media: false,
    timestamp: "2026-11-14T14:00:00.000Z",
    ...over,
  };
}

/** Read-only fake for the watched groups: FIRST has the given messages, the rest are empty. Records every URL it was asked for. */
function apiFake(messages: Record<string, unknown>[]) {
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    if (url.includes("/messages")) return { status: 200, body: { messages: url.includes(encodeURIComponent(FIRST.chatId)) ? messages : [] } };
    return { status: 200, body: { members: {} } };
  };
  return { fetcher, urls };
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "webhook-gap-"));
  // One stored post: the id the API also shows (so it is not a gap), plus its chat.
  appendFileSync(join(root, "posts.jsonl"), `${JSON.stringify({ messageId: "m-stored", chatId: FIRST.chatId, sentAt: "2026-11-14T13:00:00.000Z", category: "demand" })}\n`);
  return { root, store: () => new PeriskopeStore(root) };
}

test("the pure gap count: ids the store doesn't have are counted per chat, with their time range; the store's ids are not", () => {
  const report = gapReportOf(
    [
      { chatName: "Group A", messageId: "x1", sentAt: "2026-11-14T10:00:00.000Z" },
      { chatName: "Group A", messageId: "x2", sentAt: "2026-11-14T11:00:00.000Z" },
      { chatName: "Group A", messageId: "stored", sentAt: "2026-11-14T09:00:00.000Z" },
      { chatName: "Group B", messageId: "x3", sentAt: "2026-11-14T12:30:00.000Z" },
      { chatName: "Group C", messageId: "stored-2", sentAt: "2026-11-14T08:00:00.000Z" },
    ],
    new Set(["stored", "stored-2"]),
    { checkedAt: NOW.toISOString(), windowFrom: "2026-11-13T15:00:00.000Z", windowTo: NOW.toISOString() },
  );
  assert.equal(report.apiMessages, 5);
  assert.equal(report.missing, 3);
  assert.deepEqual(report.chats, [
    { chatName: "Group A", missing: 2, earliest: "2026-11-14T10:00:00.000Z", latest: "2026-11-14T11:00:00.000Z" },
    { chatName: "Group B", missing: 1, earliest: "2026-11-14T12:30:00.000Z", latest: "2026-11-14T12:30:00.000Z" },
  ]);
  assert.ok(!JSON.stringify(report).includes("x1"), "no message ids in the report");
});

test("runGapReport: API ids not in the store are counted; the store's post count does not increase; nothing is sent or ingested", async () => {
  const w = world();
  const api = apiFake([
    msg("m-stored"),
    msg("m-new-1", { timestamp: "2026-11-14T14:10:00.000Z" }),
    msg("m-new-2", { timestamp: "2026-11-14T14:20:00.000Z" }),
    msg("m-ours", { from_me: true }), // our own message: not a gap
    msg("m-media", { has_media: true, body: "", message_type: "image", media: { url: "https://example.invalid/x.jpg" } }), // media only: not a gap
  ]);
  const postsBefore = w.store().posts().length;

  const report = await runGapReport({ root: w.root, env: {}, now: NOW, apiKey: "test-key", fetcher: api.fetcher as never });

  assert.equal(report.apiMessages, 3, "the stored text, and the two new text messages");
  assert.equal(report.missing, 2);
  assert.equal(report.chats.length, 1);
  assert.equal(report.chats[0].chatName, FIRST.chatName);
  assert.equal(report.chats[0].missing, 2);
  assert.equal(report.chats[0].earliest, "2026-11-14T14:10:00.000Z");
  assert.equal(report.chats[0].latest, "2026-11-14T14:20:00.000Z");
  assert.equal(w.store().posts().length, postsBefore, "the gap report never writes a post");
  assert.ok(api.urls.every((u) => u.startsWith("https://api.periskope.app/v1/")), "read-only Periskope GETs only");

  // The file: 0600, counts and names only.
  const file = join(w.root, GAP_REPORT_FILE);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, "utf8");
  for (const id of ["m-new-1", "m-new-2", "m-stored", PHONE, "Looking for"]) assert.ok(!text.includes(id), `no ${id} in the report`);
  assert.deepEqual(readGapReport(w.root)?.missing, 2);
});

test("the gap count is recorded on the status for the desk line, and a failed group is left out, not counted as missing", async () => {
  const w = world();
  writeWebhookStatus(w.root, { lastAcceptedAt: null, lastEventType: null, lastGroupName: null, lastOutcome: null, acceptedCount: 0, health: { state: "UP", lagMs: null, checkedAt: NOW.toISOString(), downSince: null, pendingAlert: null, lastReconnectAt: null, lastReconnect: null, gap: null } });
  const api = apiFake([msg("m-gap-a")]);
  const failingSecond = async (url: string) => (url.includes(encodeURIComponent(INTAKE_GROUPS[1].chatId)) ? { status: 500, body: { message: "down" } } : api.fetcher(url));
  await runGapReport({ root: w.root, env: {}, now: NOW, apiKey: "test-key", fetcher: failingSecond as never });
  const { readWebhookStatus } = await import("../node/webhook-status.ts");
  const gap = readWebhookStatus(w.root).health?.gap;
  assert.equal(gap?.missing, 1, "the failed group is not counted as missing");
  assert.equal(gap?.chats, 1);
});

test("pollOnce runs the gap report once an hour, not on every 10-minute poll", async () => {
  const w = world();
  for (const g of INTAKE_GROUPS) {
    await setConsent({ chatId: g.chatId, groupName: g.chatName, noticeWaivedAt: "2026-11-14T13:39:00.000Z", noticeWaivedBy: "owner", adminOkAt: "2026-11-14T13:39:00.000Z", adminOkBy: "Miles Abraham" }, { root: w.root, env: {}, now: () => NOW });
  }
  const api = apiFake([msg("m-poll-gap", { timestamp: "2026-11-14T14:50:00.000Z" })]);
  const webhookFetch: typeof fetch = async () => Response.json([]);
  const poll = (at: Date) => pollOnce({ root: w.root, env: { PERISKOPE_SIGNING_KEY: "sign-test", BOPS_PUBLIC_URL: "https://bop.1on1realtors.com" }, apiKey: "test-key", now: () => at, fetcher: api.fetcher as never, crm: null, webhookFetch });

  await poll(NOW);
  const first = readGapReport(w.root)?.checkedAt;
  assert.equal(first, NOW.toISOString());
  await poll(new Date(NOW.getTime() + 10 * 60_000));
  assert.equal(readGapReport(w.root)?.checkedAt, first, "no new gap check 10 minutes later");
  await poll(new Date(NOW.getTime() + 61 * 60_000));
  assert.equal(readGapReport(w.root)?.checkedAt, new Date(NOW.getTime() + 61 * 60_000).toISOString(), "a new gap check after the hour");
});
