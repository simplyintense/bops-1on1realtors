/**
 * The lead lifecycle as a state machine. No I/O: it only moves leads between states, records every
 * move in a log, and closes attempts whose deadline has passed. flow.ts decides who gets a lead and
 * what gets sent; this file only knows the rules for moving.
 *
 *   received → acknowledged → assigned ──(accept)──────────→ accepted
 *                                │  (timeout or pass)
 *                                ↓
 *                            escalated ──(accept)──────────→ accepted
 *                                │  (timeout or pass)
 *                                ↓
 *                            exception   (also: unroutable, bad data, no way to reach the client)
 *
 * Each agent who is offered a lead is one Attempt with a deadline. Two attempts at most: the assigned
 * agent, then one backup. Time comes from an injected clock, so tests and the demo can run it on a
 * simulated day.
 */

import type { EnquiryChannel, PropertyKind } from "./taxonomy.ts";

export type Clock = () => Date;

export type ListingType = "sale" | "rent";
export type Currency = "TTD" | "USD";

export type Inquiry = {
  /** The reference in the source system (a contact-form row, a WhatsApp message), so a person can find it. */
  ref: string;
  /** Where it came in. WhatsApp leads come from the export reader or a live chat. */
  source: "website_contact" | "property_inquiry" | "whatsapp";
  name: string;
  phone: string | null;
  email: string | null;
  /** A specific listing the client asked about (our CRM's listing id), if any. */
  listingId: string | null;
  listingType: ListingType | null;
  area: string | null;
  budget: { max: number; currency: Currency } | null;
  beds: number | null;
  message: string;
  /** Finer than source (facebook, instagram, referral...). Unset: derived from source (taxonomy.ts). */
  channel?: EnquiryChannel | null;
  /** Unset: taken from the listing, then from listingType (taxonomy.ts). */
  propertyKind?: PropertyKind | null;
};

export type LeadState = "received" | "acknowledged" | "assigned" | "escalated" | "accepted" | "exception";

export type AttemptResponse = "accept" | "pass" | "timeout";

export type Attempt = {
  agentId: number;
  assignedAt: string;
  deadline: string;
  respondedAt: string | null;
  response: AttemptResponse | null;
};

export type Lead = {
  id: string;
  inquiry: Inquiry;
  state: LeadState;
  receivedAt: string;
  ackAt: string | null;
  attempts: Attempt[];
  acceptedBy: number | null;
  exception: string | null;
};

export type LogEntry = { at: string; leadId: string; event: string };

export type EngineSnapshot = { leads: Lead[]; log: LogEntry[]; seq: number };

export class FlowError extends Error {}

const iso = (d: Date) => d.toISOString();

export class LeadEngine {
  private leads = new Map<string, Lead>();
  private log: LogEntry[] = [];
  private seq = 0;
  private readonly opts: { timeoutMs: number; clock: Clock };

  constructor(opts: { timeoutMs: number; clock: Clock }, snapshot?: EngineSnapshot) {
    this.opts = opts;
    if (snapshot) {
      for (const l of snapshot.leads) this.leads.set(l.id, l);
      this.log = [...snapshot.log];
      this.seq = snapshot.seq;
    }
  }

  get now(): Date {
    return this.opts.clock();
  }

  get timeoutMs(): number {
    return this.opts.timeoutMs;
  }

  lead(id: string): Lead {
    const l = this.leads.get(id);
    if (!l) throw new FlowError(`no lead ${id}`);
    return l;
  }

  all(): Lead[] {
    return [...this.leads.values()];
  }

  events(): LogEntry[] {
    return [...this.log];
  }

  snapshot(): EngineSnapshot {
    return { leads: this.all(), log: this.events(), seq: this.seq };
  }

  /** The attempt still waiting for an answer, if any. */
  openAttempt(lead: Lead): Attempt | null {
    const last = lead.attempts.at(-1);
    return last && last.response === null ? last : null;
  }

