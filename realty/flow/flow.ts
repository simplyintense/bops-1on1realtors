import { agentsTried, LeadEngine, type Clock, type EngineSnapshot, type Inquiry, type Lead } from "./engine.ts";
import { hasCriteria, marketCriteria, matchOurListings } from "./match.ts";
import type { CoBrokeHit, MarketSearch } from "./market-search.ts";
import { adminException, agentAlert, clientAck, localClock } from "./messages.ts";
import type { DryRunOutbox } from "./outbox.ts";
import { dailyReport, reportText, type DailyReport } from "./report.ts";
import { chooseAgent, inquiryProblem, openLoad } from "./route.ts";
import type { CrmSource, FlowAgent, Listing } from "./source.ts";

/**
 * The lead flow: the engine (engine.ts) plus the things around it. It takes an inquiry, acknowledges
 * the client at once, routes it, alerts the agent with listing matches, and moves it on when an agent
 * times out or passes. Every message goes through the dry-run outbox. Nothing here waits for admin.
 *
 *   receive(inquiry)       → ack client → route → alert the agent (or admin exception if unroutable)
 *   tick()                 → offers past their deadline: backup agent, or admin exception if the backup missed too
 *   respond(id, agent, …)  → accept (done) or pass (straight to the backup)
 *   sendDailyReport()      → one report to admin
 */

export type FlowOptions = {
  crm: CrmSource;
  clock: Clock;
  outbox: DryRunOutbox;
  /** Null when ONEON1_MARKET_SEARCH_* aren't set. */
  market: MarketSearch | null;
  timeoutMs: number;
  admin: { name: string; address: string };
  /** Called after every change with the whole state (the CLI writes it to a JSON file). */
  persist?: (snapshot: EngineSnapshot) => void;
  snapshot?: EngineSnapshot;
};

/** ONEON1_LEAD_TIMEOUT_MINUTES, default 15, between 1 and 240. */
export function timeoutMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const m = Number(env.ONEON1_LEAD_TIMEOUT_MINUTES);
  return (Number.isFinite(m) && m > 0 ? Math.min(240, m) : 15) * 60_000;
}

export class LeadFlow {
  readonly engine: LeadEngine;
  private readonly o: FlowOptions;

  constructor(o: FlowOptions) {
    this.o = o;
    this.engine = new LeadEngine({ timeoutMs: o.timeoutMs, clock: o.clock }, o.snapshot);
  }

  async receive(inq: Inquiry): Promise<Lead> {
    const [agents, listings] = await Promise.all([this.o.crm.agents(), this.o.crm.listings()]);
    const lead = this.engine.receive(inq);

    const problem = inquiryProblem(inq, listings);
    if (problem) return this.except(lead.id, `bad data: ${problem}`);

    // Instant acknowledgement: the client hears from us before anything else is decided.
    this.engine.acknowledge(lead.id);
    this.o.outbox.record(clientAck(inq, this.listingFor(inq, listings)));

    const choice = chooseAgent(inq, agents, listings, (id) => openLoad(this.engine, id), []);
    if (!choice.agent) return this.except(lead.id, choice.reason);

    await this.offer(lead.id, choice.agent, choice.reason, null);
    this.save();
    return this.engine.lead(lead.id);
  }

  /** Applies timeouts. Returns how many offers ran out. */
  async tick(): Promise<number> {
    const expired = this.engine.expire();
    for (const { lead } of expired) await this.missed(lead.id);
    this.save();
    return expired.length;
  }

  /** An agent's answer. Accept is final; pass goes straight to the backup (or admin, if it was the backup). */
  async respond(leadId: string, agentId: number, response: "accept" | "pass"): Promise<Lead> {
    const lead = this.engine.respond(leadId, agentId, response);
    if (response === "pass") await this.missed(leadId);
    this.save();
    return this.engine.lead(lead.id);
  }

  async sendDailyReport(): Promise<DailyReport> {
    const agents = await this.o.crm.agents();
    const report = dailyReport(this.engine.all(), agents, this.engine.now);
    this.o.outbox.record({
      kind: "daily_report",
      channel: "email",
      to: this.o.admin,
      leadId: null,
      subject: `Lead flow daily report, ${localClock(report.at)}`,
      text: reportText(report),
    });
    return report;
  }

  /** The offer is closed without an acceptance: give it to the backup, or to admin if the backup already had it. */
  private async missed(leadId: string) {
    const lead = this.engine.lead(leadId);
    if (lead.state !== "assigned") return this.except(leadId, `${await this.describeAttempts(lead)}`);

    const agents = await this.o.crm.agents();
    const listings = await this.o.crm.listings();
    const choice = chooseAgent(lead.inquiry, agents, listings, (id) => openLoad(this.engine, id), agentsTried(lead));
    const primary = agents.find((a) => a.id === lead.attempts.at(-1)?.agentId) ?? null;
    if (choice.agent) return this.offer(leadId, choice.agent, choice.reason, primary);
    return this.except(leadId, `${await this.describeAttempts(lead)}; ${choice.reason}`);
  }

  private async offer(leadId: string, agent: FlowAgent, reason: string, backupOf: FlowAgent | null) {
    const attempt = backupOf ? this.engine.escalate(leadId, agent.id) : this.engine.assign(leadId, agent.id);
    const listings = await this.o.crm.listings();
    const lead = this.engine.lead(leadId);
    const { hits, note } = await this.coBroke(lead.inquiry);
    this.o.outbox.record(
      agentAlert({
        lead,
        agent,
        reason,
        listing: this.listingFor(lead.inquiry, listings),
        ours: matchOurListings(lead.inquiry, listings),
        coBroke: hits,
        coBrokeNote: note,
        backupOf,
        answerBy: localClock(attempt.deadline),
      }),
    );
  }

  private async coBroke(inq: Inquiry): Promise<{ hits: CoBrokeHit[]; note: string }> {
    if (!hasCriteria(inq)) return { hits: [], note: "nothing to search on" };
    if (!this.o.market) return { hits: [], note: "market search is off" };
    return this.o.market.search(marketCriteria(inq));
  }

  private async except(leadId: string, reason: string): Promise<Lead> {
    const lead = this.engine.raise(leadId, reason);
    this.o.outbox.record(adminException(lead, await this.attemptLines(lead), this.engine.now.toISOString(), this.o.admin));
    this.save();
    return lead;
  }

  private listingFor(inq: Inquiry, listings: Listing[]): Listing | null {
    return inq.listingId ? (listings.find((l) => l.id === inq.listingId) ?? null) : null;
  }

  /** Each offer as a name and what happened to it, for admin's exception note. */
  private async attemptLines(lead: Lead): Promise<string[]> {
    const agents = await this.o.crm.agents();
    return lead.attempts.map((a) => `${agents.find((x) => x.id === a.agentId)?.name ?? `agent ${a.agentId}`} (${a.response ?? "no answer yet"})`);
  }

  private async describeAttempts(lead: Lead): Promise<string> {
    const agents = await this.o.crm.agents();
    const words: Record<string, string> = { timeout: "didn't respond in time", pass: "passed", accept: "accepted" };
    return lead.attempts
      .map((a) => `${agents.find((x) => x.id === a.agentId)?.name ?? `agent ${a.agentId}`} ${words[a.response ?? ""] ?? "has no answer yet"}`)
      .join(", ");
  }

  private save() {
    this.o.persist?.(this.engine.snapshot());
  }
}
