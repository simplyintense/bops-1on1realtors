import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GATE_COOKIE, gateConfig, makeSession } from "../../lib/gate.ts";
import type { PostRecord } from "../flow/periskope.ts";
import { findPostView, listPostPage, listPostViews, postView, postsToCsv, dateAst } from "../node/group-posts.ts";
import { ownerAccess } from "../node/periskope-intake.ts";
import { PeriskopeStore, requestIdOf } from "../node/periskope-store.ts";

const OWNER = "miles@1on1.example";
const AGENT = "kerry@1on1.example";
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example", BOPS_OWNER_EMAILS: OWNER };
const cfg = gateConfig(GATE);
if (!cfg || cfg === "misconfigured") throw new Error("test config");

const SAMPLE: PostRecord = {
  messageId: "false_120363000000000000@g.us_abc",
  chatId: "120363000000000000@g.us",
  sentAt: "2026-11-10T14:00:00.000Z",
  category: "listing_for_sale",
  cobroke: true,
  senderPhone: "+18685550201",
  senderName: "Agent Ann",
  firm: null,
  area: "Maraval",
  price: 1_200_000,
  currency: "TTD",
  beds: 3,
  baths: 2,
  type: "townhouse",
  listingType: "sale",
  intent: "buy",
  propertyClass: "residential_sale",
  notes: "3 bed townhouse in Maraval, TT$1200000",
  originalText: "SECRET original body that agents must not see",
  groupName: "AREA Registered Agents",
};

test("postView includes originalText only for an owner; an agent never receives the field", () => {
  const owner = postView(SAMPLE, true);
  const agent = postView(SAMPLE, false);
  assert.equal(owner.originalText, SAMPLE.originalText);
  assert.equal("originalText" in agent, false);
  assert.equal(agent.area, "Maraval");
  assert.equal(agent.category, "listing_for_sale");
});

test("list and detail helpers keep originalText off agent views", () => {
  const store = new PeriskopeStore(mkdtempSync(join(tmpdir(), "group-posts-")));
  store.addPost(SAMPLE);
  const id = requestIdOf(SAMPLE.messageId);
  const ownerList = listPostViews(store, true);
  const agentList = listPostViews(store, false);
  assert.equal(ownerList[0]?.originalText, SAMPLE.originalText);
  assert.equal("originalText" in (agentList[0] ?? {}), false);
  assert.equal(findPostView(store, id, true)?.originalText, SAMPLE.originalText);
  assert.equal("originalText" in (findPostView(store, id, false) ?? {}), false);
});

test("the post page's staff view: any staff gets the original text, a non-owner never gets the group name or chat id", () => {
  const store = new PeriskopeStore(mkdtempSync(join(tmpdir(), "group-posts-staff-")));
  store.addPost(SAMPLE);
  const id = requestIdOf(SAMPLE.messageId);
  const staff = findPostView(store, id, false, true);
  assert.equal(staff?.originalText, SAMPLE.originalText, "a staff member sees the original text");
  assert.equal(staff?.area, "Maraval", "and the parsed fields");
  assert.equal("groupName" in (staff ?? {}), false, "no group name for a non-owner");
  assert.equal("chatId" in (staff ?? {}), false, "no chat id for a non-owner");
  assert.equal(JSON.stringify(staff).includes(SAMPLE.groupName ?? "\u0000"), false, "the group name appears nowhere in the view");
  const plain = findPostView(store, id, false);
  assert.equal("originalText" in (plain ?? {}), false, "without the flag, a non-owner still gets no text");
  const owner = findPostView(store, id, true);
  assert.equal(owner?.groupName, SAMPLE.groupName, "an owner keeps the group name and chat id");
  assert.equal(owner?.chatId, SAMPLE.chatId);
});

test("the group-posts API gate is owners only: an agent gets 403, signed out 401, the owner passes", async () => {
  const req = async (email: string | null) =>
    new Request("https://bops.example/api/realty/posts", { headers: email ? { cookie: `${GATE_COOKIE}=${await makeSession(email, cfg)}` } : {} });
  assert.equal(await ownerAccess(await req(OWNER), GATE), null);
  assert.equal((await ownerAccess(await req(AGENT), GATE))?.status, 403);
  assert.equal((await ownerAccess(await req(null), GATE))?.status, 401);
});

test("dateAst reports Port of Spain time, and the CSV has a header plus one data row", () => {
  assert.match(dateAst("2026-11-14T13:39:00.000Z"), /2026-11-14 09:39 AST/);
  const store = new PeriskopeStore(mkdtempSync(join(tmpdir(), "group-csv-")));
  store.addPost(SAMPLE);
  const csv = postsToCsv(store);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /original text/);
  assert.match(lines[0], /(?:^|,)group(?:$|,)/);
  assert.match(lines[0], /(?:^|,)set(?:$|,)/);
  assert.match(lines[0], /(?:^|,)development(?:$|,)/);
  assert.match(lines[1], /listing_for_sale/);
  assert.match(lines[1], /AREA Registered Agents/);
});

test("listPostPage returns one newest-first page and a total, without mutating the store list", () => {
  const store = new PeriskopeStore(mkdtempSync(join(tmpdir(), "group-posts-page-")));
  const older = { ...SAMPLE, messageId: "false_120363000000000000@g.us_old", sentAt: "2026-11-01T14:00:00.000Z" };
  const mid = { ...SAMPLE, messageId: "false_120363000000000000@g.us_mid", sentAt: "2026-11-05T14:00:00.000Z" };
  const newest = { ...SAMPLE, messageId: "false_120363000000000000@g.us_new", sentAt: "2026-11-10T14:00:00.000Z" };
  store.addPost(older);
  store.addPost(mid);
  store.addPost(newest);
  const first = listPostPage(store, false, { limit: 2, offset: 0 });
  const second = listPostPage(store, false, { limit: 2, offset: 2 });
  assert.equal(first.total, 3);
  assert.deepEqual(first.rows.map((r) => r.sentAt), [newest.sentAt, mid.sentAt]);
  assert.equal(second.total, 3);
  assert.deepEqual(second.rows.map((r) => r.sentAt), [older.sentAt]);
  assert.equal(listPostPage(store, false, { limit: 2, offset: 50 }).rows.length, 0);
  assert.equal("originalText" in (first.rows[0] ?? {}), false, "agents still do not receive originalText");
  assert.equal(store.posts().length, 3, "the store still holds every post");
});
