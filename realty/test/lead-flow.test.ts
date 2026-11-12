import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FlowError, type Inquiry } from "../flow/engine.ts";
import { LeadFlow, timeoutMsFromEnv } from "../flow/flow.ts";
import { marketConfigFromEnv, type MarketSearch } from "../flow/market-search.ts";
import { DryRunOutbox, type OutboxMessage } from "../flow/outbox.ts";
import { dailyReport, median, reportText } from "../flow/report.ts";
import { FixtureCrm } from "../flow/source.ts";

/**
 * The lead flow end to end on a fake clock, against the fixture CRM, with an in-memory outbox. The
 * fetch global is replaced with one that throws, so any real network call fails the test.
 */

const MIN = 60_000;
const START = Date.parse("2026-11-12T13:00:00Z"); // 09:00 Port of Spain

function world(opts: { market?: MarketSearch | null; file?: string } = {}) {
  let now = START;
  const clock = () => new Date(now);
  const outbox = new DryRunOutbox({ clock, file: opts.file });
  const flow = new LeadFlow({
    crm: FixtureCrm.load(),
    clock,
    outbox,
    market: opts.market ?? null,
    timeoutMs: 15 * MIN,
    admin: { name: "Admin", address: "admin@example.com" },
  });
  return {
    flow,
    outbox,
    at: (minutesFromStart: number) => {
      now = START + minutesFromStart * MIN;
    },
    advance: (minutes: number) => {
      now += minutes * MIN;
    },
    get now() {
      return now;
    },
  };
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

const kinds = (msgs: OutboxMessage[]) => msgs.map((m) => `${m.kind}:${m.to.name}`);
const offline = () => {
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("no network in tests");
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
};

test("the client is acknowledged at the moment the inquiry comes in, before anyone is alerted", async () => {
  const w = world();
  const lead = await w.flow.receive(inq());
  const [ack, alert] = w.outbox.messages;
  assert.equal(ack.kind, "client_ack");
  assert.equal(ack.channel, "whatsapp");
  assert.equal(ack.to.address, "+18685550201");
  assert.equal(ack.at, new Date(w.now).toISOString(), "the ack is stamped at the time of receipt, not later");
  assert.equal(alert.kind, "agent_alert");
  assert.equal(alert.to.name, "Ava Sample", "the listing's agent gets the alert");
  assert.equal(lead.state, "assigned");
  assert.equal(lead.acceptedBy, null);
});

test("an agent who doesn't answer in time is escalated to one backup, who gets the lead", async () => {
  const w = world();
  const lead = await w.flow.receive(inq());
  w.advance(14);
  assert.equal(await w.flow.tick(), 0, "still inside the window");
  assert.equal(w.flow.engine.lead(lead.id).state, "assigned");

  w.advance(1);
  assert.equal(await w.flow.tick(), 1);
  const after = w.flow.engine.lead(lead.id);
  assert.equal(after.state, "escalated");
  assert.equal(after.attempts[0].response, "timeout");
  assert.equal(after.attempts[1].agentId, 2, "Bram covers Woodbrook rent, so he's the backup");
  assert.equal(w.outbox.messages.at(-1)?.kind, "backup_alert");
  assert.equal(w.outbox.messages.at(-1)?.to.name, "Bram Demo");
});

test("if the backup also times out, it becomes one admin exception, and nobody else is offered it", async () => {
  const w = world();
  const lead = await w.flow.receive(inq());
  w.advance(15);
  await w.flow.tick();
  w.advance(15);
  assert.equal(await w.flow.tick(), 1);
  const after = w.flow.engine.lead(lead.id);
  assert.equal(after.state, "exception");
  assert.equal(after.attempts.length, 2, "two offers at most");
  assert.match(after.exception ?? "", /Ava Sample didn't respond in time, Bram Demo didn't respond in time/);
  assert.equal(w.outbox.messages.at(-1)?.kind, "admin_exception");
  assert.equal(w.outbox.messages.at(-1)?.to.address, "admin@example.com");
});

test("an accept stops the clock: no escalation, however long after", async () => {
  const w = world();
  const lead = await w.flow.receive(inq());
  w.advance(5);
  await w.flow.respond(lead.id, 1, "accept");
  w.advance(60);
  assert.equal(await w.flow.tick(), 0);
  assert.equal(w.flow.engine.lead(lead.id).state, "accepted");
  assert.equal(w.outbox.messages.some((m) => m.kind === "backup_alert"), false, "nobody else was alerted");
});

test("a pass goes to the backup straight away, without waiting for the timeout", async () => {
  const w = world();
  const lead = await w.flow.receive(inq());
  w.advance(2);
  await w.flow.respond(lead.id, 1, "pass");
  const after = w.flow.engine.lead(lead.id);
  assert.equal(after.state, "escalated");
  assert.equal(after.attempts[0].response, "pass");
  assert.equal(w.outbox.messages.at(-1)?.kind, "backup_alert");
});

test("a late or stray answer is refused, so the lead can't be taken back after the backup has it", async () => {
  const w = world();
  const lead = await w.flow.receive(inq());
  w.advance(15);
  await w.flow.tick();
  await assert.rejects(() => w.flow.respond(lead.id, 1, "accept"), FlowError, "Ava's window closed");
  await assert.rejects(() => w.flow.respond(lead.id, 3, "accept"), FlowError, "Cora was never offered it");
  await w.flow.respond(lead.id, 2, "accept");
  assert.equal(w.flow.engine.lead(lead.id).acceptedBy, 2);
});

test("an inquiry nobody covers is an admin exception at once, with no agent alert", async () => {
  const w = world();
  const lead = await w.flow.receive(inq({ listingId: null, listingType: "sale", area: "Scarborough, Tobago", budget: null, beds: 4, email: null }));
  assert.equal(lead.state, "exception");
  assert.deepEqual(kinds(w.outbox.messages), ["client_ack:Sam Fixture", "admin_exception:Admin"]);
});

test("bad data is an admin exception and the client is not messaged (there's no way to reach them)", async () => {
  const w = world();
  const lead = await w.flow.receive(inq({ phone: null, email: null, listingId: null }));
  assert.equal(lead.state, "exception");
  assert.equal(lead.exception, "bad data: no phone or email to reach the client");
  assert.deepEqual(kinds(w.outbox.messages), ["admin_exception:Admin"]);
});

test("responsiveness: accepted and timed out counts, and the median time to a first answer", async () => {
  const w = world();
  // Lead 1: Ava doesn't answer, Bram accepts 3 minutes after being offered it.
  const one = await w.flow.receive(inq());
  w.advance(15);
  await w.flow.tick();
  w.advance(3);
  await w.flow.respond(one.id, 2, "accept");
  // Lead 2 (Lee, Arima sale): Cora accepts 6 minutes in.
  w.advance(10);
  const two = await w.flow.receive(inq({ ref: "wa-1", source: "whatsapp", name: "Lee Fixture", listingId: null, listingType: "sale", area: "Arima", budget: { max: 1500000, currency: "TTD" }, beds: 3, email: null, phone: "+1 868 555 0203" }));
  w.advance(6);
  await w.flow.respond(two.id, 3, "accept");

  const agents = await FixtureCrm.load().agents();
  const r = dailyReport(w.flow.engine.all(), agents, new Date(w.now));
  const row = (id: number) => r.agents.find((a) => a.agentId === id)!;
  assert.deepEqual([row(1).received, row(1).timedOut, row(1).accepted], [1, 1, 0]);
  assert.deepEqual([row(2).received, row(2).accepted, row(2).medianReplyMinutes], [1, 1, 3]);
  assert.deepEqual([row(3).received, row(3).accepted, row(3).medianReplyMinutes], [1, 1, 6]);
  assert.equal(row(1).medianReplyMinutes, null, "Ava never answered, so there's no reply time for her");
  assert.equal(r.totals.accepted, 2);
});

test("the daily report lists exceptions and open leads, and goes to admin as one dry-run message", async () => {
  const w = world();
  await w.flow.receive(inq({ listingId: null, listingType: "sale", area: "Scarborough, Tobago", budget: null, beds: 4 }));
  const open = await w.flow.receive(inq({ ref: "web-9", name: "Open Fixture", phone: "+1 868 555 0209", email: null }));
  w.advance(9 * 60);
  const r = await w.flow.sendDailyReport();
  assert.equal(r.exceptions.length, 1);
  assert.match(r.exceptions[0].reason, /covers sale in Scarborough/);
  assert.deepEqual(r.open.map((o) => [o.leadId, o.owner]), [[open.id, "Ava Sample"]]);
  const sent = w.outbox.messages.at(-1)!;
  assert.equal(sent.kind, "daily_report");
  assert.equal(sent.channel, "email");
  assert.match(sent.text, /Ava Sample\s+1\s+0\s+0\s+0\s+–/);
  assert.match(sent.text, /Exceptions for admin \(1\)/);
  assert.match(sent.text, /Still open \(1\)/);
  assert.equal(reportText(r), sent.text);
});

test("median: odd and even counts, nothing to take the median of", () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("the timeout comes from ONEON1_LEAD_TIMEOUT_MINUTES, default 15", () => {
  assert.equal(timeoutMsFromEnv({}), 15 * MIN);
  assert.equal(timeoutMsFromEnv({ ONEON1_LEAD_TIMEOUT_MINUTES: "20" }), 20 * MIN);
  assert.equal(timeoutMsFromEnv({ ONEON1_LEAD_TIMEOUT_MINUTES: "nope" }), 15 * MIN);
  assert.equal(timeoutMsFromEnv({ ONEON1_LEAD_TIMEOUT_MINUTES: "9999" }), 240 * MIN);
});

test("market search is skipped when its settings aren't set: no request, and the alert says so", async () => {
  assert.equal(marketConfigFromEnv({}), null);
  assert.equal(marketConfigFromEnv({ ONEON1_MARKET_SEARCH_URL: "http://127.0.0.1:8787/mcp" }), null, "the URL alone isn't enough");
  assert.equal(marketConfigFromEnv({ ONEON1_MARKET_SEARCH_TOKEN: "x" }), null, "the token alone isn't enough");

  const restore = offline();
  try {
    const w = world();
    await w.flow.receive(inq());
    const alert = w.outbox.messages.find((m) => m.kind === "agent_alert")!;
    assert.match(alert.text, /market search is off/);
  } finally {
    restore();
  }
});

test("the outbox only writes: every message is a dry run, it lands in the JSONL file, and no network is touched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lead-flow-"));
  const file = join(dir, "outbox.jsonl");
  const restore = offline();
  try {
    const w = world({ file });
    await w.flow.receive(inq());
    w.advance(15);
    await w.flow.tick();
    w.advance(3);
    await w.flow.respond(w.flow.engine.all()[0].id, 2, "accept");
    await w.flow.receive(inq({ ref: "x", listingId: null, listingType: "sale", area: "Scarborough, Tobago", budget: null, beds: 4 }));
    await w.flow.sendDailyReport();

    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as OutboxMessage);
    assert.equal(lines.length, w.outbox.messages.length);
    // ack, Ava's alert, Bram's backup alert, ack, admin exception, daily report
    assert.equal(lines.length, 6);
    for (const m of lines) {
      assert.equal(m.dryRun, true);
      assert.ok(["whatsapp", "email", "sms"].includes(m.channel));
    }
    assert.deepEqual(kinds(lines).slice(0, 2), ["client_ack:Sam Fixture", "agent_alert:Ava Sample"]);
  } finally {
    restore();
  }
});
