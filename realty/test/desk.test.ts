import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deskView, flowDesk } from "../flow/desk.ts";
import type { Inquiry, Lead } from "../flow/engine.ts";
import { runtimeEnv } from "../flow/env.ts";
import { LeadFlow } from "../flow/flow.ts";
import { PLACEHOLDER_BUSINESS_HOURS } from "../flow/hours.ts";
import { DryRunOutbox } from "../flow/outbox.ts";
import { missingDocs, reportText, weeklyReport } from "../flow/report.ts";
import type { Listing } from "../flow/source.ts";
import { loadFixtureCrm } from "../node/jsonl.ts";

/**
 * The reports' new sections (tally, management-only, missing docs, weekly window), deskView (the JSON a
 * Lovable UI reads) and the portability of the lead-flow core (no node:, next or bare process).
 */

const MIN = 60_000;
const DAY = 86_400_000;
const START = Date.parse("2026-11-12T13:00:00Z"); // Thu 09:00 Port of Spain

function world(start = START) {
  let now = start;
  const clock = () => new Date(now);
  const outbox = new DryRunOutbox({ clock });
  const flow = new LeadFlow({
    crm: loadFixtureCrm(),
    clock,
    outbox,
    market: null,
    timeoutMs: 15 * MIN,
    hours: PLACEHOLDER_BUSINESS_HOURS,
    admin: { name: "Admin", address: "admin@example.com" },
  });
  return { flow, outbox, advance: (m: number) => (now += m * MIN), set: (t: number) => (now = t) };
}

const inq = (over: Partial<Inquiry> = {}): Inquiry => ({
  ref: "t-1",
  source: "property_inquiry",
  name: "Sam Fixture",
  phone: "+1 868 555 0201",
  email: "sam.fixture@example.com",
  listingId: "L-101",
  listingType: "rent",
  area: "Woodbrook",
  budget: { max: 9000, currency: "TTD" },
  beds: 2,
  message: "Is it still available?",
  ...over,
});

/** A day with: Sam (rent, website, assigned with a pending approval), Lee (sale, WhatsApp, routed), a complaint (management-only), and an unroutable Tobago sale. */
async function busyDay() {
  const w = world();
  const sam = await w.flow.receive(inq());
  w.advance(1);
  const lee = await w.flow.receive(inq({ ref: "wa-1", source: "whatsapp", name: "Lee Fixture", listingId: null, listingType: "sale", area: "Arima", budget: { max: 1500000, currency: "TTD" }, beds: 3, email: null, phone: "+1 868 555 0203" }));
  w.advance(1);
  const mgmt = await w.flow.receive(inq({ ref: "web-c", name: "Cam Fixture", message: "I want to complain about the agent", channel: "facebook" }));
  w.advance(1);
  const tobago = await w.flow.receive(inq({ ref: "web-t", name: "Toby Fixture", listingId: null, listingType: "sale", area: "Scarborough, Tobago", budget: null, beds: 4 }));
  return { w, sam, lee, mgmt, tobago };
}

// ── Reports ───────────────────────────────────────────────────────────────────────────────────────

test("daily report: tally by kind and channel, management-only leads and listings missing client info", async () => {
  const { w, mgmt } = await busyDay();
  const r = await w.flow.sendDailyReport();
  assert.deepEqual(r.tally.kind, { rental: 2, residential_sale: 2, land: 0, commercial: 0, unknown: 0 });
  assert.deepEqual(r.tally.channel, { whatsapp: 1, facebook: 1, instagram: 0, website: 2, phone: 0, referral: 0, unknown: 0 });
  assert.deepEqual(r.managementOnly.map((m) => [m.leadId, m.flags]), [[mgmt.id, ["complaints"]]]);
  // The fixture's listings have no address, amenities, furnishing, viewing or photos: every active one is flagged.
  const l101 = r.missingDocs.find((m) => m.listingId === "L-101")!;
  assert.ok(l101.fields.includes("viewing_arrangements") && l101.fields.includes("photos"));
  assert.ok(!r.missingDocs.some((m) => m.listingId === "L-111"), "sold listings aren't audited");

  const text = w.outbox.messages.at(-1)!.text;
  assert.match(text, /^Lead flow daily report/);
  assert.match(text, /Enquiries by kind: Rental 2 · Residential sale 2/);
  assert.match(text, /Enquiries by channel: WhatsApp 1 · Facebook 1 · Website 2/);
  assert.match(text, /Management-only, for a person, never auto-acted \(1\)\n {2}L\d+ · Cam Fixture: complaints/);
  assert.match(text, /Listings missing client info \(\d+\)\n {2}L-101 · Two-bedroom apartment, Woodbrook: .*viewing_arrangements/);
  assert.equal(reportText(r), text);
});

