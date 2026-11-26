import assert from "node:assert/strict";
import { test } from "node:test";
import { isStaffChatOf, staffAuthStatus, staffChatId, staffState, type StaffSource } from "../../lib/staff-workspace.ts";

/**
 * The Bot Workspace for staff (lib/staff-workspace.ts): the state they're sent, their own chats, and the chat isolation checks the
 * routes use. Invented fixtures only; the secrets below are markers, so a leak shows up as the marker in the payload.
 */

const OWNER = "miles@1on1.example";
const KERRY = "kerry@1on1.example";
const SAM = "sam@1on1.example";

const SECRETS = ["SECRET-APPS-KEY", "SECRET-BOT-PROMPT", "SECRET-VAULT-PASSWORD", "SECRET-OWNER-PHONE", "SECRET-OWNER-EMAIL", "SECRET-ORBIT-KEY", "SECRET-ORGO-USER", "SECRET-USAGE", "SECRET-MEMORY", "SECRET-OWNER-MESSAGE", "SECRET-SESSION-ANSWER", "SECRET-CARD"];

/** The owner's default bot chat: OWNER_CHAT (lib/types.ts). Not imported: lib/types.ts has extensionless imports node --test can't load. */
const OWNER_CHAT = "bot:wendy";
const KERRY_CHAT = staffChatId("wendy", KERRY);
const SAM_CHAT = staffChatId("wendy", SAM);

/** A workspace with the owner's default bot chat, a group, and one chat each for Kerry and Sam, each with its messages and the owner's secrets around them. */
function fixture(): StaffSource {
  return {
    host: "orgo",
    workspace: "ws_main",
    workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, orbitKey: "SECRET-ORBIT-KEY", orgoProjectId: "SECRET-ORGO-USER", memberAccess: {} }],
    bots: [
      { id: "wendy", name: "Wendy", role: "Assistant", color: "#7a5af8", isMain: true, computerStatus: "ready", workspaceId: "ws_main", persona: "SECRET-BOT-PROMPT", appsKey: "SECRET-APPS-KEY", keys: ["SECRET-CARD"], autoApprove: true },
    ],
    chats: [
      { id: OWNER_CHAT, kind: "bot", botIds: ["wendy"], createdAt: 1, typing: [], summary: { text: "SECRET-OWNER-MESSAGE" } as never },
      { id: KERRY_CHAT, kind: "bot", botIds: ["wendy"], createdAt: 2, typing: [], staff: KERRY },
      { id: SAM_CHAT, kind: "bot", botIds: ["wendy"], createdAt: 3, typing: [], staff: SAM },
    ],
    messages: [
      { id: "m-owner", chatId: OWNER_CHAT, role: "user", text: "SECRET-OWNER-MESSAGE", at: 1, memory: { ws: "ws_main", id: "x", fact: "SECRET-MEMORY" } as never },
      { id: "m-kerry", chatId: KERRY_CHAT, role: "user", text: "Kerry's question", at: 2 },
      { id: "m-kerry-reply", chatId: KERRY_CHAT, role: "bot", botId: "wendy", text: "Wendy's answer", at: 3, crm: { ws: "ws_main", file: "x", added: 1, changed: 0, after: "SECRET-MEMORY" } as never },
      { id: "m-sam", chatId: SAM_CHAT, role: "user", text: "Sam's question", at: 4 },
    ],
    sessions: [{ id: "s1", botId: "wendy", chatId: OWNER_CHAT, status: "done", answer: "SECRET-SESSION-ANSWER" } as never],
    routines: [{ id: "r1", botId: "wendy", title: "SECRET-ROUTINE" } as never],
    vault: [{ id: "v1", site: "bank", user: "owner", password: "SECRET-VAULT-PASSWORD" } as never],
    ownerPhones: [{ number: "SECRET-OWNER-PHONE", consentAt: 1 }],
    ownerEmails: [{ address: "SECRET-OWNER-EMAIL", verifiedAt: 1 }],
    account: { user: { id: "SECRET-ORGO-USER", email: OWNER }, signedInAt: 1 },
    usage: [{ at: 1, cost: 1, note: "SECRET-USAGE" } as never],
    credits: { out: false, at: 1 },
    mac: { name: "Miles's Mac" } as never,
    liveMoods: { wendy: { mood: "thinking" } },
    screenStream: true,
  } as unknown as StaffSource;
}

test("staffState: isOwner is false, and nothing of the owner's state is in it: no secrets, no vault, no owner phones or emails, no account, billing or usage", () => {
  const view = staffState(fixture(), KERRY);
  assert.equal(view.isOwner, false);
  const text = JSON.stringify(view);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `the staff view has ${secret}`);
  for (const key of ["vault", "ownerPhones", "ownerEmails", "account", "usage", "credits", "mac", "liveMoods", "screenStream"]) assert.equal(key in view, false, key);
  assert.deepEqual([view.routines, view.sessions], [[], []], "no routines or sessions of the owner's");
});

