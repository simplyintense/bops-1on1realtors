import { agentsTried, FlowError, LeadEngine, type Attempt, type Clock, type EngineSnapshot, type Inquiry, type Lead } from "./engine.ts";
import { businessHoursFromEnv, type BusinessHours } from "./hours.ts";
import { CachedAreaResolver, ExactAreaFallback, type AreaResolver, type MatchTier } from "./areas.ts";
import { pairFor, type AreaLearning, type AreaPair, type LearnSignal } from "./area-learning.ts";
import { hasCriteria, marketCriteria, rankCoBroke, rankOurListings, type Ranked } from "./match.ts";
import type { CoBrokeHit, MarketSearch } from "./market-search.ts";
import { managementFlags } from "./management.ts";
import { ackSenderFromEnv, adminException, agentAlert, clientAck, clientMatch, localClock, localTime } from "./messages.ts";
import type { Outbox, OutboxMessage } from "./outbox.ts";
import { dailyReport, MANAGEMENT_ONLY_PREFIX, reportText, weeklyReport, type DailyReport, type WeeklyReport } from "./report.ts";
import { chooseAgent, inquiryProblem, openLoad } from "./route.ts";
import type { CrmSource, FlowAgent, Listing } from "./source.ts";
import { runtimeEnv } from "./env.ts";

/**
 * The lead flow: the engine (engine.ts) plus the things around it. It takes an inquiry, acknowledges
 * the client at once, routes it, alerts the agent with listing matches, and moves it on when an agent
 * times out or passes. Every message goes through the dry-run outbox. Nothing here waits for admin.
 *
 * Matches never reach the client on their own: the agent's alert lists them (internal), and they wait
 * in the approval queue until an agent approves; even then only a dry-run client_match is recorded.
 * A management-only message (management.ts) is never acted on: no ack, no routing, only admin.
 *
 *   receive(inquiry)       → management-only? admin exception and stop
 *                            → ack client → route → alert the agent (or admin exception if unroutable)
 *                            → match candidates queued for the agent's approval
 *   approveMatches(id, …)  → dry-run client_match for the chosen candidates; rejectMatches(id) → nothing
 *                            either way, each candidate's area pair is recorded (area-learning.ts), never bulk
 *   tick()                 → offers past their deadline: backup agent, or admin exception if the backup missed too
 *   respond(id, agent, …)  → accept (done) or pass (straight to the backup)
 *   reassign(id, agent)    → admin hands an exception (or a closed offer) to an agent who hasn't had it
 *   sendDailyReport()      → one report to admin (every lead held)
 *   sendWeeklyReport()     → one report to admin (leads received in the last 7 days)
 */

export type FlowOptions = {
  crm: CrmSource;
  clock: Clock;
  /** Normally a DryRunOutbox. Every message goes here and nowhere else. */
  outbox: Outbox;
  /** Null when ONEON1_MARKET_SEARCH_* aren't set. */
  market: MarketSearch | null;
  timeoutMs: number;
  /** Deadlines count business time in these hours. Unset: businessHoursFromEnv() (the PLACEHOLDER unless env is set). */
  hours?: BusinessHours;
  admin: { name: string; address: string };
  /** Who client messages come from. Unset: ackSenderFromEnv() ("1 On 1 Realty" unless ONEON1_ACK_SENDER_NAME is set). */
  ackSender?: string;
  /** Called after every change with the whole state (the CLI writes it to a JSON file). */
  persist?: (snapshot: FlowSnapshot) => void;
  /** An engine snapshot from before the approval queue (no `approvals`) still loads. */
  snapshot?: FlowSnapshot;
  /**
   * Called by tick() after the timeouts are handled and before the state is saved, with the same clock
   * time. The host wires the Periskope purge here (realty/node/periskope-intake.ts); it may call forgetLeads().
   */
  onTick?: (now: Date) => void | Promise<void>;
  /** How areas are matched. Unset: exact text (ExactAreaFallback), which is today's behaviour. Wrapped in a per-flow cache. */
  areas?: AreaResolver;
  /** Where the approve/reject records go, and how they're sent to market-mcp. Unset: nothing is recorded. */
  areaLearning?: AreaLearning;
};

/** A listing the agent may send the client: ours from the CRM, or another agency's (co-broke). tier and reason say why it's here (internal). */
export type MatchCandidate = (
  | { id: string; kind: "ours"; listing: Listing }
  | { id: string; kind: "cobroke"; hit: CoBrokeHit }
) & { tier: MatchTier; reason: string };