test("missingDocs: a listing with every client field filled in isn't listed", () => {
  const full: Listing = {
    id: "L-X", title: "Complete", listingType: "rent", area: "Woodbrook", price: 9000, currency: "TTD", beds: 2, baths: 1, agentId: 1,
    status: "active", url: "", address: "1 Fixture St", amenities: ["parking"], furnishing: "furnished", viewingArrangements: "call agent", photoCount: 4,
  };
  assert.deepEqual(missingDocs([full]), []);
  assert.deepEqual(missingDocs([{ ...full, photoCount: 0, furnishing: null }]), [{ listingId: "L-X", title: "Complete", agentId: 1, fields: ["furnishing", "photos"] }]);
});

test("weekly report: only leads received in the 7 days before now, and it goes to admin as weekly_report", async () => {
  const w = world(START - 8 * DAY); // Wed 4 Nov: outside the window
  await w.flow.receive(inq({ ref: "old", name: "Old Fixture" }));
  w.set(START - 6 * DAY); // Fri 6 Nov: inside
  await w.flow.receive(inq({ ref: "mid", name: "Mid Fixture", source: "whatsapp", listingId: null }));
  w.set(START);
  await w.flow.receive(inq({ ref: "new", name: "New Fixture" }));

  const r = await w.flow.sendWeeklyReport();
  assert.equal(r.totals.leads, 2);
  assert.deepEqual(r.period, { from: new Date(START - 7 * DAY).toISOString(), to: new Date(START).toISOString() });
  assert.equal(r.tally.channel.whatsapp, 1);
  assert.equal(r.tally.channel.website, 1);
  const m = w.outbox.messages.at(-1)!;
  assert.equal(m.kind, "weekly_report");
  assert.equal(m.channel, "email");
  assert.equal(m.dryRun, true);
  assert.match(m.text, /^Lead flow weekly report · Thu 5 Nov, 09:00 to Thu 12 Nov, 09:00/);
  assert.match(m.text, /Totals: 2 leads/);

  // (at - 7 days, at]: a lead received exactly at the report time is in; one exactly 7 days before is out.
  const all = w.flow.engine.all();
  assert.equal(weeklyReport(all, [], new Date(START - 1)).totals.leads, 1, "the new one isn't in yet");
  assert.equal(weeklyReport(all, [], new Date(START + DAY - 1)).totals.leads, 2);
  assert.equal(weeklyReport(all, [], new Date(START + DAY)).totals.leads, 1, "Mid falls out exactly 7 days on");
});

// ── deskView ──────────────────────────────────────────────────────────────────────────────────────

test("deskView: queue, pending approval, missing fields, tally, management-only and the dry-run outbox, all plain JSON", async () => {
  const { w, sam, lee, mgmt, tobago } = await busyDay();
  w.advance(20); // Sam's and Lee's offers are past their deadline; tick() hasn't run
  const v = await flowDesk(w.flow);

  assert.deepEqual(JSON.parse(JSON.stringify(v)), v, "round-trips through JSON unchanged");
  assert.equal(v.dryRun, true);
  assert.equal(v.ackSender, "1 On 1 Realty");
  assert.equal(v.hours.placeholder, true);
  assert.equal(v.slaMinutes, 15);

  assert.deepEqual(v.queue.open.map((l) => l.leadId), [sam.id, lee.id]);
  assert.deepEqual(v.queue.exceptions.map((l) => l.leadId), [mgmt.id, tobago.id]);
  assert.deepEqual(v.queue.overdue.map((l) => l.leadId), [sam.id, lee.id]);
  assert.deepEqual(v.queue.escalations, []);
  const s = v.queue.open[0];
  assert.deepEqual([s.state, s.agent?.name, s.channel, s.kind, s.attempts], ["assigned", "Ava Sample", "website", "rental", 1]);
  assert.equal(s.deadline, new Date(START + 15 * MIN).toISOString());
  assert.deepEqual(v.queue.exceptions[0].managementFlags, ["complaints"]);

  assert.equal(v.approvals.length, 2, "Sam's (L-103) and Lee's (L-109) matches wait for approval");
  const a = v.approvals.find((x) => x.leadId === sam.id)!;
  assert.deepEqual([a.agentName, a.client, a.candidates.map((c) => c.id)], ["Ava Sample", "Sam Fixture", ["ours:L-103"]]);
  assert.equal(s.pendingApprovalId, a.id);

  assert.ok(v.missingFields.some((m) => m.listingId === "L-101" && m.fields.includes("photos")));
  assert.equal(v.summary.tally.kind.rental, 2);
  assert.equal(v.summary.daily.totals.leads, 4);
  assert.equal(v.summary.weekly.totals.leads, 4);
  assert.deepEqual(v.managementOnly.map((m) => m.leadId), [mgmt.id]);

  assert.equal(v.outbox.length, w.outbox.messages.length);
  assert.ok(v.outbox.every((m) => m.dryRun === true));
  assert.deepEqual(v.outbox.find((m) => m.kind === "client_ack")?.from, { name: "1 On 1 Realty" });
  // No transport state anywhere: nothing on the desk says a message was sent, delivered or queued to send.
  assert.doesNotMatch(JSON.stringify(v), /"(sent|sentAt|delivered|transport|providerId|messageSid)"\s*:/);
});

