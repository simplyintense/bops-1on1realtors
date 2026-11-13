import { LeadFlow, type FlowSnapshot } from "./flow.ts";
import type { MarketSearch } from "./market-search.ts";
import { DryRunOutbox, type OutboxMessage } from "./outbox.ts";
import type { Lead } from "./engine.ts";
import type { DailyReport } from "./report.ts";
import type { CrmSource } from "./source.ts";

/**
 * The demo's simulated day (Thu 12 Nov 2026, Port of Spain time) against a CRM source, normally the
 * fixture (fixtures/crm.json, made-up people). Shared by the CLI (`npm run realty:demo`) and the web
 * demo page (app/realty-demo). Nothing is sent: every message only goes to the dry-run outbox.
 */

export type DemoStep = { at: Date; text: string; leads: Lead[] };

export type DemoDayOptions = {
  crm: CrmSource;
  timeoutMs: number;
  market: MarketSearch | null;
  /** Gets each outbox message as one JSONL line (the CLI appends it to a file); omitted, it stays in memory (the web page). */
  outboxAppend?: (line: string) => void;
  print?: (line: string) => void;
  persist?: (snapshot: FlowSnapshot) => void;
  /** Called as each step of the story happens, after the flow has acted on it. */
  onStep?: (step: DemoStep) => void;
  /** Called as each step starts, before the flow acts on it (the CLI prints the narration first). */
  onStepStart?: (at: Date, text: string) => void;
};

export type DemoDay = { steps: DemoStep[]; messages: OutboxMessage[]; report: DailyReport };

// Port of Spain is UTC-4 all year.
export const demoAt = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00-04:00`);

export const DEMO_ADMIN = { name: "Admin (fixture)", address: "admin.fixture@example.com" };

export async function runDemoDay(o: DemoDayOptions): Promise<DemoDay> {
  let now = demoAt("09:00");
  const clock = () => now;
  const outbox = new DryRunOutbox({ clock, append: o.outboxAppend, print: o.print });
  const flow = new LeadFlow({ crm: o.crm, clock, outbox, market: o.market, timeoutMs: o.timeoutMs, admin: DEMO_ADMIN, persist: o.persist });
  const steps: DemoStep[] = [];

  const inquiries = await o.crm.inquiries();
  const [sam, pat, lee] = ["web-0412", "web-0413", "wa-0007"].map((ref) => {
    const found = inquiries.find((i) => i.ref === ref);
    if (!found) throw new Error(`fixture is missing inquiry ${ref}`);
    return found;
  });
  const agentName = async (id: number) => (await o.crm.agents()).find((a) => a.id === id)?.name ?? `agent ${id}`;

  const step = async (hhmm: string, text: string, act: () => Promise<Lead[]>) => {
    now = demoAt(hhmm);
    o.onStepStart?.(now, text);
    // Copies: the engine keeps changing its leads, and a step shows them as they were then.
    const leads = (await act()).map((l) => structuredClone(l));
    const s = { at: now, text, leads };
    steps.push(s);
    o.onStep?.(s);
  };

  let samId = "";
  await step("09:00", "Sam Fixture sends a property inquiry about L-101 (web-0412).", async () => {
    const l = await flow.receive(sam);
    samId = l.id;
    return [l];
  });
  await step("09:15", `${await agentName(1)} hasn't answered. The window closes.`, async () => {
    await flow.tick();
    return [flow.engine.lead(samId)];
  });
  await step("09:18", `${await agentName(2)} accepts ${samId}.`, async () => {
    await flow.respond(samId, 2, "accept");
    return [flow.engine.lead(samId)];
  });
  await step("09:20", "Pat Fixture sends a contact-form message about a villa in Scarborough, Tobago (web-0413).", async () => [await flow.receive(pat)]);
  let leeId = "";
  await step("09:21", "Lee Fixture sends a WhatsApp message about a 3-bed house in Arima (wa-0007).", async () => {
    const l = await flow.receive(lee);
    leeId = l.id;
    return [l];
  });
  await step("09:24", `${await agentName(3)} accepts ${leeId}.`, async () => {
    await flow.respond(leeId, 3, "accept");
    return [flow.engine.lead(leeId)];
  });
  let report: DailyReport | null = null;
  await step("18:00", "End of day: the daily report goes to admin.", async () => {
    report = await flow.sendDailyReport();
    return [];
  });

  return { steps, messages: outbox.messages, report: report! };
}
