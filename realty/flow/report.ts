import type { Lead } from "./engine.ts";
import { missingListingFields, type MissingField } from "./listing-audit.ts";
import type { ManagementFlag } from "./management.ts";
import type { FlowAgent, Listing } from "./source.ts";
import { localTime } from "./messages.ts";
import { enquiryTally, type EnquiryTally } from "./taxonomy.ts";

/**
 * The daily report, worked out from the leads' attempts. Per agent: leads offered, accepted, passed,
 * timed out and the median time to a first answer (accept or pass). Then the exceptions for admin and
 * the leads still open, enquiries by property kind and channel, management-only messages (never acted
 * on, a person handles them) and our active listings missing information a client needs. Counts and
 * facts only. Pure: no clock, no I/O; the weekly report is the same over the last 7 days' leads.
 */

export type AgentRow = {
  agentId: number;
  name: string;
  received: number;
  accepted: number;
  passed: number;
  timedOut: number;
  medianReplyMinutes: number | null;
};

/** An active listing missing one or more of the fields a client needs (listing-audit.ts). */
export type MissingDocs = { listingId: string; title: string; agentId: number; fields: MissingField[] };

export type ManagementOnlyRow = { leadId: string; client: string; flags: ManagementFlag[]; receivedAt: string };

export type DailyReport = {
  at: string;
  agents: AgentRow[];
  exceptions: { leadId: string; client: string; reason: string }[];
  open: { leadId: string; client: string; state: Lead["state"]; owner: string | null }[];
  totals: { leads: number; accepted: number; exceptions: number; open: number };
  /** Enquiries by property kind and channel (unknown when it can't be told; never guessed). */
  tally: EnquiryTally;
  /** Leads held for a person because the message is management-only (management.ts). Also in exceptions. */
  managementOnly: ManagementOnlyRow[];
  /** Active listings missing client information. Empty when no listings were given. */
  missingDocs: MissingDocs[];
};

export type WeeklyReport = DailyReport & {
  /** Leads received in (from, to]: the 7 days up to and including the report time. */
  period: { from: string; to: string };
};

export const MANAGEMENT_ONLY_PREFIX = "management-only:";

/** The flags in a lead's "management-only: complaints, ..." exception; empty for any other lead. */
export function managementOnlyFlags(lead: Pick<Lead, "state" | "exception">): ManagementFlag[] {
  if (lead.state !== "exception" || !lead.exception?.startsWith(MANAGEMENT_ONLY_PREFIX)) return [];
  return lead.exception
    .slice(MANAGEMENT_ONLY_PREFIX.length)
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean) as ManagementFlag[];
}

export function managementOnlyLeads(leads: Lead[]): ManagementOnlyRow[] {
  return leads
    .filter((l) => managementOnlyFlags(l).length)
    .map((l) => ({ leadId: l.id, client: l.inquiry.name, flags: managementOnlyFlags(l), receivedAt: l.receivedAt }));
}

