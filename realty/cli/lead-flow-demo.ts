import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { timeoutMsFromEnv } from "../flow/flow.ts";
import { marketConfigFromEnv, MarketSearch } from "../flow/market-search.ts";
import { localClock, localTime } from "../flow/messages.ts";
import { runDemoDay } from "../flow/demo-day.ts";
import { jsonlAppender, loadFixtureCrm } from "../node/jsonl.ts";

/**
 * The lead flow on a simulated day, against the fixture CRM. Nothing is sent: every message goes to
 * .data/realty/outbox.jsonl and to the terminal. Resets the demo's outbox and state files first.
 * The day itself is realty/flow/demo-day.ts (the web demo page, app/realty-demo, runs the same one).
 *
 *   npm run realty:demo
 */

const dir = process.env.ONEON1_REALTY_OUT_FLOW?.trim() || ".data/realty";
const outboxFile = join(dir, "outbox.jsonl");
const stateFile = join(dir, "lead-flow-state.json");
mkdirSync(dir, { recursive: true, mode: 0o700 });
rmSync(outboxFile, { force: true });
rmSync(stateFile, { force: true });

const timeoutMs = timeoutMsFromEnv();
const marketCfg = marketConfigFromEnv();
const market = marketCfg ? new MarketSearch(marketCfg) : null;

console.log("1on1 Realtors lead flow · DEMO · DRY RUN: nothing is sent");
console.log(`Simulated day: Thu 12 Nov 2026, Port of Spain time. Answer window: ${timeoutMs / 60_000} min per agent, then one backup.`);
console.log(`Market search: ${market ? "on" : "off (set ONEON1_MARKET_SEARCH_URL and _TOKEN to turn it on)"}.`);
console.log(`Every message is written to ${outboxFile} and printed below.`);

const day = await runDemoDay({
  crm: loadFixtureCrm(),
  timeoutMs,
  market,
  outboxAppend: jsonlAppender(outboxFile),
  print: (line) => console.log(line),
  persist: (snap) => writeFileSync(stateFile, JSON.stringify(snap, null, 2), { mode: 0o600 }),
  onStepStart: (at, text) => console.log(`\n${localClock(at.toISOString())}  ${text}`),
  onStep: (s) => {
    for (const l of s.leads) console.log(`        ${l.id}: ${l.state}${l.exception ? ` (${l.exception})` : ""}`);
  },
});

const { report } = day;
console.log("\n──────────────────────────────────────────────────────────────");
console.log("DRY RUN summary");
console.log(`  ${day.messages.length} messages recorded, none sent. Outbox: ${outboxFile}`);
console.log(`  Leads: ${report.totals.leads} · accepted ${report.totals.accepted} · admin exceptions ${report.totals.exceptions} · still open ${report.totals.open}`);
console.log(`  Report time: ${localTime(report.at)}`);
