import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowlistCheck } from "../flow/periskope.ts";
import { discoverGroups, type ApiChat } from "../node/periskope-discover.ts";
import { INTAKE_GROUPS, pollGroups } from "../node/periskope-groups.ts";
import { handleWebhook } from "../node/periskope-intake.ts";
import { pollOnce, type PollResult } from "../node/periskope-poll.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";

// Invented groups, ids and numbers only. No real names or message text.
const KEY = "test-signing-key";
const NOW = new Date("2026-11-14T15:00:00.000Z");
const BODY = "Looking for a 3 bed apartment in West Hills, budget 2,000,000";

/** Discovered by the hourly listing: a real-estate name with 40 members, not pinned in code. */
const DISC = { chat_id: "120000000011@g.us", chat_name: "Trinidad Realtors Network", member_count: 40 };
/** Never listed by Periskope, never in the roster, never in the env allowlist. */
const STRANGER = { chat_id: "120000000012@g.us", chat_name: "Trinidad Realtors Stranger" };
const PINNED = INTAKE_GROUPS[1];

const SENDER = "18685550101";

type Json = { status: number; body: unknown };

/** The poll's GET fake: the chat list, plus `messages` for the discovered group only (the pinned ones get none). */
function pollFetcher(chats: ApiChat[], messages: Record<string, unknown>[] = []) {
  return async (url: string): Promise<Json> => {
    if (url.startsWith("https://api.periskope.app/v1/chats?")) return { status: 200, body: { chats } };
    if (url.includes(`/v1/chats/${encodeURIComponent(DISC.chat_id)}/messages`)) return { status: 200, body: { messages } };
    if (url.includes("/messages")) return { status: 200, body: { messages: [] } };
    return { status: 200, body: { members: {} } };
  };
}

/** The webhook's fetch: only listing photos would call it, and these messages have none. Records every call. */
function webhookFetch() {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(String(url));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return Object.assign(f, { urls });
}

function world(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "periskope-watched-"));
  const env: Record<string, string> = { PERISKOPE_SIGNING_KEY: KEY, PERISKOPE_ALLOWED_GROUPS: "", PERISKOPE_ALLOWED_CHAT_IDS: "", ...extra };
  return { root, env, store: () => new PeriskopeStore(root) };
}

/** One hourly discovery pass over `chats`: the qualifying ones land in the roster (groups.json) and groups-added.jsonl. */
async function discover(root: string, env: Record<string, string>, chats: ApiChat[] = [DISC]) {
  const r = await discoverGroups({ apiKey: "test-key", fetcher: pollFetcher(chats) as never, intake: { root, env, now: () => NOW, crm: null } });
  assert.equal(r.ok, true);
  return r;
}

/** A webhook message.created envelope, the shape Periskope posts. */
function payload(chat: { chat_id: string; chat_name: string }, messageId: string, body = BODY) {
  return {
    event_type: "message.created",
    org_id: "org-1",
    timestamp: "2026-11-14T14:50:00Z",
    data: {
      message_id: messageId,
      chat_id: chat.chat_id,
      chat_name: chat.chat_name,
      sender_phone: SENDER,
      body,
      from_me: false,
      message_type: "chat",
      has_media: false,
      media: null,
      timestamp: "2026-11-14T14:50:00.000Z",
    },
  };
}

/** The same message as the poll's GET returns it (the backfill turns it into an envelope). */
function pollMessage(chat: { chat_id: string }, messageId: string, body = BODY) {
  return { message_id: messageId, chat_id: chat.chat_id, sender_phone: SENDER, author: SENDER, from_me: false, body, message_type: "chat", has_media: false, timestamp: "2026-11-14T14:50:00.000Z" };
}

function postTo(w: ReturnType<typeof world>, body: unknown, env: Record<string, string> = w.env, fetch = webhookFetch(), sig?: string | null) {
  const raw = Buffer.from(JSON.stringify(body));
  const signature = sig === undefined ? createHmac("sha256", KEY).update(raw).digest("hex") : sig;
  return handleWebhook(raw, signature, { root: w.root, env, now: () => NOW, crm: null, fetch });
}

test("a group only the roster knows (auto-discovered) gets past the webhook's allowlist", async () => {
  const w = world();
  const found = await discover(w.root, w.env);
  assert.deepEqual(found.ok && found.added.map((g) => g.chatId), [DISC.chat_id]);
  assert.ok(pollGroups(w.root, w.env).some((g) => g.chatId === DISC.chat_id && g.source === "auto"), "the poller watches it");
  const r = await postTo(w, payload(DISC, "wh-auto-1"));
  assert.equal(r.status, 200);
  assert.notEqual(r.body.result, "dropped: not allowlisted");
  assert.ok(w.store().isSeen("wh-auto-1"), "accepted: stored and marked seen");
});

