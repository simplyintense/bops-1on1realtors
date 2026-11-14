import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { INTAKE_GROUPS } from "../node/periskope-backfill.ts";
import { setConsent } from "../node/periskope-intake.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { pollOnce, readApiKey } from "../node/periskope-poll.ts";

const NOW = new Date("2026-11-14T15:00:00.000Z");
const FIRST = INTAKE_GROUPS[0];

function msg(over: Record<string, unknown> = {}) {
  return {
    message_id: "poll-msg-1",
    chat_id: FIRST.chatId,
    sender_phone: "18685550101",
    author: "18685550101",
    from_me: false,
    body: "Looking for a 3 bed apartment in West Hills, budget 2,000,000",
    message_type: "chat",
    has_media: false,
    timestamp: "2026-11-14T14:50:00.000Z",
    ...over,
  };
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "periskope-poll-"));
  const env = {
    PERISKOPE_ALLOWED_GROUPS: INTAKE_GROUPS.map((g) => g.chatName).join("|"),
    PERISKOPE_ALLOWED_CHAT_IDS: INTAKE_GROUPS.map((g) => g.chatId).join("|"),
  };
  return { root, env };
}

test("readApiKey uses a 0600 key file and never requires a new secret name", () => {
  const root = mkdtempSync(join(tmpdir(), "periskope-key-"));
  assert.equal(readApiKey({ root, env: {} }), "");
  writeFileSync(join(root, ".api-key"), "test-key-value\n", { mode: 0o600 });
  assert.equal(readApiKey({ root, env: {} }), "test-key-value");
});

test("pollOnce is GET-only, stores a new demand post once, and is idempotent on the same message_id", async () => {
  const w = world();
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    if (url.includes("/messages")) return { status: 200, body: { messages: [msg()] } };
    return { status: 200, body: { members: { a: { contact_id: "18685550101", contact_name: "Test Agent" } } } };
  };
  for (const g of INTAKE_GROUPS) {
    await setConsent({
      chatId: g.chatId,
      groupName: g.chatName,
      noticeWaivedAt: "2026-11-14T13:39:00.000Z",
      noticeWaivedBy: "owner",
      adminOkAt: "2026-11-14T13:39:00.000Z",
      adminOkBy: "Miles Abraham",
    }, { root: w.root, env: w.env, now: () => NOW });
  }
  const first = await pollOnce({ root: w.root, env: w.env, apiKey: "test-key", now: () => NOW, fetcher, crm: null });
  assert.equal(first.ok, true);
  assert.ok(urls.every((u) => u.startsWith("https://api.periskope.app/v1/")), "only the public Periskope GET API");
  assert.equal(urls.some((u) => u.includes("/messages")), true);
  const store = new PeriskopeStore(w.root);
  assert.equal(store.posts().filter((p) => p.messageId === "poll-msg-1").length, 1);
  assert.equal(store.demand().filter((p) => p.messageId === "poll-msg-1").length, 1);
  assert.equal(store.demand()[0]?.senderName, "Test Agent");

  const second = await pollOnce({ root: w.root, env: w.env, apiKey: "test-key", now: () => NOW, fetcher, crm: null });
  assert.equal(second.ok, true);
  assert.equal(store.posts().filter((p) => p.messageId === "poll-msg-1").length, 1);
  const firstGroup = first.groups.find((g) => g.chatId === FIRST.chatId);
  const secondGroup = second.groups.find((g) => g.chatId === FIRST.chatId);
  assert.equal(firstGroup?.added, 1);
  assert.equal(secondGroup?.added, 0);
  assert.equal(first.alertsAdded, 0);
});