/** Active listings with missing client fields (sold and withdrawn ones aren't offered, so aren't audited). */
export function missingDocs(listings: Listing[]): MissingDocs[] {
  return listings
    .filter((l) => l.status === "active")
    .map((l) => ({ listingId: l.id, title: l.title, agentId: l.agentId, fields: missingListingFields(l) }))
    .filter((m) => m.fields.length);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const minutesBetween = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 60000;

/** Over every lead given (LeadFlow passes all it holds). Listings, if given, add the missing-docs audit and resolve kinds. */
export function dailyReport(leads: Lead[], agents: FlowAgent[], at: Date, listings: Listing[] = []): DailyReport {
  const name = (id: number | null) => agents.find((a) => a.id === id)?.name ?? (id === null ? null : `agent ${id}`);

  const rows: AgentRow[] = agents.map((a) => {
    const mine = leads.flatMap((l) => l.attempts.filter((t) => t.agentId === a.id));
    const replies = mine.filter((t) => (t.response === "accept" || t.response === "pass") && t.respondedAt).map((t) => minutesBetween(t.assignedAt, t.respondedAt!));
    return {
      agentId: a.id,
      name: a.name,
      received: mine.length,
      accepted: mine.filter((t) => t.response === "accept").length,
      passed: mine.filter((t) => t.response === "pass").length,
      timedOut: mine.filter((t) => t.response === "timeout").length,
      medianReplyMinutes: median(replies),
    };
  });

  const exceptions = leads
    .filter((l) => l.state === "exception")
    .map((l) => ({ leadId: l.id, client: l.inquiry.name, reason: l.exception ?? "" }));

  const open = leads
    .filter((l) => l.state === "received" || l.state === "acknowledged" || l.state === "assigned" || l.state === "escalated")
    .map((l) => {
      const waiting = l.attempts.at(-1);
      return { leadId: l.id, client: l.inquiry.name, state: l.state, owner: waiting && waiting.response === null ? name(waiting.agentId) : null };
    });

  return {
    at: at.toISOString(),
    agents: rows,
    exceptions,
    open,
    totals: {
      leads: leads.length,
      accepted: leads.filter((l) => l.state === "accepted").length,
      exceptions: exceptions.length,
      open: open.length,
    },
    tally: enquiryTally(leads, listings),
    managementOnly: managementOnlyLeads(leads),
    missingDocs: missingDocs(listings),
  };
}

export const WEEK_MS = 7 * 86_400_000;

/** The same report over the leads received in the 7 days up to `at` (after at - 7 days, up to and including at). */
export function weeklyReport(leads: Lead[], agents: FlowAgent[], at: Date, listings: Listing[] = []): WeeklyReport {
  const from = at.getTime() - WEEK_MS;
  const inWeek = leads.filter((l) => {
    const t = Date.parse(l.receivedAt);
    return t > from && t <= at.getTime();
  });
  return { ...dailyReport(inWeek, agents, at, listings), period: { from: new Date(from).toISOString(), to: at.toISOString() } };
}

const KIND_LABEL: Record<keyof EnquiryTally["kind"], string> = {
  rental: "Rental",
  residential_sale: "Residential sale",
  land: "Land",
  commercial: "Commercial",
  unknown: "Unknown",
};

const CHANNEL_LABEL: Record<keyof EnquiryTally["channel"], string> = {
  whatsapp: "WhatsApp",
  facebook: "Facebook",
  instagram: "Instagram",
  website: "Website",
  phone: "Phone",
  referral: "Referral",
  unknown: "Unknown",
};

/** "Rental 2 · Residential sale 1"; zero counts left out, "none" if all are zero. */
function counts<K extends string>(c: Record<K, number>, label: Record<K, string>): string {
  const parts = (Object.keys(c) as K[]).filter((k) => c[k] > 0).map((k) => `${label[k]} ${c[k]}`);
  return parts.length ? parts.join(" · ") : "none";
}

const minutes = (m: number | null) => (m === null ? "–" : `${Math.round(m * 10) / 10} min`);

export function reportText(r: DailyReport | WeeklyReport): string {
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const width = Math.max(...r.agents.map((a) => a.name.length), 5);
  const lines = [
    "period" in r ? `Lead flow weekly report · ${localTime(r.period.from)} to ${localTime(r.period.to)}` : `Lead flow daily report · ${localTime(r.at)}`,
    "",
    `${pad("Agent", width)}  Offered  Accepted  Passed  Timed out  Median first reply`,
    ...r.agents.map((a) => `${pad(a.name, width)}  ${pad(a.received, 7)}  ${pad(a.accepted, 8)}  ${pad(a.passed, 6)}  ${pad(a.timedOut, 9)}  ${minutes(a.medianReplyMinutes)}`),
    "",
    "Median first reply = minutes from an offer to the agent's first answer (accept or pass).",
    "",
    `Exceptions for admin (${r.exceptions.length})`,
    ...(r.exceptions.length ? r.exceptions.map((e) => `  ${e.leadId} · ${e.client}: ${e.reason}`) : ["  none"]),
    "",
    `Still open (${r.open.length})`,
    ...(r.open.length ? r.open.map((o) => `  ${o.leadId} · ${o.client} · ${o.state}${o.owner ? ` · with ${o.owner}` : ""}`) : ["  none"]),
    "",
    `Enquiries by kind: ${counts(r.tally.kind, KIND_LABEL)}`,
    `Enquiries by channel: ${counts(r.tally.channel, CHANNEL_LABEL)}`,
    "",
    `Management-only, for a person, never auto-acted (${r.managementOnly.length})`,
    ...(r.managementOnly.length ? r.managementOnly.map((m) => `  ${m.leadId} · ${m.client}: ${m.flags.join(", ")}`) : ["  none"]),
    "",
    `Listings missing client info (${r.missingDocs.length})`,
    ...(r.missingDocs.length ? r.missingDocs.map((m) => `  ${m.listingId} · ${m.title}: ${m.fields.join(", ")}`) : ["  none"]),
    "",
    `Totals: ${r.totals.leads} leads, ${r.totals.accepted} accepted, ${r.totals.exceptions} exception(s), ${r.totals.open} open.`,
  ];
  return lines.join("\n");
}
