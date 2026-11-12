import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock } from "./engine.ts";

/**
 * The dry-run outbox. Every message the flow would send (client acknowledgement, agent alert, backup
 * alert, admin exception, daily report) is recorded here instead: appended to a JSONL file and printed.
 *
 * There is no transport in this file or anywhere in the flow. `record` is the only sink, so nothing
 * reaches WhatsApp, email or SMS. Real transports come later, with the owner's approval.
 */

export type Channel = "whatsapp" | "email" | "sms";

export type MessageKind = "client_ack" | "agent_alert" | "backup_alert" | "admin_exception" | "daily_report";

export type OutboxMessage = {
  id: number;
  at: string;
  kind: MessageKind;
  channel: Channel;
  to: { name: string; address: string };
  leadId: string | null;
  subject: string | null;
  text: string;
  dryRun: true;
};

export type Draft = Omit<OutboxMessage, "id" | "at" | "dryRun">;

export class DryRunOutbox {
  readonly messages: OutboxMessage[] = [];
  private readonly opts: { clock: Clock; file?: string; print?: (line: string) => void };

  constructor(opts: { clock: Clock; file?: string; print?: (line: string) => void }) {
    this.opts = opts;
  }

  record(draft: Draft): OutboxMessage {
    const msg: OutboxMessage = { id: this.messages.length + 1, at: this.opts.clock().toISOString(), ...draft, dryRun: true };
    this.messages.push(msg);
    if (this.opts.file) {
      mkdirSync(dirname(this.opts.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.opts.file, `${JSON.stringify(msg)}\n`, { mode: 0o600 });
    }
    this.opts.print?.(formatMessage(msg));
    return msg;
  }
}

/** How a message reads on a terminal: who, by what channel, then the text indented. */
export function formatMessage(m: OutboxMessage): string {
  const head = `── DRY RUN #${m.id} · ${m.kind} · ${m.channel} → ${m.to.name} <${m.to.address}>${m.leadId ? ` · lead ${m.leadId}` : ""}`;
  const subject = m.subject ? [`   Subject: ${m.subject}`] : [];
  return [head, ...subject, ...m.text.split("\n").map((l) => `   ${l}`), ""].join("\n");
}
