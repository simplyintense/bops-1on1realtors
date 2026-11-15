import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GroupConsent } from "../flow/periskope.ts";
import { handleWebhook, ingestEvent, setConsent } from "../node/periskope-intake.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { readWebhookStatus, timeAst, webhookStatusLabel, WEBHOOK_STATUS_FILE } from "../node/webhook-status.ts";

/** The signed webhook's accepted line, its status file and the desk label. Invented numbers and names only. */

const KEY = "test-signing-key";
const CHAT = "120363000000000001@g.us";
const GROUP = "Co-broke Tobago";
const SENDER = "18685550202@c.us";
const LISTING_TEXT = "3 bed townhouse Maraval TT$1.2M co-broke 50/50";
const NOW = new Date("2026-11-13T20:00:00.000Z");

const sign = (raw: string) => createHmac("sha256", KEY).update(raw).digest("hex");

const envelope = (over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) => ({
  event_type: "message.created",
  org_id: "org-1",
  timestamp: "2026-11-13T20:00:00Z",
  data: {
    message_id: "false_" + CHAT + "_bbbbbbbb",
    chat_id: CHAT,
    chat_name: GROUP,
    sender_phone: SENDER,
    body: LISTING_TEXT,
    from_me: false,
    message_type: "chat",
    has_media: false,
    media: null,
    ...dataOver,
  },
  ...over,
});

function world() {
  const root = mkdtempSync(join(tmpdir(), "periskope-status-"));
  const env = { PERISKOPE_SIGNING_KEY: KEY, PERISKOPE_ALLOWED_GROUPS: GROUP };
  const opts = { root, env, now: () => NOW, crm: null, market: null, ours: null };
  const post = (payload: unknown, sig?: string | null, when: Date = NOW) =>
    handleWebhook(Buffer.from(JSON.stringify(payload)), sig === undefined ? sign(JSON.stringify(payload)) : sig, { ...opts, now: () => when });
  return { root, opts, post, store: () => new PeriskopeStore(root), statusFile: join(root, WEBHOOK_STATUS_FILE) };
}

async function withConsent(w: ReturnType<typeof world>) {
  const consent: GroupConsent = { chatId: CHAT, groupName: GROUP, noticePostedAt: "2026-11-01T12:00:00.000Z", noticeWaivedAt: null, noticeWaivedBy: null, adminOkBy: "Office admin", adminOkAt: "2026-11-02T12:00:00.000Z", active: true };
  await setConsent(consent, w.opts);
}

/** Collects what console.info prints while fn runs. */
async function capturingInfo<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.info = original;
  }
}

test("a signed accepted first delivery writes the status (added, count 1) and logs one line with no text, phone or chat id", async () => {
  const w = world();
  await withConsent(w);
  const { result, lines } = await capturingInfo(() => w.post(envelope({}, { message_id: "m-first" })));
  assert.equal(result.status, 200);

  const status = readWebhookStatus(w.root);
  assert.equal(status.lastOutcome, "added");
  assert.equal(status.acceptedCount, 1);
  assert.equal(status.lastAcceptedAt, NOW.toISOString());
  assert.equal(status.lastEventType, "message.created");
  assert.equal(status.lastGroupName, GROUP);

  const accepted = lines.filter((l) => l.startsWith("periskope: webhook accepted"));
  assert.deepEqual(accepted, [`periskope: webhook accepted event=message.created group=${GROUP} outcome=added`]);
  const everything = lines.join("\n");
  assert.ok(!everything.includes("Maraval"), "no message text in the log");
  assert.ok(!everything.includes("18685550202"), "no phone in the log");
  assert.ok(!everything.includes(CHAT), "no chat id in the log");
});

test("a second delivery of the same message_id is duplicate: count goes to 2, lastAcceptedAt moves on, and no second record is made", async () => {
  const w = world();
  await withConsent(w);
  await w.post(envelope({}, { message_id: "m-dupe-status" }));
  const later = new Date("2026-11-13T20:30:00.000Z");
  const { result, lines } = await capturingInfo(() => w.post(envelope({}, { message_id: "m-dupe-status" }), undefined, later));
  assert.equal(result.status, 200);
  assert.match(String(result.body.result), /already seen/);

  const status = readWebhookStatus(w.root);
  assert.equal(status.lastOutcome, "duplicate");
  assert.equal(status.acceptedCount, 2);
  assert.equal(status.lastAcceptedAt, later.toISOString());
  assert.ok(lines.includes(`periskope: webhook accepted event=message.created group=${GROUP} outcome=duplicate`));
  assert.equal(w.store().market().filter((r) => r.item.kind === "listing").length, 1, "still one stored listing");
});

test("the poll and backfill path (ingestEvent) never creates or updates the status file", async () => {
  const w = world();
  await withConsent(w);
  await ingestEvent(envelope({}, { message_id: "m-poll" }), w.opts);
  await ingestEvent(envelope({}, { message_id: "m-poll" }), w.opts);
  assert.equal(existsSync(w.statusFile), false);
  assert.equal(readWebhookStatus(w.root).acceptedCount, 0);
});

test("a signed message.updated is 200 and ignored: it does not count as accepted, and its event type is logged", async () => {
  const w = world();
  await withConsent(w);
  const { result, lines } = await capturingInfo(() => w.post(envelope({ event_type: "message.updated" })));
  assert.equal(result.status, 200);
  assert.match(String(result.body.result), /message\.updated isn't handled/);

  const status = readWebhookStatus(w.root);
  assert.equal(status.lastAcceptedAt, null);
  assert.equal(status.acceptedCount, 0);
  assert.deepEqual(
    lines.filter((l) => l.startsWith("periskope: webhook ")),
    ["periskope: webhook ignored event=message.updated reason=message.updated isn't handled"],
  );
});

test("401 and 503 never write the status file", async () => {
  const w = world();
  await withConsent(w);
  const raw = JSON.stringify(envelope({}, { message_id: "m-unsigned" }));
  const { lines } = await capturingInfo(async () => {
    assert.equal((await w.post(envelope({}, { message_id: "m-unsigned" }), null)).status, 401);
    assert.equal((await w.post(envelope({}, { message_id: "m-unsigned" }), "deadbeef")).status, 401);
    assert.equal((await handleWebhook(Buffer.from(raw), sign(raw), { ...w.opts, env: {} })).status, 503);
  });
  assert.equal(existsSync(w.statusFile), false);
  assert.equal(lines.filter((l) => l.includes("webhook accepted")).length, 0);
});

test("the desk label: a known ISO in the AST morning reads 7:58 AM, the afternoon reads PM, and an empty status says no messages yet", () => {
  // 11:58 UTC is 07:58 in Port of Spain (UTC-4, no daylight saving).
  assert.equal(timeAst("2026-11-13T11:58:00.000Z"), "7:58 AM");
  assert.equal(timeAst("2026-11-13T20:05:00.000Z"), "4:05 PM");
  assert.equal(timeAst("not a date"), null);

  const w = world();
  assert.equal(webhookStatusLabel(readWebhookStatus(w.root)), "Live feed: no messages yet");
  assert.equal(
    webhookStatusLabel({ lastAcceptedAt: "2026-11-13T11:58:00.000Z", lastEventType: "message.created", lastGroupName: GROUP, lastOutcome: "added", acceptedCount: 1 }),
    "Live feed: last message 7:58 AM",
  );
});
