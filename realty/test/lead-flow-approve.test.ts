import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowError, type Inquiry } from "../flow/engine.ts";
import { LeadFlow } from "../flow/flow.ts";
import { PLACEHOLDER_BUSINESS_HOURS } from "../flow/hours.ts";
import { ackSenderFromEnv, DEFAULT_ACK_SENDER } from "../flow/messages.ts";
import { DryRunOutbox, type OutboxMessage } from "../flow/outbox.ts";
import { loadFixtureCrm } from "../node/jsonl.ts";

/**
 * Unit 4: client messages come from the brand, listing matches wait for an agent's approval (and even
 * then are only a dry-run client_match), and management-only messages are never acted on. Fake clock,
 * fixture CRM, in-memory outbox; fetch throws, so any network call fails the test.
 */

const MIN = 60_000;
const START = Date.parse("2026-11-12T13:00:00Z"); // Thu 09:00 Port of Spain
const AGENT_NAMES = ["Ava Sample", "Bram Demo", "Cora Example", "Dev Placeholder", "Eli Mockfield"];

function world(opts: { ackSender?: string; env?: Record<string, string | undefined> } = {}) {
  let now = START;
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
    ackSender: opts.ackSender ?? (opts.env ? ackSenderFromEnv(opts.env) : undefined),
  });
  return { flow, outbox, advance: (m: number) => (now += m * MIN) };
}

/** A Woodbrook rent inquiry about L-101 (fixture: Ava and Bram cover Woodbrook; L-103 also fits). */
const woodbrook = (over: Partial<Inquiry> = {}): Inquiry => ({
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

const ofKind = (msgs: OutboxMessage[], kind: OutboxMessage["kind"]) => msgs.filter((m) => m.kind === kind);

function offline() {
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("no network in tests");
  }) as typeof fetch;
  return () => void (globalThis.fetch = real);
}

// ── Ack sender ────────────────────────────────────────────────────────────────────────────────────

test("client_ack comes from \"1 On 1 Realty\" by default: from.name and the text, never an agent", async () => {
  const w = world();
  await w.flow.receive(woodbrook());
  const [ack] = ofKind(w.outbox.messages, "client_ack");
  assert.equal(DEFAULT_ACK_SENDER, "1 On 1 Realty");
  assert.deepEqual(ack.from, { name: "1 On 1 Realty" });
  assert.match(ack.text, /thanks for getting in touch with 1 On 1 Realty/);
  for (const n of AGENT_NAMES) {
    assert.ok(!ack.text.includes(n) && !ack.text.includes(n.split(" ")[0]), `ack mentions agent ${n}`);
    assert.notEqual(ack.from?.name, n);
  }
});

test("a custom ackSender, or ONEON1_ACK_SENDER_NAME, replaces the brand name", async () => {
  const custom = world({ ackSender: "1on1 Realtors Ltd" });
  await custom.flow.receive(woodbrook());
  const [a] = ofKind(custom.outbox.messages, "client_ack");
  assert.deepEqual(a.from, { name: "1on1 Realtors Ltd" });
  assert.match(a.text, /in touch with 1on1 Realtors Ltd about/);

  const fromEnv = world({ env: { ONEON1_ACK_SENDER_NAME: "  One On One Realty TT  " } });
  await fromEnv.flow.receive(woodbrook());
  assert.deepEqual(ofKind(fromEnv.outbox.messages, "client_ack")[0].from, { name: "One On One Realty TT" });

  assert.equal(ackSenderFromEnv({}), "1 On 1 Realty");
  assert.equal(ackSenderFromEnv({ ONEON1_ACK_SENDER_NAME: "   " }), "1 On 1 Realty", "blank falls back to the brand");
});

// ── Match approval ────────────────────────────────────────────────────────────────────────────────

test("matches wait for approval: the agent alert lists them, the client gets nothing until approve", async () => {
  const restore = offline();
  try {
    const w = world();
    const lead = await w.flow.receive(woodbrook());
    const [alert] = ofKind(w.outbox.messages, "agent_alert");
    assert.match(alert.text, /Our listings that fit:\n {2}- Two-bedroom flat, Woodbrook .*\(L-103\)/);
    assert.equal(ofKind(w.outbox.messages, "client_match").length, 0, "no client_match before approval");

    const pending = w.flow.pendingApprovals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].leadId, lead.id);
    assert.equal(pending[0].agentId, 1);
    assert.equal(pending[0].status, "pending");
    assert.ok(pending[0].candidates.length >= 1);
    assert.ok(pending[0].candidates.every((c) => c.kind === "ours" && c.id.startsWith("ours:")));
    assert.ok(pending[0].candidates.some((c) => c.id === "ours:L-103"));
  } finally {
    restore();
  }
});

