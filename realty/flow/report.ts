import type { Lead } from "./engine.ts";
import type { FlowAgent } from "./source.ts";
import { localTime } from "./messages.ts";

/**
 * The daily report, worked out from the leads' attempts. Per agent: leads offered, accepted, passed,
 * timed out and the median time to a first answer (accept or pass). Then the exceptions for admin and
 * the leads still open. Counts and facts only.
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

export type DailyReport = {
  at: string;
  agents: AgentRow[];
  exceptions: { leadId: string; client: string; reason: string }[];
  open: { leadId: string; client: string; state: Lead["state"]; owner: string | null }[];
  totals: { leads: number; accepted: number; exceptions: number; open: number };
};

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const minutesBetween = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 60000;

export function dailyReport(leads: Lead[], agents: FlowAgent[], at: Date): DailyReport {
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
  };
}

const minutes = (m: number | null) => (m === null ? "–" : `${Math.round(m * 10) / 10} min`);

export function reportText(r: DailyReport): string {
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const width = Math.max(...r.agents.map((a) => a.name.length), 5);
  const lines = [
    `Lead flow daily report · ${localTime(r.at)}`,
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
    `Totals: ${r.totals.leads} leads, ${r.totals.accepted} accepted, ${r.totals.exceptions} exception(s), ${r.totals.open} open.`,
  ];
  return lines.join("\n");
}
