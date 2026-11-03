import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { findActions, dueFrom } from "../actions.ts";
import { CrmIndex, phoneKey } from "../dedupe.ts";
import { findBudget, findAreas, findInterest, findNames, findPhones, looksLikeLead, normalizePhone } from "../extract.ts";
import { readExport } from "../wa-reader.ts";
import { detectOrder, parseChat } from "../whatsapp.ts";
import { chatTextFromZip, writeZip } from "../zip.ts";

/** The WhatsApp export reader against synthetic exports (test/fixtures: made-up people, 555 numbers). */

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const agents = [
  { id: 3, name: "Kerry Ann Test", email: null, phone: null },
  { id: 4, name: "Devon Example", email: null, phone: null },
];
const crm = new CrmIndex([{ table: "crm_clients", id: "c-1", name: "Pat Existing", email: null, phone: "(868) 555-0177", agentId: 3 }]);

test("parses an iPhone export: senders, times, notices and media apart", () => {
  const msgs = parseChat(fixture("sample-export.txt").toString("utf8"));
  assert.equal(msgs.length, 10);
  assert.equal(msgs[0].system, true, "the encryption notice is a system line");
  assert.equal(msgs[1].sender, "Kerry Ann Test");
  assert.equal(msgs[1].at, "2026-10-28T09:02:40");
  assert.equal(msgs[4].media, true);
  assert.equal(msgs[5].sender, "+1 (868) 555-0199");
});

test("parses an Android export with 12-hour times and month first", () => {
  const text = fixture("sample-android.txt").toString("utf8");
  assert.equal(detectOrder(text.split("\n")), "mdy");
  const msgs = parseChat(text);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].at, "2026-10-28T09:02:00");
  assert.equal(msgs[2].media, true);
});

test("continuation lines join the message before", () => {
  const msgs = parseChat("[01/11/2026, 10:00:00] A Person: first line\nsecond line\n[01/11/2026, 10:01:00] B Person: next");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, "first line\nsecond line");
});

test("phones: T&T numbers in every common way, normalized", () => {
  assert.deepEqual(findPhones("call 868-555-0142 or (868) 555 0143 or +1 868 555 0144 or 555-0145"), ["+18685550142", "+18685550143", "+18685550144", "+18685550145"]);
  assert.equal(normalizePhone("1-868-555-0142"), "+18685550142");
  assert.deepEqual(findPhones("price TT$3,500,000"), []);
  assert.equal(phoneKey("+1 (868) 555-0177"), phoneKey("868 555 0177"));
});

test("budgets: ranges, millions, monthly rent, currency", () => {
  assert.deepEqual(findBudget("budget TT$2.5M - 3M"), { min: 2_500_000, max: 3_000_000, currency: "TTD", period: null, text: "TT$2.5M - 3M" });
  const rent = findBudget("My budget is $8,000 a month");
  assert.equal(rent?.max, 8000);
  assert.equal(rent?.period, "month");
  assert.equal(findBudget("land in Tobago, US$450k")?.currency, "USD");
  assert.equal(findBudget("3-4 bedrooms please"), null);
});

test("areas, kind of property and names", () => {
  assert.deepEqual(findAreas("Westmoorings or Diego Martin, maybe West Moorings"), ["Westmoorings", "Diego Martin"]);
  assert.deepEqual(findInterest("a 3 bed townhouse to buy"), { intent: "buy", types: ["townhouse"], bedrooms: 3 });
  assert.deepEqual(findInterest("two bedroom apartment for rent").intent, "rent");
  assert.deepEqual(findNames("New client Jordan Sample is looking"), ["Jordan Sample"]);
  assert.deepEqual(findNames("name: Chris Placeholder"), ["Chris Placeholder"]);
  assert.equal(looksLikeLead("Lunch anyone?"), false);
});

