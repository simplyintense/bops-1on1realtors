import { createHash } from "node:crypto";
import type { Match } from "./dedupe.ts";

/**
 * A proposal: something a bot found that an agent should approve before it touches the CRM or Asana.
 * Every tool here (WhatsApp exports, agents' inboxes) only ever makes these; nothing is written until a
 * person flips `approved` to true and the writer runs with ONEON1_CRM_WRITES=1 (crm-write.ts).
 */

export type ContactSubmissionRow = { name: string; email: string; phone: string | null; message: string; status: "new"; notes: string };
export type CrmTaskRow = {
  title: string;
  message: string;
  assignee_agent_id: number | null;
  priority: "low" | "medium" | "high";
  status: "open";
  due_date: string | null;
};
export type AsanaTask = { project: string | null; name: string; notes: string; due_on: string | null };

export type CrmWrite = { table: "contact_submissions"; row: ContactSubmissionRow } | { table: "crm_tasks"; row: CrmTaskRow };

export type Proposal = {
  /** Stable across runs (same source, same words), so a second run of the same export proposes nothing new. */
  id: string;
  kind: "lead" | "task" | "reply";
  /** Where it came from, for the agent to check: WhatsApp chat + line, or a Gmail message. */
  source: { channel: "whatsapp" | "email"; where: string; at: string; from: string };
  summary: string;
  /** For leads: new, or already in the CRM (matched on phone/email), or maybe (name only). */
  crm: "new" | "duplicate" | "possible_duplicate" | null;
  match: { how: Match["how"]; table: string; id: string } | null;
  /** What would be written on approval; null means nothing to write (a duplicate, or only for reading). */
  write: CrmWrite | null;
  asana: AsanaTask | null;
  /** A reply for the agent to send themselves (never sent by a bot). */
  draft: { to: string; subject: string; body: string; threadId: string | null } | null;
  /** Why it can't be written as is (no agent to assign, no email for a contact row…). */
  blockers: string[];
  approved: boolean;
};

export const proposalId = (...parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A plain list for a person to read before approving (proposals.md next to proposals.json). */
export function proposalsMarkdown(title: string, ps: Proposal[]): string {
  const lines = [`# ${title}`, "", `${ps.length} proposal(s). Nothing has been written. To approve one, set "approved": true in proposals.json.`, ""];
  for (const p of ps) {
    lines.push(`## ${p.kind}: ${p.summary}`, "", `- id: \`${p.id}\``, `- from: ${p.source.from} (${p.source.channel}, ${p.source.where}, ${p.source.at})`);
    if (p.crm) lines.push(`- CRM: ${p.crm}${p.match ? ` (${p.match.how} → ${p.match.table} ${p.match.id})` : ""}`);
    if (p.write) lines.push(`- would write: ${p.write.table}`, "", "```json", JSON.stringify(p.write.row, null, 2), "```");
    if (p.asana) lines.push(`- Asana task: ${p.asana.name}${p.asana.due_on ? ` (due ${p.asana.due_on})` : ""}`);
    if (p.draft) lines.push(`- draft reply to ${p.draft.to}: "${p.draft.subject}"`, "", "```", p.draft.body, "```");
    if (p.blockers.length) lines.push(`- blocked: ${p.blockers.join("; ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
