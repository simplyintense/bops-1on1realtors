import { Google, googleCreds, gmailText, rawReply } from "../google.ts";
import { parseInboxAgents, proposalsForEmail, type Email } from "../inbox.ts";
import type { Proposal } from "../proposals.ts";
import { applyApproved, args, crmSnapshot, readLedger, writeLedger, writeProposals } from "./common.ts";

/**
 * Agent inbox sorter. Off unless ONEON1_INBOX_SORTER=1. For each agent in ONEON1_INBOX_AGENTS who has
 * connected their Gmail (ONEON1_GMAIL_REFRESH_TOKEN_<SLUG>, read-only scope), it sorts recent mail into
 * lead / viewing request / offer / follow-up / other and writes proposals: a CRM record or task, an
 * Asana task (ONEON1_ASANA_PROJECT_ID), and a reply drafted in the agent's name.
 *
 * It never sends. Replies are only text in proposals.md, unless ONEON1_INBOX_GMAIL_DRAFTS=1, which also
 * puts them in the agent's own Gmail Drafts (needs the gmail.compose scope) for them to edit and send.
 * Asana tasks are proposals only. CRM writes: `--apply <proposals.json>` with ONEON1_CRM_WRITES=1.
 *
 *   npm run realty:inbox                     # every configured agent, mail from the last 2 days
 *   npm run realty:inbox -- --agent wendy --days 7
 */

const { flags, values } = args();
const out = values.get("out")?.[0] ?? process.env.ONEON1_REALTY_OUT_INBOX ?? ".data/realty/inbox";

async function main() {
  const apply = values.get("apply")?.[0];
  if (apply) return applyApproved(out, apply);
  if (process.env.ONEON1_INBOX_SORTER !== "1") {
    console.log("The inbox sorter is off (set ONEON1_INBOX_SORTER=1 once agents have agreed to it).");
    return;
  }
  const only = values.get("agent")?.[0]?.toLowerCase();
  const days = Math.min(30, Math.max(1, Number(values.get("days")?.[0] ?? 2) || 2));
  const agents = parseInboxAgents(process.env.ONEON1_INBOX_AGENTS).filter((a) => !only || a.slug === only);
  if (!agents.length) throw new Error("no agents set up (ONEON1_INBOX_AGENTS)");
  const asanaProject = process.env.ONEON1_ASANA_PROJECT_ID?.trim() || null;
  const drafts = process.env.ONEON1_INBOX_GMAIL_DRAFTS === "1";
  const ledger = readLedger(out);
  const seen = new Set(ledger.proposals);
  const snap = await crmSnapshot(flags.has("no-crm"));
  const all: Proposal[] = [];

  for (const agent of agents) {
    const creds = googleCreds(process.env[`ONEON1_GMAIL_REFRESH_TOKEN_${agent.slug.toUpperCase().replace(/-/g, "_")}`]);
    if (!creds) {
      console.log(`${agent.slug}: Gmail not connected yet, skipped`);
      continue;
    }
    const g = new Google(creds);
    const counts: Record<string, number> = {};
    let made = 0;
    try {
      for (const id of await g.gmailList(`in:inbox newer_than:${days}d -from:me -category:promotions -category:social`, 100)) {
        const m = await g.gmailMessage(id);
        const t = gmailText(m);
        const e: Email = { id, threadId: m.threadId ?? null, from: t.from, to: t.to, subject: t.subject, date: t.date, messageId: t.messageId || null, body: t.body };
        const r = proposalsForEmail(e, { agent, crm: snap.index, asanaProject, seen });
        counts[r.sorted.category] = (counts[r.sorted.category] ?? 0) + 1;
        for (const p of r.proposals) {
          if (drafts && p.draft) {
            try {
              await g.gmailCreateDraft(rawReply({ to: p.draft.to, subject: p.draft.subject, body: p.draft.body, inReplyTo: e.messageId }), p.draft.threadId);
              made++;
            } catch (err) {
              console.error(`${agent.slug}: draft not saved: ${(err as Error).message}`);
            }
          }
          all.push(p);
        }
      }
    } catch (err) {
      console.error(`${agent.slug}: ${(err as Error).message}`);
    }
    console.log(`${agent.slug}: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no new mail"}${drafts ? `; ${made} draft(s) saved in their Gmail` : ""}`);
  }
  console.log(snap.note);
  if (!all.length) return console.log("Nothing new to propose.");
  const dir = writeProposals(out, "Agent inboxes: proposed CRM records, Asana tasks and reply drafts", all);
  ledger.proposals.push(...all.map((p) => p.id));
  writeLedger(out, ledger);
  console.log(`${all.length} proposal(s) in ${dir}/proposals.md. Nothing was sent or written to the CRM or Asana.`);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
