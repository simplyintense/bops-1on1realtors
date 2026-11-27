import assert from "node:assert/strict";
import { test } from "node:test";
import { agentAssignmentCounts, agentIdOf, applyOwnerAgentFilter, parseOwnerAgentFilter, recountBands, scopeAutomatchPairs } from "../flow/automatch-scope.ts";

/** Invented pairs for the helpers: only the fields scoping reads. */
const PAIR = (band: "strong" | "fair", agentId: number | null, agentName: string | null = null) => ({ band, listing: { agentId, agentName } });

const DANA = PAIR("strong", 7, "Dana Holder");
const DANA_FAIR = PAIR("fair", 7, "Dana Holder");
const EVE = PAIR("strong", 8, "Eve Other");
const EVE_FAIR = PAIR("fair", 8, "Eve Other");
const OFFICE = PAIR("fair", null);
const OFFICE_STRONG = PAIR("strong", null);

test("owner counts: each assigned agent by name with strong, fair and total; Unassigned last, and only when it has pairs", () => {
  const pairs = [EVE, DANA, OFFICE, DANA_FAIR, EVE_FAIR, DANA];
  assert.deepEqual(agentAssignmentCounts(pairs), [
    { agentId: 7, name: "Dana Holder", strong: 2, fair: 1, total: 3 },
    { agentId: 8, name: "Eve Other", strong: 1, fair: 1, total: 2 },
    { agentId: null, name: "Unassigned", strong: 0, fair: 1, total: 1 },
  ]);
  assert.deepEqual(
    agentAssignmentCounts([DANA, EVE]).map((c) => c.agentId),
    [7, 8],
    "no unassigned pairs, so no Unassigned row",
  );
  assert.deepEqual(agentAssignmentCounts([]), [], "no pairs, no rows");
});

test("owner counts sort assigned agents by name, case-insensitively, whatever order the pairs come in", () => {
  const pairs = [PAIR("strong", 3, "zara"), PAIR("strong", 1, "Adam"), PAIR("fair", 2, "bella"), PAIR("strong", 4, "Carl")];
  assert.deepEqual(
    agentAssignmentCounts(pairs).map((c) => c.name),
    ["Adam", "bella", "Carl", "zara"],
  );
});

test("owner counts fall back to 'agent #id' for an agent the CRM didn't name, and count an unassigned strong pair", () => {
  const rows = agentAssignmentCounts([PAIR("strong", 9, null), OFFICE_STRONG]);
  assert.deepEqual(rows, [
    { agentId: 9, name: "agent #9", strong: 1, fair: 0, total: 1 },
    { agentId: null, name: "Unassigned", strong: 1, fair: 0, total: 1 },
  ]);
});

test("the agent filter from the query: an owner's id or 'unassigned' parse; anything else, or no value, shows everything", () => {
  assert.equal(parseOwnerAgentFilter(true, "7"), 7);
  assert.equal(parseOwnerAgentFilter(true, " 12 "), 12, "spaces around the id don't matter");
  assert.equal(parseOwnerAgentFilter(true, "unassigned"), "unassigned");
  for (const bad of ["0", "-3", "7.5", "7abc", "Eve", "", "   ", "1e3", "99999999999999999999", undefined, null]) {
    assert.equal(parseOwnerAgentFilter(true, bad), null, `owner: ${JSON.stringify(bad)} shows everything`);
  }
});

test("a non-owner's agent filter is always null, so a query can't widen or move an agent's view", () => {
  for (const raw of ["7", "8", "unassigned", "0", "Eve", undefined, null]) {
    assert.equal(parseOwnerAgentFilter(false, raw), null, `non-owner: ${JSON.stringify(raw)} is ignored`);
  }
});

test("the owner's filter keeps one agent's pairs, the unassigned ones, or everything", () => {
  const pairs = [DANA, EVE, OFFICE, DANA_FAIR];
  assert.deepEqual(applyOwnerAgentFilter(pairs, 7), [DANA, DANA_FAIR]);
  assert.deepEqual(applyOwnerAgentFilter(pairs, "unassigned"), [OFFICE]);
  assert.deepEqual(applyOwnerAgentFilter(pairs, 99), [], "an agent with no pairs gives none");
  assert.deepEqual(applyOwnerAgentFilter(pairs, null), pairs);
});

test("an agent's pairs are the listings they hold: canSeeLead's rule, nothing unassigned, nothing of another agent's", () => {
  const pairs = [DANA, EVE, OFFICE, DANA_FAIR, OFFICE_STRONG];
  assert.deepEqual(scopeAutomatchPairs(pairs, { owner: false, agentId: 7 }), [DANA, DANA_FAIR]);
  assert.deepEqual(scopeAutomatchPairs(pairs, { owner: false, agentId: null }), [], "a signed-in person with no CRM agent sees none");
  assert.deepEqual(scopeAutomatchPairs(pairs, { owner: true, agentId: null }), pairs, "an owner sees all, unassigned included");
  assert.deepEqual(scopeAutomatchPairs(pairs, { owner: true, agentId: 7 }), pairs, "an owner who is also an agent still sees all");
});

test("the strong and fair counts are recounted from the pairs given, as they stand", () => {
  assert.deepEqual(recountBands([DANA, DANA_FAIR, EVE_FAIR, OFFICE]), { strong: 1, fair: 3 });
  assert.deepEqual(recountBands([]), { strong: 0, fair: 0 });
});

test("agentIdOf: the email, trimmed and lower-cased on both sides, gives the CRM id; a name never does", () => {
  const agents = [
    { id: 7, name: "Dana Holder", email: "dana@1on1.example" },
    { id: 8, name: "Eve Other", email: "EVE@1on1.example" },
    { id: 9, name: "Dana Holder", email: null },
  ];
  assert.equal(agentIdOf("Dana@1on1.example", agents), 7);
  assert.equal(agentIdOf("  DANA@1ON1.EXAMPLE ", agents), 7, "the sign-in's case and spaces don't matter");
  assert.equal(agentIdOf("eve@1on1.example", agents), 8, "a mixed-case CRM email matches a lower-case sign-in");
  assert.equal(agentIdOf("Dana Holder", agents), null, "a display name is not an email");
  assert.equal(agentIdOf("nobody@1on1.example", agents), null);
  assert.equal(agentIdOf("", agents), null);
  assert.equal(agentIdOf(null, agents), null);
  assert.equal(agentIdOf(undefined, agents), null);
});