test("approveMatches records one dry-run client_match from \"1 On 1 Realty\", and only that", async () => {
  const w = world();
  await w.flow.receive(woodbrook());
  const [a] = w.flow.pendingApprovals();
  const before = w.outbox.messages.length;
  const done = w.flow.approveMatches(a.id, ["ours:L-103"]);

  assert.equal(done.status, "approved");
  assert.deepEqual(done.selectedIds, ["ours:L-103"]);
  assert.equal(w.outbox.messages.length, before + 1, "exactly one new message");
  const [m] = ofKind(w.outbox.messages, "client_match");
  assert.equal(m.dryRun, true);
  assert.deepEqual(m.from, { name: "1 On 1 Realty" });
  assert.equal(m.to.name, "Sam Fixture");
  assert.match(m.text, /it's 1 On 1 Realty again/);
  assert.match(m.text, /Two-bedroom flat, Woodbrook/);
  for (const n of AGENT_NAMES) assert.ok(!m.text.includes(n), `client_match mentions agent ${n}`);
  assert.equal(w.flow.pendingApprovals().length, 0);
});

test("rejectMatches writes nothing; an empty selection is a reject", async () => {
  const w = world();
  await w.flow.receive(woodbrook());
  const [a] = w.flow.pendingApprovals();
  const before = w.outbox.messages.length;
  assert.equal(w.flow.rejectMatches(a.id).status, "rejected");
  assert.equal(w.outbox.messages.length, before);

  const w2 = world();
  await w2.flow.receive(woodbrook());
  const [b] = w2.flow.pendingApprovals();
  const before2 = w2.outbox.messages.length;
  const r = w2.flow.approveMatches(b.id, []);
  assert.equal(r.status, "rejected");
  assert.deepEqual(r.selectedIds, []);
  assert.equal(w2.outbox.messages.length, before2);
  assert.equal(ofKind(w2.outbox.messages, "client_match").length, 0);
});

test("approval is decided once: double-approve, approve after reject, unknown ids and the wrong agent throw FlowError", async () => {
  const w = world();
  await w.flow.receive(woodbrook());
  const [a] = w.flow.pendingApprovals();
  assert.throws(() => w.flow.approveMatches(a.id, ["ours:L-999"]), FlowError);
  assert.throws(() => w.flow.approveMatches(a.id, ["ours:L-103"], { actorAgentId: 2 }), FlowError);
  w.flow.approveMatches(a.id, ["ours:L-103"], { actorAgentId: 1 });
  assert.throws(() => w.flow.approveMatches(a.id, ["ours:L-103"]), FlowError);
  assert.throws(() => w.flow.rejectMatches(a.id), FlowError);
  assert.throws(() => w.flow.approveMatches("MA404", []), FlowError);
  assert.equal(ofKind(w.outbox.messages, "client_match").length, 1);
});

test("a pending approval follows the lead to the backup agent", async () => {
  const w = world();
  await w.flow.receive(woodbrook());
  w.advance(15);
  await w.flow.tick();
  const [a] = w.flow.pendingApprovals();
  assert.equal(a.agentId, 2, "Bram has the lead now, so the approval is his");
  assert.throws(() => w.flow.approveMatches(a.id, ["ours:L-103"], { actorAgentId: 1 }), FlowError);
});

// ── Management-only ───────────────────────────────────────────────────────────────────────────────

test("management-only: a complaint is an admin exception and nothing else (no ack, no alert)", async () => {
  const w = world();
  const lead = await w.flow.receive(woodbrook({ message: "I want to complain about the agent" }));
  assert.equal(lead.state, "exception");
  assert.ok(lead.exception?.startsWith("management-only:"), lead.exception ?? "");
  assert.match(lead.exception!, /complaints/);
  assert.equal(lead.ackAt, null);
  assert.equal(lead.attempts.length, 0);
  assert.deepEqual(w.outbox.messages.map((m) => m.kind), ["admin_exception"]);
  assert.equal(w.flow.pendingApprovals().length, 0);
});
