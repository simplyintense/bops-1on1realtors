import type { Lead, LogEntry } from "./engine.ts";
import type { LeadFlow, MatchApproval, MatchCandidate } from "./flow.ts";
import type { BusinessHours } from "./hours.ts";
import type { ManagementFlag } from "./management.ts";
import type { Channel, MessageKind, OutboxMessage } from "./outbox.ts";
import { dailyReport, managementOnlyFlags, managementOnlyLeads, missingDocs, weeklyReport, type DailyReport, type ManagementOnlyRow, type MissingDocs, type WeeklyReport } from "./report.ts";
import type { FlowAgent, Listing } from "./source.ts";
import { enquiryChannel, enquiryKind, enquiryTally, type EnquiryChannel, type EnquiryTally, type PropertyKind } from "./taxonomy.ts";

/**
 * The staff desk as JSON: what a back-office UI (planned on Lovable: Vite/React + Supabase) reads. One
 * pure function over injected state; no React, no Next, no I/O, no clock of its own. Every value is
 * plain JSON (strings, numbers, booleans, arrays, objects), so it can come straight out of a Supabase
 * edge function or an API route. Field names here are the contract: keep them stable.
 *
 * Nothing in a DeskView is ever sent. The outbox is the dry-run record; there is no transport.
 */

export type DeskInput = {
  /** The desk's "now" (overdue is worked out against it). */
  now: string | Date;
  hours: BusinessHours;
  /** The brand client messages come from (ONEON1_ACK_SENDER_NAME, default "1 On 1 Realty"). */
  ackSender: string;
  /** The agent answer window in minutes (ONEON1_LEAD_TIMEOUT_MINUTES). Default 15. */
  slaMinutes?: number;
  leads: Lead[];
  approvals: MatchApproval[];
  listings: Listing[];
  agents: FlowAgent[];
  /** Already dry-run (dryRun: true). */
  outbox: OutboxMessage[];
  log?: LogEntry[];
};

/** One lead as the desk lists it. */
export type DeskLead = {
  leadId: string;
  client: string;
  state: Lead["state"];
  receivedAt: string;
  ackAt: string | null;
  /** Inquiry.ref: where to find it in the source system. */
  ref: string;
  source: Lead["inquiry"]["source"];
  channel: EnquiryChannel | null;
  kind: PropertyKind | null;
  listingId: string | null;
  area: string | null;
  /** Who has it: the agent with the open offer, else the one who accepted it. Null for none. */
  agent: { id: number; name: string } | null;
  /** The open offer's deadline (business time); null when no offer is open. */
  deadline: string | null;
  /** An open offer whose deadline has passed and that tick() hasn't moved on yet. */
  overdue: boolean;
  attempts: number;
  exception: string | null;
  /** Set for a management-only lead (held for a person, never auto-acted). */
  managementFlags: ManagementFlag[];
  /** The lead's pending match approval, if any. */
  pendingApprovalId: string | null;
};

export type DeskApproval = {
  id: string;
  leadId: string;
  client: string;
  agentId: number;
  agentName: string;
  createdAt: string;
  candidates: MatchCandidate[];
};

export type DeskMessage = {
  id: number;
  at: string;
  kind: MessageKind;
  channel: Channel;
  to: { name: string; address: string };
  from: { name: string } | null;
  leadId: string | null;
  subject: string | null;
  text: string;
  dryRun: true;
};

export type DeskView = {
  generatedAt: string;
  /** Always true: nothing on the desk has been or can be sent from it. */
  dryRun: true;
  ackSender: string;
  /** hours.placeholder is true until Wendy/Crystal confirm the real business hours. */
  hours: BusinessHours;
  slaMinutes: number;
  queue: {
    /** Every lead still in progress: received, acknowledged, assigned or escalated (escalations included). */
    open: DeskLead[];
    /** Open leads on their backup agent (or reassigned by admin). */
    escalations: DeskLead[];
    /** Leads that need a person (unroutable, bad data, both agents missed, management-only). */
    exceptions: DeskLead[];
    /** Open leads whose offer deadline has passed. */
    overdue: DeskLead[];
  };
  approvals: DeskApproval[];
  missingFields: MissingDocs[];
  summary: { daily: DailyReport; weekly: WeeklyReport; tally: EnquiryTally };
  managementOnly: ManagementOnlyRow[];
  outbox: DeskMessage[];
  log: LogEntry[];
};