test("staffState: a bot is its id, name, colour and whether it's main; the prompt, keys and settings aren't there", () => {
  const [bot] = staffState(fixture(), KERRY).bots;
  assert.deepEqual(Object.keys(bot).sort(), ["color", "computerStatus", "id", "isMain", "name", "role", "workspaceId"]);
  assert.equal(bot.name, "Wendy");
  assert.equal(bot.isMain, true);
});

test("staffState: a workspace keeps only its id, name and creation time (no Orbit key, Orgo project or member access)", () => {
  const [ws] = staffState(fixture(), KERRY).workspaces ?? [];
  assert.deepEqual(Object.keys(ws).sort(), ["createdAt", "id", "name"]);
});

test("staffState: a staff member sees only their own chats and the messages in them, never the owner's default bot chat or another staff member's", () => {
  const forKerry = staffState(fixture(), KERRY);
  assert.deepEqual(forKerry.chats.map((c) => c.id), [KERRY_CHAT]);
  assert.deepEqual(forKerry.messages.map((m) => m.id), ["m-kerry", "m-kerry-reply"]);
  assert.equal(forKerry.chats.some((c) => c.id === OWNER_CHAT), false, "the owner's default bot chat");
  const forSam = staffState(fixture(), SAM);
  assert.deepEqual(forSam.chats.map((c) => c.id), [SAM_CHAT]);
  assert.deepEqual(forSam.messages.map((m) => m.id), ["m-sam"]);
});

test("staffState: a message keeps only what the chat shows (no memory, CRM or app fields)", () => {
  const reply = staffState(fixture(), KERRY).messages.find((m) => m.id === "m-kerry-reply");
  assert.ok(reply);
  assert.equal("crm" in reply, false);
  assert.equal(reply.text, "Wendy's answer");
  assert.equal(reply.botId, "wendy");
});

test("isStaffChatOf: a staff member's own chat is theirs (any case of their address); another's, the owner's default chat and a group are not", () => {
  const chats = fixture().chats;
  const [owner, kerry, sam] = chats;
  assert.equal(isStaffChatOf(kerry, KERRY), true);
  assert.equal(isStaffChatOf(kerry, "Kerry@1on1.example"), true, "case doesn't matter");
  assert.equal(isStaffChatOf(kerry, SAM), false, "another staff member's chat");
  assert.equal(isStaffChatOf(sam, KERRY), false);
  assert.equal(isStaffChatOf(owner, KERRY), false, "the owner's default bot chat, untagged");
  assert.equal(isStaffChatOf(owner, OWNER), false, "the owner doesn't get a staff tag either");
  const group = { id: "grp_1", staff: undefined };
  assert.equal(isStaffChatOf(group, KERRY), false, "a group chat has no staff tag");
  assert.equal(isStaffChatOf(undefined, KERRY), false, "no such chat");
});

test("unauthenticated: no signed-in email means no chat is theirs, whatever the chat says", () => {
  const [, kerry] = fixture().chats;
  assert.equal(isStaffChatOf(kerry, null), false);
  assert.equal(isStaffChatOf(kerry, undefined), false);
  assert.equal(isStaffChatOf(kerry, ""), false);
  const emptyTag = { id: "x", staff: "" };
  assert.equal(isStaffChatOf(emptyTag, ""), false, "an empty tag matches nothing");
});

test("staffChatId: one per staff member and bot, never the owner's id, and made of [0-9a-f] so the gate's path rule can match it", () => {
  assert.equal(staffChatId("wendy", KERRY), staffChatId("wendy", KERRY), "stable");
  assert.notEqual(staffChatId("wendy", KERRY), staffChatId("wendy", SAM), "per staff member");
  assert.notEqual(staffChatId("wendy", KERRY), staffChatId("ellis", KERRY), "per bot");
  assert.equal(staffChatId("wendy", "Kerry@1on1.example"), KERRY_CHAT, "the address is lower-cased");
  assert.notEqual(KERRY_CHAT, OWNER_CHAT);
  assert.match(KERRY_CHAT, /^stf_[0-9a-f]+_[0-9a-f]+$/);
  assert.equal(KERRY_CHAT.includes(":"), false, "no colon, so the owner's bot:<id> form can't collide");
});

test("staffAuthStatus: a staff member is signed in as themselves, never asked to sign in to Orgo, and the owner's Orgo account isn't in it", () => {
  const s = staffAuthStatus(KERRY);
  assert.equal(s.signedIn, true);
  assert.equal(s.needsSignIn, false);
  assert.equal(s.cloudProblem, false);
  assert.equal(s.isOwner, false);
  assert.equal(s.user.email, KERRY);
  assert.equal(JSON.stringify(s).includes("SECRET-ORGO-USER"), false);
});
