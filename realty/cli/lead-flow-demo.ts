import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FixtureCrm } from "../flow/source.ts";
import { LeadFlow, timeoutMsFromEnv } from "../flow/flow.ts";
import { marketConfigFromEnv, MarketSearch } from "../flow/market-search.ts";
import { DryRunOutbox } from "../flow/outbox.ts";
import { localClock, localTime } from "../flow/messages.ts";
import type { Lead } from "../flow/engine.ts";

/**
 * The lead flow on a simulated day, against the fixture CRM. Nothing is sent: every message goes to
 * .data/realty/outbox.jsonl and to the terminal. Resets the demo's outbox and state files first.
 *
 *   npm run realty:demo
 */

const dir = process.env.ONEON1_REALTY_OUT_FLOW?.trim() || ".data/realty";
const outboxFile = join(dir, "outbox.jsonl");
const stateFile = join(dir, "lead-flow-state.json");
mkdirSync(dir, { recursive: true, mode: 0o700 });
rmSync(outboxFile, { force: true });
rmSync(stateFile, { force: true });

// Port of Spain is UTC-4 all year.
const at = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00-04:00`);
let now = at("09:00");
const clock = () => now;

const timeoutMs = timeoutMsFromEnv();
const marketCfg = marketConfigFromEnv();
const market = marketCfg ? new MarketSearch(marketCfg) : null;
const crm = FixtureCrm.load();
const outbox = new DryRunOutbox({ clock, file: outboxFile, print: (line) => console.log(line) });
const flow = new LeadFlow({
  crm,
  clock,
  outbox,
  market,
  timeoutMs,
  admin: { name: "Admin (fixture)", address: "admin.fixture@example.com" },
  persist: (snap) => writeFileSync(stateFile, JSON.stringify(snap, null, 2), { mode: 0o600 }),
});

const say = (hhmm: string, text: string) => {
  now = at(hhmm);
  console.log(`\n${localClock(now.toISOString())}  ${text}`);
};

const inquiries = await crm.inquiries();
const [sam, pat, lee] = ["web-0412", "web-0413", "wa-0007"].map((ref) => {
  const found = inquiries.find((i) => i.ref === ref);
  if (!found) throw new Error(`fixture is missing inquiry ${ref}`);
  return found;
});

const agentName = async (id: number) => (await crm.agents()).find((a) => a.id === id)?.name ?? `agent ${id}`;
const log = (l: Lead) => console.log(`        ${l.id}: ${l.state}${l.exception ? ` (${l.exception})` : ""}`);

console.log("1on1 Realtors lead flow · DEMO · DRY RUN: nothing is sent");
console.log(`Simulated day: Thu 12 Nov 2026, Port of Spain time. Answer window: ${timeoutMs / 60_000} min per agent, then one backup.`);
console.log(`Market search: ${market ? "on" : "off (set ONEON1_MARKET_SEARCH_URL and _TOKEN to turn it on)"}.`);
console.log(`Every message is written to ${outboxFile} and printed below.`);

say("09:00", "Sam Fixture sends a property inquiry about L-101 (web-0412).");
const samLead = await flow.receive(sam);
log(samLead);
const samId = samLead.id;

say("09:15", `${await agentName(1)} hasn't answered. The window closes.`);
await flow.tick();
log(flow.engine.lead(samId));

say("09:18", `${await agentName(2)} accepts ${samId}.`);
await flow.respond(samId, 2, "accept");
log(flow.engine.lead(samId));

say("09:20", "Pat Fixture sends a contact-form message about a villa in Scarborough, Tobago (web-0413).");
const patLead = await flow.receive(pat);
log(patLead);

say("09:21", "Lee Fixture sends a WhatsApp message about a 3-bed house in Arima (wa-0007).");
const leeLead = await flow.receive(lee);
log(leeLead);

say("09:24", `${await agentName(3)} accepts ${leeLead.id}.`);
await flow.respond(leeLead.id, 3, "accept");
log(flow.engine.lead(leeLead.id));

say("18:00", "End of day: the daily report goes to admin.");
const report = await flow.sendDailyReport();

console.log("\n──────────────────────────────────────────────────────────────");
console.log("DRY RUN summary");
console.log(`  ${outbox.messages.length} messages recorded, none sent. Outbox: ${outboxFile}`);
console.log(`  Leads: ${report.totals.leads} · accepted ${report.totals.accepted} · admin exceptions ${report.totals.exceptions} · still open ${report.totals.open}`);
console.log(`  Report time: ${localTime(report.at)}`);