  receive(inquiry: Inquiry): Lead {
    this.seq += 1;
    const id = `L${String(this.seq).padStart(3, "0")}`;
    const at = iso(this.now);
    const lead: Lead = { id, inquiry, state: "received", receivedAt: at, ackAt: null, attempts: [], acceptedBy: null, exception: null };
    this.leads.set(id, lead);
    this.record(lead, at, "received");
    return lead;
  }

  acknowledge(id: string): Lead {
    const lead = this.lead(id);
    this.requireState(lead, ["received"], "acknowledge");
    lead.state = "acknowledged";
    lead.ackAt = iso(this.now);
    this.record(lead, lead.ackAt, "acknowledged: client told we have it");
    return lead;
  }

  /** The first agent offered the lead. */
  assign(id: string, agentId: number): Attempt {
    const lead = this.lead(id);
    this.requireState(lead, ["acknowledged"], "assign");
    lead.state = "assigned";
    return this.offer(lead, agentId);
  }

  /** The backup, once the assigned agent's attempt is closed (timed out or passed). Only once. */
  escalate(id: string, backupId: number): Attempt {
    const lead = this.lead(id);
    this.requireState(lead, ["assigned"], "escalate");
    const last = lead.attempts.at(-1);
    if (!last || last.response === null) throw new FlowError(`${id} is still waiting on ${last?.agentId ?? "nobody"}`);
    lead.state = "escalated";
    return this.offer(lead, backupId);
  }

  /** An agent's answer to their open attempt. Late or stray answers are refused. */
  respond(id: string, agentId: number, response: "accept" | "pass"): Lead {
    const lead = this.lead(id);
    const open = this.openAttempt(lead);
    if (!open || open.agentId !== agentId) throw new FlowError(`agent ${agentId} has no open offer for ${id}`);
    const at = this.now;
    open.respondedAt = iso(at);
    open.response = response;
    if (response === "accept") {
      lead.state = "accepted";
      lead.acceptedBy = agentId;
      this.record(lead, open.respondedAt, `accepted by agent ${agentId}`);
    } else {
      this.record(lead, open.respondedAt, `passed by agent ${agentId}`);
    }
    return lead;
  }

  /** Closes every open attempt whose deadline has passed. Returns them so the caller can escalate or raise. */
  expire(): { lead: Lead; attempt: Attempt }[] {
    const now = this.now;
    const out: { lead: Lead; attempt: Attempt }[] = [];
    for (const lead of this.leads.values()) {
      const open = this.openAttempt(lead);
      if (!open || new Date(open.deadline) > now) continue;
      open.respondedAt = iso(now);
      open.response = "timeout";
      this.record(lead, open.respondedAt, `agent ${open.agentId} didn't respond in time`);
      out.push({ lead, attempt: open });
    }
    return out;
  }

  raise(id: string, reason: string): Lead {
    const lead = this.lead(id);
    if (lead.state === "accepted" || lead.state === "exception") throw new FlowError(`${id} is already ${lead.state}`);
    lead.state = "exception";
    lead.exception = reason;
    this.record(lead, iso(this.now), `exception: ${reason}`);
    return lead;
  }

  private offer(lead: Lead, agentId: number): Attempt {
    const at = this.now;
    const attempt: Attempt = {
      agentId,
      assignedAt: iso(at),
      deadline: iso(new Date(at.getTime() + this.opts.timeoutMs)),
      respondedAt: null,
      response: null,
    };
    lead.attempts.push(attempt);
    this.record(lead, attempt.assignedAt, `offered to agent ${agentId} (answer by ${attempt.deadline})`);
    return attempt;
  }

  private requireState(lead: Lead, states: LeadState[], action: string) {
    if (!states.includes(lead.state)) throw new FlowError(`can't ${action} ${lead.id} while it is ${lead.state}`);
  }

  private record(lead: Lead, at: string, event: string) {
    this.log.push({ at, leadId: lead.id, event });
  }
}

/** The lead's agents, in the order they were offered it. */
export function agentsTried(lead: Lead): number[] {
  return lead.attempts.map((a) => a.agentId);
}