test("deskView is pure: same input, same output, and it doesn't change the leads it's given", async () => {
  const { w } = await busyDay();
  const snap = w.flow.snapshot();
  const crm = loadFixtureCrm();
  const input = {
    now: "2026-11-12T14:00:00.000Z",
    hours: PLACEHOLDER_BUSINESS_HOURS,
    ackSender: "1 On 1 Realty",
    leads: snap.leads,
    approvals: snap.approvals ?? [],
    listings: await crm.listings(),
    agents: await crm.agents(),
    outbox: w.flow.messages,
    log: snap.log,
  };
  const before = structuredClone(snap.leads) as Lead[];
  assert.deepEqual(deskView(input), deskView(input));
  assert.deepEqual(snap.leads, before);
  assert.equal(deskView(input).generatedAt, "2026-11-12T14:00:00.000Z");
});

// ── Portability ───────────────────────────────────────────────────────────────────────────────────

const CORE = [
  "flow/engine.ts", "flow/flow.ts", "flow/hours.ts", "flow/listing-audit.ts", "flow/live-crm.ts", "flow/management.ts",
  "flow/areas.ts", "flow/area-learning.ts", "flow/market-search.ts", "flow/market-desk.ts", "flow/match.ts", "flow/messages.ts", "flow/outbox.ts", "flow/report.ts", "flow/route.ts",
  "flow/source.ts", "flow/taxonomy.ts", "flow/desk.ts", "flow/env.ts", "flow/demo-day.ts", "flow/periskope.ts", "crm.ts",
  "flow/requests.ts", "flow/recommendations.ts", "flow/market-stats.ts",
  // Imported (for values) by the core:
  "extract.ts", "dedupe.ts", "agents.ts",
];

test("the lead-flow core imports nothing from node:, next or the Node-only helpers, and never names `process`", () => {
  const root = new URL("..", import.meta.url).pathname;
  for (const f of CORE) {
    const src = readFileSync(join(root, f), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const imports = [...code.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)].map((m) => ({ typeOnly: !!m[1], spec: m[2] }));
    for (const i of imports) {
      assert.ok(!i.spec.startsWith("node:") && !/^(fs|path|os|crypto)$/.test(i.spec), `${f} imports ${i.spec}`);
      assert.ok(!/^next(\/|$)/.test(i.spec), `${f} imports ${i.spec}`);
      assert.ok(!i.spec.includes("/node/"), `${f} imports the Node-only ${i.spec}`);
      if (!i.typeOnly) assert.ok(i.spec.startsWith("."), `${f} imports a package: ${i.spec}`);
    }
    assert.doesNotMatch(code, /\bprocess\s*\./, `${f} uses process`);
  }
  // Every module in realty/flow is either in the list or deliberately left out.
  const flowFiles = readdirSync(join(root, "flow")).filter((f) => f.endsWith(".ts"));
  for (const f of flowFiles) assert.ok(CORE.includes(`flow/${f}`), `realty/flow/${f} isn't checked for portability`);
});

test("runtimeEnv reads globalThis.process.env when there is one, and is {} without it", () => {
  assert.equal(runtimeEnv(), process.env);
  const g = globalThis as { process?: unknown };
  const real = g.process;
  try {
    Object.defineProperty(globalThis, "process", { value: undefined, configurable: true, writable: true });
    assert.deepEqual(runtimeEnv(), {});
  } finally {
    Object.defineProperty(globalThis, "process", { value: real, configurable: true, writable: true });
  }
});