test("a chat in neither the env nor the roster is dropped with 'dropped: not allowlisted', and nothing is stored", async () => {
  const w = world();
  await discover(w.root, w.env); // the roster is not empty, so this is not just an empty allowlist
  const fetch = webhookFetch();
  const r = await postTo(w, payload(STRANGER, "wh-stranger-1"), w.env, fetch);
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "dropped: not allowlisted");
  assert.ok(!w.store().isSeen("wh-stranger-1"));
  assert.equal(w.store().posts().length, 0);
  assert.equal(w.store().live().length, 0);
  assert.equal(fetch.urls.length, 0, "no Periskope or other call");
});

test("PERISKOPE_DENY_CHAT_IDS wins: a discovered group on the deny list is dropped, and so is one that the env allowlists", async () => {
  const w = world();
  await discover(w.root, w.env);
  const denied = { ...w.env, PERISKOPE_DENY_CHAT_IDS: DISC.chat_id };
  assert.equal(pollGroups(w.root, denied).some((g) => g.chatId === DISC.chat_id), false, "the poller does not read it either");
  const r = await postTo(w, payload(DISC, "wh-denied-1"), denied);
  assert.equal(r.body.result, "dropped: not allowlisted");
  assert.ok(!w.store().isSeen("wh-denied-1"));

  const both = { ...denied, PERISKOPE_ALLOWED_CHAT_IDS: DISC.chat_id };
  const r2 = await postTo(w, payload(DISC, "wh-denied-2"), both);
  assert.equal(r2.body.result, "dropped: not allowlisted", "deny beats the env allowlist too");
  assert.ok(!w.store().isSeen("wh-denied-2"));
});

test("the same message_id arriving by webhook and by poll is stored once, in either order", async () => {
  for (const order of ["webhook-first", "poll-first"] as const) {
    const w = world();
    await discover(w.root, w.env);
    const id = `dedupe-${order}`;
    const pollFetch = pollFetcher([DISC], [pollMessage(DISC, id)]);
    const poll = (): Promise<PollResult> => pollOnce({ root: w.root, env: w.env, apiKey: "test-key", now: () => NOW, fetcher: pollFetch as never, crm: null });
    const deliver = () => postTo(w, payload(DISC, id));

    let secondResult: string | undefined;
    let secondPollAdded: number | undefined;
    if (order === "webhook-first") {
      assert.notEqual((await deliver()).body.result, "dropped: not allowlisted");
      const p = await poll();
      secondPollAdded = p.groups.find((g) => g.chatId === DISC.chat_id)?.added;
    } else {
      const p = await poll();
      assert.equal(p.groups.find((g) => g.chatId === DISC.chat_id)?.added, 1, "the poll stores it first");
      secondResult = String((await deliver()).body.result);
    }

    const store = w.store();
    assert.equal(store.posts().filter((p) => p.messageId === id).length, 1, `${order}: one post`);
    assert.equal(store.live().filter((r) => r.messageId === id).length, 1, `${order}: one live row`);
    assert.ok(store.isSeen(id), `${order}: seen`);
    if (secondResult !== undefined) assert.equal(secondResult, "ignored: already seen", `${order}: the webhook's second delivery is a no-op`);
    if (secondPollAdded !== undefined) assert.equal(secondPollAdded, 0, `${order}: the poll after the webhook adds nothing`);
  }
});

test("the webhook accepts exactly the poller's set: every polled group passes, and a group the poller doesn't read is dropped", async () => {
  const w = world();
  await discover(w.root, w.env);
  const env = { ...w.env, PERISKOPE_DENY_CHAT_IDS: PINNED.chatId };
  const watched = pollGroups(w.root, env).map((g) => g.chatId);
  assert.ok(watched.includes(DISC.chat_id) && watched.length === INTAKE_GROUPS.length, "pinned (minus the denied one) plus the discovered group");
  for (const id of watched) assert.equal(allowlistCheck(id, null, env, watched), null, `${id} is polled, so it is accepted`);
  assert.equal(allowlistCheck(PINNED.chatId, PINNED.chatName, env, watched), "denied", "denied, even though it is pinned");
  assert.equal(allowlistCheck(STRANGER.chat_id, STRANGER.chat_name, env, watched), "other-group", "neither polled nor allowlisted");
});

test("an unsigned or wrongly signed POST is 401, and no signing key is 503, for a discovered group too", async () => {
  const w = world();
  await discover(w.root, w.env);
  const raw = Buffer.from(JSON.stringify(payload(DISC, "wh-unsigned-1")));
  const unsigned = await handleWebhook(raw, null, { root: w.root, env: w.env, now: () => NOW, crm: null, fetch: webhookFetch() });
  assert.equal(unsigned.status, 401);
  const wrong = await postTo(w, payload(DISC, "wh-unsigned-1"), w.env, webhookFetch(), "00".repeat(32));
  assert.equal(wrong.status, 401);
  const noKey = await postTo(w, payload(DISC, "wh-unsigned-1"), { ...w.env, PERISKOPE_SIGNING_KEY: "" }, webhookFetch(), createHmac("sha256", KEY).update(raw).digest("hex"));
  assert.equal(noKey.status, 503);
  assert.ok(!w.store().isSeen("wh-unsigned-1"), "nothing stored by a rejected post");
});
