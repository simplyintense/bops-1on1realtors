import type { Clock } from "./engine.ts";

/**
 * The dry-run outbox. Every message the flow would send (client acknowledgement, agent alert, backup
 * alert, admin exception, daily/weekly report) is recorded here instead: kept in memory, and handed to an
 * optional `append` (one JSONL line; the CLI writes it to a file via realty/node/jsonl.ts) and `print`.
 * No Node imports: this runs in Node, a browser bundle or a Deno edge function alike.
 *
 * There is no transport in this file or anywhere in the flow. `record` is the only sink, so nothing
 * reaches WhatsApp, email or SMS. Real transports come later, with the owner's approval.
 */

export type Channel = "whatsapp" | "email" | "sms";

/** client_match: a proposed message to the client about listings an agent approved (LeadFlow.approveMatches). */
export type MessageKind = "client_ack" | "client_match" | "agent_alert" | "backup_alert" | "admin_exception" | "daily_report" | "weekly_report";

export type OutboxMessage = {
  id: number;
  at: string;
  kind: MessageKind;
  channel: Channel;
  to: { name: string; address: string };
  /** Who a client-facing message comes from: the brand (ONEON1_ACK_SENDER_NAME), never an individual agent. */
  from?: { name: string };
  leadId: string | null;
  subject: string | null;
  text: string;
  dryRun: true;
};

export type Draft = Omit<OutboxMessage, "id" | "at" | "dryRun">;

/** What LeadFlow writes to. DryRunOutbox is the only implementation: there is no transport. */
export interface Outbox {
  record(draft: Draft): OutboxMessage;
  readonly messages: OutboxMessage[];
}

export type DryRunOutboxOptions = {
  clock: Clock;
  /** Called with one JSONL line (no trailing newline) per message; e.g. appendJsonl from realty/node/jsonl.ts. */
  append?: (line: string) => void;
  print?: (line: string) => void;
};

export class DryRunOutbox implements Outbox {
  readonly messages: OutboxMessage[] = [];
  private readonly opts: DryRunOutboxOptions;

  constructor(opts: DryRunOutboxOptions) {
    this.opts = opts;
  }

  record(draft: Draft): OutboxMessage {
    const msg: OutboxMessage = { id: this.messages.length + 1, at: this.opts.clock().toISOString(), ...draft, dryRun: true };
    this.messages.push(msg);
    this.opts.append?.(JSON.stringify(msg));
    this.opts.print?.(formatMessage(msg));
    return msg;
  }
}

/** How a message reads on a terminal: who, by what channel, then the text indented. */
export function formatMessage(m: OutboxMessage): string {
  const head = `── DRY RUN #${m.id} · ${m.kind} · ${m.channel} → ${m.to.name} <${m.to.address}>${m.from ? ` · from ${m.from.name}` : ""}${m.leadId ? ` · lead ${m.leadId}` : ""}`;
  const subject = m.subject ? [`   Subject: ${m.subject}`] : [];
  return [head, ...subject, ...m.text.split("\n").map((l) => `   ${l}`), ""].join("\n");
}