const OPEN_STATES: Lead["state"][] = ["received", "acknowledged", "assigned", "escalated"];

export function deskView(input: DeskInput): DeskView {
  const now = new Date(input.now);
  const nowMs = now.getTime();
  // Copies: the view never shares objects with the flow's state.
  const leads = structuredClone(input.leads);
  const name = (id: number) => input.agents.find((a) => a.id === id)?.name ?? `agent ${id}`;
  const pending = input.approvals.filter((a) => a.status === "pending");

  const deskLead = (l: Lead): DeskLead => {
    const last = l.attempts.at(-1);
    const open = last && last.response === null ? last : null;
    const holder = open ? open.agentId : l.acceptedBy;
    const listing = l.inquiry.listingId ? input.listings.find((x) => x.id === l.inquiry.listingId) : undefined;
    return {
      leadId: l.id,
      client: l.inquiry.name,
      state: l.state,
      receivedAt: l.receivedAt,
      ackAt: l.ackAt,
      ref: l.inquiry.ref,
      source: l.inquiry.source,
      channel: enquiryChannel(l.inquiry),
      kind: enquiryKind(l.inquiry, listing),
      listingId: l.inquiry.listingId,
      area: l.inquiry.area,
      agent: holder === null ? null : { id: holder, name: name(holder) },
      deadline: open?.deadline ?? null,
      overdue: !!open && Date.parse(open.deadline) <= nowMs,
      attempts: l.attempts.length,
      exception: l.exception,
      managementFlags: managementOnlyFlags(l),
      pendingApprovalId: pending.find((a) => a.leadId === l.id)?.id ?? null,
    };
  };

  const all = leads.map(deskLead);
  const open = all.filter((l) => OPEN_STATES.includes(l.state));

  return {
    generatedAt: now.toISOString(),
    dryRun: true,
    ackSender: input.ackSender,
    hours: { ...input.hours, days: [...input.hours.days] },
    slaMinutes: input.slaMinutes ?? 15,
    queue: {
      open,
      escalations: open.filter((l) => l.state === "escalated"),
      exceptions: all.filter((l) => l.state === "exception"),
      overdue: open.filter((l) => l.overdue),
    },
    approvals: pending.map((a) => ({
      id: a.id,
      leadId: a.leadId,
      client: leads.find((l) => l.id === a.leadId)?.inquiry.name ?? "",
      agentId: a.agentId,
      agentName: name(a.agentId),
      createdAt: a.createdAt,
      candidates: structuredClone(a.candidates),
    })),
    missingFields: missingDocs(input.listings),
    summary: {
      daily: dailyReport(leads, input.agents, now, input.listings),
      weekly: weeklyReport(leads, input.agents, now, input.listings),
      tally: enquiryTally(leads, input.listings),
    },
    managementOnly: managementOnlyLeads(leads),
    outbox: input.outbox.map((m) => ({
      id: m.id,
      at: m.at,
      kind: m.kind,
      channel: m.channel,
      to: { ...m.to },
      from: m.from ? { ...m.from } : null,
      leadId: m.leadId,
      subject: m.subject,
      text: m.text,
      dryRun: true,
    })),
    log: structuredClone(input.log ?? []),
  };
}

/**
 * deskView over a running LeadFlow: its leads, approvals, log, outbox and settings. Agents and listings
 * come from the flow's CRM source unless given. Reads only; it doesn't tick or change the flow.
 */
export async function flowDesk(flow: LeadFlow, extra: { listings?: Listing[]; agents?: FlowAgent[] } = {}): Promise<DeskView> {
  const [listings, agents] = await Promise.all([extra.listings ?? flow.crm.listings(), extra.agents ?? flow.crm.agents()]);
  const snap = flow.snapshot();
  const { hours, ackSender, timeoutMs } = flow.settings;
  return deskView({
    now: flow.engine.now,
    hours,
    ackSender,
    slaMinutes: timeoutMs / 60_000,
    leads: snap.leads,
    approvals: snap.approvals ?? [],
    listings,
    agents,
    outbox: flow.messages,
    log: snap.log,
  });
}