export type MatchApproval = {
  id: string;
  leadId: string;
  /** The agent who holds the lead's offer; follows the lead to a backup or reassigned agent while pending. */
  agentId: number;
  candidates: MatchCandidate[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt?: string;
  selectedIds?: string[];
};

export type FlowSnapshot = EngineSnapshot & { approvals?: MatchApproval[] };

/** The snapshot without these leads, their log lines and their match approvals. For a host that keeps the snapshot in a file. */
export function forgetLeadsIn(snapshot: FlowSnapshot, leadIds: string[]): FlowSnapshot {
  const engine = new LeadEngine({ timeoutMs: 0, clock: () => new Date(0) }, snapshot);
  engine.forget(leadIds);
  const gone = new Set(leadIds);
  return { ...engine.snapshot(), approvals: (snapshot.approvals ?? []).filter((a) => !gone.has(a.leadId)) };
}

/** ONEON1_LEAD_TIMEOUT_MINUTES, default 15, between 1 and 240. */
export function timeoutMsFromEnv(env: Record<string, string | undefined> = runtimeEnv()): number {
  const m = Number(env.ONEON1_LEAD_TIMEOUT_MINUTES);
  return (Number.isFinite(m) && m > 0 ? Math.min(240, m) : 15) * 60_000;
}

export class LeadFlow {
  readonly engine: LeadEngine;
  private readonly o: FlowOptions;
  private readonly sender: string;
  private readonly approvals: MatchApproval[];
  private readonly hours: BusinessHours;
  private readonly areas: AreaResolver;
  private readonly learning: AreaLearning | null;
  private readonly learnSends: Promise<void>[] = [];

  constructor(o: FlowOptions) {
    this.o = o;
    this.sender = o.ackSender?.trim() || ackSenderFromEnv();
    this.approvals = structuredClone(o.snapshot?.approvals ?? []);
    // Snapshots from before tiers: their candidates are exact-text matches, tagged as such.
    for (const a of this.approvals) {
      for (const c of a.candidates) {
        if (!(c as Partial<MatchCandidate>).tier) Object.assign(c, { tier: "any", reason: "no area recorded (before tiers)" });
      }
    }
    this.hours = o.hours ?? businessHoursFromEnv();
    this.areas = new CachedAreaResolver(o.areas ?? new ExactAreaFallback());
    this.learning = o.areaLearning ?? null;
    this.engine = new LeadEngine({ timeoutMs: o.timeoutMs, clock: o.clock, hours: this.hours }, o.snapshot);
  }

  /** The CRM source the flow reads (read-only). */
  get crm(): CrmSource {
    return this.o.crm;
  }

  /** The area resolver the flow matches with (cached). The desk uses it for its unmapped-areas list. */
  get areaResolver(): AreaResolver {
    return this.areas;
  }

  /** Every area pair recorded so far (empty without an area learning store). */
  areaPairs(): AreaPair[] {
    return this.learning?.store.pairs() ?? [];
  }

  /** Resolves once every learn_area_neighbour send started so far has finished (or failed). Nothing else waits on it. */
  async learningSent(): Promise<void> {
    await Promise.all(this.learnSends.splice(0));
  }

  /** Every dry-run message recorded so far (a copy). */
  get messages(): OutboxMessage[] {
    return structuredClone(this.o.outbox.messages);
  }

  async receive(inq: Inquiry): Promise<Lead> {
    const [agents, listings] = await Promise.all([this.o.crm.agents(), this.o.crm.listings()]);
    const lead = this.engine.receive(inq);

    // Management-only (complaints, commissions, contract changes...): a person handles it. No ack, no routing, no matches.
    const flags = managementFlags(inq.message ?? "");
    if (flags.length) return this.except(lead.id, `${MANAGEMENT_ONLY_PREFIX} ${flags.join(", ")}`);

    const problem = inquiryProblem(inq, listings);
    if (problem) return this.except(lead.id, `bad data: ${problem}`);

    // Instant acknowledgement: the client hears from us (the brand, not an agent) before anything else is decided.
    this.engine.acknowledge(lead.id);
    this.o.outbox.record(clientAck(inq, this.listingFor(inq, listings), this.sender));

    const choice = chooseAgent(inq, agents, listings, (id) => openLoad(this.engine, id), []);
    if (!choice.agent) return this.except(lead.id, choice.reason);

    await this.offer(lead.id, choice.agent, choice.reason, null);
    this.save();
    return this.engine.lead(lead.id);
  }

  /** Applies timeouts, then onTick (if given), then saves. Returns how many offers ran out. */
  async tick(): Promise<number> {
    const expired = this.engine.expire();
    for (const { lead } of expired) await this.missed(lead.id);
    await this.o.onTick?.(this.engine.now);
    this.save();
    return expired.length;
  }

  /** Removes leads, their log lines and their match approvals (a purge or an opt-out). Saves. */
  forgetLeads(leadIds: string[]): void {
    const gone = new Set(leadIds);
    this.engine.forget(leadIds);
    for (let i = this.approvals.length - 1; i >= 0; i--) if (gone.has(this.approvals[i].leadId)) this.approvals.splice(i, 1);
    this.save();
  }

  /** An agent's answer. Accept is final; pass goes straight to the backup (or admin, if it was the backup). */
  async respond(leadId: string, agentId: number, response: "accept" | "pass"): Promise<Lead> {
    const lead = this.engine.respond(leadId, agentId, response);
    if (response === "pass") await this.missed(leadId);
    this.save();
    return this.engine.lead(lead.id);
  }

  /**
   * Admin hands a lead to a specific agent: an exception, or an outstanding lead whose offer has closed.
   * Refused (FlowError) while an offer is still open (unless the lead is in exception), for an agent who
   * already had it, and for an agent not in the CRM. The agent's alert goes to the dry-run outbox only;
   * nothing is sent and nothing is written to the CRM.
   */
  async reassign(leadId: string, agentId: number): Promise<Lead> {
    const agents = await this.o.crm.agents();
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) throw new FlowError(`agent ${agentId} isn't in the CRM`);
    const before = this.engine.lead(leadId);
    const lastClosed = before.attempts.at(-1);
    const previous = lastClosed ? (agents.find((a) => a.id === lastClosed.agentId) ?? null) : null;
    const attempt = this.engine.reassign(leadId, agentId);
    await this.alert(leadId, agent, "admin reassigned it to you", previous, attempt);
    this.save();
    return this.engine.lead(leadId);
  }

  /** Match candidates waiting for an agent's decision, oldest first. */
  pendingApprovals(): MatchApproval[] {
    return this.approvals.filter((a) => a.status === "pending").map((a) => structuredClone(a));
  }

  approval(id: string): MatchApproval {
    const a = this.approvals.find((x) => x.id === id);
    if (!a) throw new FlowError(`no match approval ${id}`);
    return structuredClone(a);
  }

  /**
   * The agent approves some of the candidates for the client. Records one dry-run client_match from the
   * brand (never the agent) and nothing else; there is no transport. An empty selection is a reject.
   * Refused (FlowError) if already decided, for an id that isn't a candidate, or (with actorAgentId) for
   * an agent other than the one the approval is with.
   */
  approveMatches(approvalId: string, selectedIds: string[], opts: { actorAgentId?: number } = {}): MatchApproval {
    const a = this.pending(approvalId, opts.actorAgentId);
    const picks = [...new Set(selectedIds)].map((id) => {
      const c = a.candidates.find((x) => x.id === id);
      if (!c) throw new FlowError(`${id} isn't a candidate in ${approvalId}`);
      return c;
    });
    if (!picks.length) return this.rejectMatches(approvalId, opts);

    this.o.outbox.record(clientMatch(this.engine.lead(a.leadId), picks.map((c) => (c.kind === "ours" ? { listing: c.listing } : { hit: c.hit })), this.sender));
    this.decide(a, "approved", picks.map((c) => c.id));
    // Only the picks are approved. The candidates left out are not rejected: nobody decided about them.
    this.learn(a, picks, "approved");
    return structuredClone(a);
  }

  /** Nothing goes to the client. Every candidate's area pair is recorded as rejected. */
  rejectMatches(approvalId: string, opts: { actorAgentId?: number } = {}): MatchApproval {
    const a = this.pending(approvalId, opts.actorAgentId);
    this.decide(a, "rejected", []);
    this.learn(a, a.candidates, "rejected");
    return structuredClone(a);
  }

  async sendDailyReport(): Promise<DailyReport> {
    const [agents, listings] = await Promise.all([this.o.crm.agents(), this.o.crm.listings()]);
    const report = dailyReport(this.engine.all(), agents, this.engine.now, listings);
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

  async sendWeeklyReport(): Promise<WeeklyReport> {
    const [agents, listings] = await Promise.all([this.o.crm.agents(), this.o.crm.listings()]);
    const report = weeklyReport(this.engine.all(), agents, this.engine.now, listings);
    this.o.outbox.record({
      kind: "weekly_report",
      channel: "email",
      to: this.o.admin,
      leadId: null,
      subject: `Lead flow weekly report, to ${localTime(report.period.to)}`,
      text: reportText(report),
    });
    return report;
  }

  /** What the flow holds, for deskView (desk.ts) or a host's own persistence. Copies, safe to serialise. */
  snapshot(): FlowSnapshot {
    return { ...this.engine.snapshot(), approvals: structuredClone(this.approvals) };
  }

  /** The business hours and client-message sender this flow runs with. */
  get settings(): { hours: BusinessHours; ackSender: string; timeoutMs: number } {
    return { hours: this.hours, ackSender: this.sender, timeoutMs: this.engine.timeoutMs };
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
    await this.alert(leadId, agent, reason, backupOf, attempt);
  }

  private async alert(leadId: string, agent: FlowAgent, reason: string, backupOf: FlowAgent | null, attempt: Attempt) {
    const listings = await this.o.crm.listings();
    const lead = this.engine.lead(leadId);
    const { hits, note } = await this.coBroke(lead.inquiry);
    const ours = await rankOurListings(lead.inquiry, listings, this.areas);
    // Other agencies' hits are ranked here too: the search server's area filter isn't a geography check.
    const coBroke = await rankCoBroke(lead.inquiry, hits, this.areas);
    // If the ranking dropped some hits, the note says how many fit.
    const coBrokeNote = hits.length && coBroke.length !== hits.length ? `${coBroke.length} of ${hits.length} from other agencies fit` : note;
    // Internal: the agent sees the matches and why each is here. Nothing about them goes to the client from here.
    this.o.outbox.record(
      agentAlert({
        lead,
        agent,
        reason,
        listing: this.listingFor(lead.inquiry, listings),
        ours: ours.map((r) => ({ listing: r.item, reason: r.reason })),
        coBroke: coBroke.map((r) => ({ hit: r.item, reason: r.reason })),
        coBrokeNote,
        backupOf,
        answerBy: this.answerBy(attempt),
      }),
    );
    this.queueMatches(leadId, agent.id, ours, coBroke);
  }

  /**
   * One pending approval per lead. A new offer (backup, reassign) hands it to that agent with fresh
   * candidates; once decided, the lead isn't queued again. No candidates, nothing queued.
   */
  private queueMatches(leadId: string, agentId: number, ours: Ranked<Listing>[], hits: Ranked<CoBrokeHit>[]) {
    const candidates: MatchCandidate[] = [
      ...ours.map((r): MatchCandidate => ({ id: `ours:${r.item.id}`, kind: "ours", listing: r.item, tier: r.tier, reason: r.reason })),
      ...hits.map((r, i): MatchCandidate => ({ id: `cobroke:${i + 1}`, kind: "cobroke", hit: r.item, tier: r.tier, reason: r.reason })),
    ];
    const existing = this.approvals.find((a) => a.leadId === leadId);
    if (existing && existing.status !== "pending") return;
    if (existing) {
      if (!candidates.length) return;
      existing.agentId = agentId;
      existing.candidates = candidates;
      return;
    }
    if (!candidates.length) return;
    this.approvals.push({ id: `MA${this.approvals.length + 1}`, leadId, agentId, candidates, status: "pending", createdAt: this.engine.now.toISOString() });
  }

  private pending(approvalId: string, actorAgentId: number | undefined): MatchApproval {
    const a = this.approvals.find((x) => x.id === approvalId);
    if (!a) throw new FlowError(`no match approval ${approvalId}`);
    if (a.status !== "pending") throw new FlowError(`match approval ${approvalId} is already ${a.status}`);
    if (actorAgentId !== undefined && actorAgentId !== a.agentId) throw new FlowError(`match approval ${approvalId} is with agent ${a.agentId}, not ${actorAgentId}`);
    return a;
  }

  private decide(a: MatchApproval, status: "approved" | "rejected", selectedIds: string[]) {
    a.status = status;
    a.decidedAt = this.engine.now.toISOString();
    a.selectedIds = selectedIds;
    this.save();
  }

  /**
   * One explicit decision, recorded per candidate: the pair of areas, the tier, the signal. Local write first;
   * then, if there's a sender, learn_area_neighbour in the background (never throws into the approve path).
   */
  private learn(a: MatchApproval, candidates: MatchCandidate[], signal: LearnSignal) {
    if (!this.learning) return;
    const inquiryArea = this.engine.lead(a.leadId).inquiry.area;
    const at = this.engine.now.toISOString();
    for (const c of candidates) {
      const listingArea = c.kind === "ours" ? c.listing.area : c.hit.area;
      const pair = pairFor(inquiryArea, listingArea, c.tier, signal, at);
      if (!pair) continue;
      this.learning.store.add(pair);
      if (this.learning.send) this.learnSends.push(this.learning.send(pair).catch(() => undefined));
    }
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

  /** "09:15" when the deadline is today; "Fri 13 Nov, 08:05" when business hours push it to another day. */
  private answerBy(attempt: Attempt): string {
    const sameDay = localTime(attempt.deadline).slice(0, -5) === localTime(attempt.assignedAt).slice(0, -5);
    return sameDay ? localClock(attempt.deadline) : localTime(attempt.deadline);
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
    this.o.persist?.(this.snapshot());
  }
}
