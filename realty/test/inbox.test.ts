import assert from "node:assert/strict";
import { test } from "node:test";
import { CrmIndex } from "../dedupe.ts";
import { classify, parseInboxAgents, proposalsForEmail, type Email } from "../inbox.ts";
import { checkWrite } from "../crm.ts";
import { rawReply } from "../google.ts";

/** The agent inbox sorter on synthetic mail. */

const mail = (o: Partial<Email>): Email => ({ id: "m1", threadId: "t1", from: "Alex Buyer <alex.buyer@example.com>", to: "agent@example.com", subject: "", date: "2026-11-02T13:00:00.000Z", messageId: "<m1@example.com>", body: "", ...o });
const agent = { slug: "kerry", email: "kerry@example.com", name: "Kerry Ann Test", crmAgentId: 3 };

test("sorts the five kinds of mail", () => {
  assert.equal(classify(mail({ subject: "Apartment in Woodbrook", body: "Hi, I'm interested in the 2 bedroom apartment for rent in Woodbrook. Is it still available?" })).category, "lead");
  assert.equal(classify(mail({ subject: "Viewing", body: "Could I view the house on Saturday morning?" })).category, "viewing_request");
  assert.equal(classify(mail({ subject: "Offer for Lot 5", body: "We would like to make an offer of TT$1.2M for the land, with a 10% deposit." })).category, "offer");
  assert.equal(classify(mail({ subject: "Re: Maraval townhouse", body: "Just following up on my message from last week." })).category, "follow_up");
  assert.equal(classify(mail({ from: "Deals <no-reply@shop.example>", subject: "50% off", body: "Big sale this weekend. Unsubscribe here." })).category, "other");
});

test("a website lead notice from no-reply is still a lead", () => {
  const s = classify(mail({ from: "1on1 Realtors <no-reply@1on1realtors.com>", subject: "New contact form submission", body: "Name: Sam Fixture\nLooking for a house in Arima" }));
  assert.equal(s.category, "lead");
});

test("a lead gets a contact row, an Asana task and a draft, all unapproved and unsent", () => {
  const e = mail({ subject: "Apartment in Woodbrook", body: "I'm interested in a 2 bedroom apartment for rent in Woodbrook, budget $8,000 a month. 868-555-0101" });
  const { proposals } = proposalsForEmail(e, { agent, crm: new CrmIndex([]), asanaProject: "1234567890" });
  assert.equal(proposals.length, 1);
  const [p] = proposals;
  assert.equal(p.approved, false);
  assert.equal(p.write?.table, "contact_submissions");
  assert.equal(p.write?.table === "contact_submissions" && p.write.row.email, "alex.buyer@example.com");
  assert.equal(p.asana?.project, "1234567890");
  assert.equal(p.draft?.to, "alex.buyer@example.com");
  assert.match(p.draft!.body, /^Hi Alex,/);
  assert.match(p.draft!.body, /Kerry Ann Test/);
});

test("a known client's offer becomes a high-priority task for the agent, not a new contact", () => {
  const crm = new CrmIndex([{ table: "crm_clients", id: "c-9", name: "Alex Buyer", email: "alex.buyer@example.com", phone: null, agentId: 3 }]);
  const { proposals } = proposalsForEmail(mail({ subject: "Offer", body: "We'd like to make an offer of $2.1M" }), { agent, crm, asanaProject: null });
  const [p] = proposals;
  assert.equal(p.crm, "duplicate");
  assert.equal(p.write?.table, "crm_tasks");
  assert.equal(p.write?.table === "crm_tasks" && p.write.row.priority, "high");
  assert.equal(p.asana?.project, null, "no Asana project set: the task is only described");
});

test("other mail makes no proposals", () => {
  assert.equal(proposalsForEmail(mail({ from: "news@x.example", subject: "Newsletter", body: "unsubscribe" }), { agent, crm: null, asanaProject: null }).proposals.length, 0);
});

test("ONEON1_INBOX_AGENTS parsing", () => {
  assert.deepEqual(parseInboxAgents("kerry:kerry@example.com:3:Kerry Ann Test, bad entry, wendy:wendy@example.com::Wendy"), [
    { slug: "kerry", email: "kerry@example.com", crmAgentId: 3, name: "Kerry Ann Test" },
    { slug: "wendy", email: "wendy@example.com", crmAgentId: null, name: "Wendy" },
  ]);
});

test("the CRM writer only takes the two tables and their columns", () => {
  assert.throws(() => checkWrite({ table: "crm_clients", row: {} } as never), /isn't allowed/);
  assert.throws(() => checkWrite({ table: "crm_tasks", row: { title: "x", message: "", assignee_agent_id: null, priority: "low", status: "open", due_date: null } }), /needs an agent/);
  assert.throws(() => checkWrite({ table: "crm_tasks", row: { title: "x", message: "", assignee_agent_id: 1, priority: "low", status: "open", due_date: null, deleted_at: "now" } as never }), /unexpected columns/);
});

test("a drafted reply can't smuggle headers in", () => {
  const raw = Buffer.from(rawReply({ to: "a@example.com\r\nBcc: evil@example.com", subject: "Hi", body: "x", inReplyTo: null }), "base64url").toString("utf8");
  assert.doesNotMatch(raw, /\r\nBcc:/);
});

test("the CRM writer refuses without ONEON1_CRM_WRITES=1 and approval, then posts one row", async () => {
  const { Crm } = await import("../crm.ts");
  const calls: { url: string; body: string | null }[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: (init?.body as string) ?? null });
    if (String(url).includes("/auth/v1/token")) return Response.json({ access_token: "session", expires_in: 3600 });
    return Response.json([{ id: "new-row" }], { status: 201 });
  }) as typeof fetch;
  const crm = new Crm({ url: "https://example.supabase.co", anon: "anon", email: "bot@example.com", password: "pw" }, fake);
  const p = proposalsForEmail(mail({ subject: "Offer", body: "We'd like to make an offer of $2.1M" }), { agent, crm: null, asanaProject: null }).proposals[0];
  await assert.rejects(crm.apply(p, {}), /writes are off/);
  await assert.rejects(crm.apply(p, { ONEON1_CRM_WRITES: "1" }), /isn't approved/);
  assert.equal(calls.length, 0, "nothing reached the CRM");
  assert.equal(await crm.apply({ ...p, approved: true }, { ONEON1_CRM_WRITES: "1" }), "new-row");
  assert.equal(calls.at(-1)?.url, "https://example.supabase.co/rest/v1/crm_tasks");
});
