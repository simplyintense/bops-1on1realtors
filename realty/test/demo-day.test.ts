import assert from "node:assert/strict";
import { test } from "node:test";
import { runDemoDay } from "../flow/demo-day.ts";
import { FixtureCrm } from "../flow/source.ts";

/** The demo's simulated day (realty/flow/demo-day.ts), as the web demo page runs it: in memory, nothing sent. */

test("the demo day: each step shows its leads as they were then, every message is a dry run", async () => {
  const day = await runDemoDay({ crm: FixtureCrm.load(), timeoutMs: 15 * 60_000, market: null });
  assert.deepEqual(
    day.steps.map((s) => s.leads.map((l) => `${l.id}:${l.state}`).join(",")),
    ["L001:assigned", "L001:escalated", "L001:accepted", "L002:exception", "L003:assigned", "L003:accepted", ""],
  );
  assert.equal(day.messages.length, 8);
  assert.ok(day.messages.every((m) => m.dryRun === true));
  assert.deepEqual(day.report.totals, { leads: 3, accepted: 2, exceptions: 1, open: 0 });
});