test("action items with due days from the message's date", () => {
  const [a] = findActions("@Kerry Ann please call her tomorrow", "2026-10-28T09:10:22");
  assert.equal(a.kind, "call");
  assert.equal(a.due, "2026-10-29");
  assert.deepEqual(a.mentions, ["Kerry Ann"]);
  assert.equal(dueFrom("viewing on Friday", "2026-10-28T00:00:00"), "2026-10-30");
  assert.equal(dueFrom("on 5/11", "2026-10-28T00:00:00"), "2026-11-05");
  assert.deepEqual(findActions("Noted", "2026-10-28T00:00:00"), []);
});

test("an export becomes deduped lead and task proposals, none approved, none written", () => {
  const r = readExport("WhatsApp Chat with 1on1 Leads.txt", fixture("sample-export.txt"), { crm, agents, defaultAgentId: 9 });
  assert.equal(r.chat, "1on1 Leads");
  const leads = r.proposals.filter((p) => p.kind === "lead");
  const tasks = r.proposals.filter((p) => p.kind === "task");
  assert.equal(leads.length, 3);
  assert.equal(tasks.length, 2);
  assert.ok(r.proposals.every((p) => p.approved === false));

  const jordan = leads.find((p) => p.summary.startsWith("Jordan Sample"))!;
  assert.equal(jordan.crm, "new");
  assert.match(jordan.summary, /3-bed townhouse to buy/);
  assert.match(jordan.summary, /Maraval/, "the later message about Jordan was merged in");
  assert.equal(jordan.write?.table, "crm_tasks", "no email, so a follow-up task, not a contact row");
  assert.equal(jordan.write?.table === "crm_tasks" && jordan.write.row.assignee_agent_id, 3, "the agent who posted it");

  const chris = leads.find((p) => p.summary.startsWith("Chris Placeholder"))!;
  assert.equal(chris.write?.table, "contact_submissions");
  assert.equal(chris.write?.table === "contact_submissions" && chris.write.row.phone, "+18685550199", "the unsaved sender's number");

  const pat = leads.find((p) => p.crm === "duplicate")!;
  assert.deepEqual(pat.match, { how: "phone", table: "crm_clients", id: "c-1" });
  assert.equal(pat.write, null, "already in the CRM: nothing to create");

  const call = tasks.find((p) => /please call/.test(p.summary))!;
  assert.equal(call.write?.table === "crm_tasks" && call.write.row.assignee_agent_id, 3, "@mentioned agent");
  assert.equal(call.write?.table === "crm_tasks" && call.write.row.due_date, "2026-10-29");
  const viewing = tasks.find((p) => /viewing/.test(p.summary))!;
  assert.equal(viewing.write?.table === "crm_tasks" && viewing.write.row.assignee_agent_id, 9, "nobody named: the default agent");
});

test("a second run over the same export proposes nothing new", () => {
  const first = readExport("chat.txt", fixture("sample-export.txt"), { crm, agents, defaultAgentId: 9 });
  const again = readExport("chat.txt", fixture("sample-export.txt"), { crm, agents, defaultAgentId: 9, seen: new Set(first.proposals.map((p) => p.id)) });
  assert.equal(again.proposals.length, 0);
});

test("without a default agent, unassigned tasks say why they can't be written", () => {
  const r = readExport("chat.txt", fixture("sample-export.txt"), { crm: null, agents: [], defaultAgentId: null });
  assert.ok(r.proposals.filter((p) => p.write?.table === "crm_tasks").every((p) => p.blockers.length > 0));
});

test("reads a .zip export (iPhone's _chat.txt)", () => {
  const zip = writeZip([
    { name: "_chat.txt", data: fixture("sample-export.txt") },
    { name: "00000012-PHOTO-2026-10-28.jpg", data: Buffer.from("not really a photo") },
  ]);
  assert.equal(chatTextFromZip(zip), fixture("sample-export.txt").toString("utf8"));
  const r = readExport("WhatsApp Chat - 1on1 Leads.zip", zip, { crm, agents, defaultAgentId: 9 });
  assert.equal(r.chat, "1on1 Leads");
  assert.equal(r.proposals.filter((p) => p.kind === "lead").length, 3);
});
