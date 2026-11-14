import { findActions } from "./actions.ts";
import { findAgent, type Agent } from "./agents.ts";
import { type CrmIndex } from "./dedupe.ts";
import { leadFacts, looksLikeLead, normalizePhone, type LeadFacts } from "./extract.ts";
import { clip, proposalId, type Proposal } from "./proposals.ts";
import { detectOrder, parseChat, type ChatMessage } from "./whatsapp.ts";
import { chatTextFromZip } from "./zip.ts";

/**
 * WhatsApp export → proposals: one per lead (deduped within the export and against the CRM) and one per
 * action item. Pure: the CLI (cli/wa-export.ts) does Drive, the CRM reads and the files.
 */

export type ReaderOptions = {
  crm: CrmIndex | null;
  agents: Agent[];
  /** Who gets a task nobody was named for (ONEON1_DEFAULT_AGENT_ID: the admin lead). */
  defaultAgentId: number | null;
  /** Proposal ids already handed over in an earlier run (skipped). */
  seen?: Set<string>;
};

export type ReaderResult = { chat: string; messages: number; proposals: Proposal[] };

/** The chat's name from the export's file name ("WhatsApp Chat with 1on1 Leads.zip" → "1on1 Leads"). */
export function chatName(file: string): string {
  return file
    .replace(/\.(zip|txt)$/i, "")
    .replace(/^WhatsApp Chat (?:with|-)\s*/i, "")
    .trim();
}

export function exportText(file: string, data: Buffer): string {
  return /\.zip$/i.test(file) || data.subarray(0, 2).toString("latin1") === "PK" ? chatTextFromZip(data) : data.toString("utf8");
}

type LeadAcc = { key: string; facts: LeadFacts; msgs: ChatMessage[] };

function merge(a: LeadFacts, b: LeadFacts): LeadFacts {
  const u = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return {
    names: u(a.names, b.names),
    phones: u(a.phones, b.phones),
    emails: u(a.emails, b.emails),
    budget: a.budget ?? b.budget,
    areas: u(a.areas, b.areas),
    interest: { intent: a.interest.intent ?? b.interest.intent, types: u(a.interest.types, b.interest.types), bedrooms: a.interest.bedrooms ?? b.interest.bedrooms },
  };
}

const money = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n));

export function describe(f: LeadFacts): string {
  const parts: string[] = [];
  const i = f.interest;
  const what = [i.bedrooms ? `${i.bedrooms}-bed` : "", i.types.join("/") || "property", i.intent === "rent" ? "to rent" : i.intent === "buy" ? "to buy" : ""].filter(Boolean).join(" ");
  parts.push(what);
  if (f.areas.length) parts.push(`in ${f.areas.join(", ")}`);
  if (f.budget) parts.push(`budget ${f.budget.currency} ${f.budget.min ? `${money(f.budget.min)}–` : ""}${money(f.budget.max)}${f.budget.period ? "/month" : ""}`);
  return parts.join(", ");
}

export function readExport(file: string, data: Buffer, opts: ReaderOptions): ReaderResult {
  const chat = chatName(file);
  const text = exportText(file, data);
  const order = detectOrder(text.split("\n").slice(0, 500));
  const messages = parseChat(text, order).filter((m) => !m.system && !m.media && m.text.trim());
  const leads = new Map<string, LeadAcc>();
  const proposals: Proposal[] = [];

  for (const m of messages) {
    const facts = leadFacts(m.text);
    // A sender who isn't saved in the exporter's phone shows as their number: a lead writing in.
    const senderPhone = /^\+?[\d\s()-]{7,}$/.test(m.sender) && !findAgent(m.sender, opts.agents) ? normalizePhone(m.sender) : null;
    if (senderPhone && !facts.phones.includes(senderPhone)) facts.phones.push(senderPhone);
    const keysOf = (f: LeadFacts) => [...f.phones, ...f.emails, ...f.names.map((n) => n.toLowerCase())];
    // A later message about a lead already seen in this export ("Jordan called again…") adds to it.
    const known = keysOf(facts).some((k) => leads.has(k));
    if (known || looksLikeLead(m.text, facts)) {
      // The same person mentioned again in this export (same phone, email or name) is one lead.
      const keys = keysOf(facts);
      const existing = keys.map((k) => leads.get(k)).find(Boolean);
      const acc = existing ?? { key: keys[0] ?? `${m.line}`, facts, msgs: [] };
      if (existing) acc.facts = merge(acc.facts, facts);
      acc.msgs.push(m);
      for (const k of keys.length ? keys : [acc.key]) leads.set(k, acc);
    }
    for (const a of findActions(m.text, m.at, order)) {
      const named = a.mentions.map((x) => findAgent(x, opts.agents)).find(Boolean) ?? null;
      const assignee = named?.id ?? opts.defaultAgentId;
      const id = proposalId("wa-task", chat, m.at, m.sender, a.text);
      proposals.push({
        id,
        kind: "task",
        source: { channel: "whatsapp", where: `${chat}, line ${m.line}`, at: m.at, from: m.sender },
        summary: clip(a.text, 90),
        crm: null,
        match: null,
        write: {
          table: "crm_tasks",
          row: {
            title: clip(a.text, 120),
            message: `From the WhatsApp group "${chat}" (${m.at.replace("T", " ")}), ${m.sender} wrote:\n${clip(m.text, 1500)}`,
            assignee_agent_id: assignee,
            priority: a.due && a.due <= m.at.slice(0, 10) ? "high" : "medium",
            status: "open",
            due_date: a.due,
          },
        },
        asana: null,
        draft: null,
        blockers: assignee === null ? ["no agent to assign: set ONEON1_DEFAULT_AGENT_ID or @mention an agent"] : [],
        approved: false,
      });
    }
  }

  for (const acc of new Set(leads.values())) {
    const f = acc.facts;
    const first = acc.msgs[0];
    const match = opts.crm?.match(f) ?? null;
    const status = !match ? "new" : match.how === "name" ? "possible_duplicate" : "duplicate";
    const who = f.names[0] ?? f.phones[0] ?? f.emails[0] ?? "unnamed lead";
    const reporter = findAgent(first.sender, opts.agents);
    const assignee = reporter?.id ?? opts.defaultAgentId;
    const said = acc.msgs.map((m) => `${m.at.replace("T", " ")} ${m.sender}: ${m.text}`).join("\n");
    const detail = [`Interest: ${describe(f)}`, f.phones.length ? `Phone: ${f.phones.join(", ")}` : "", f.emails.length ? `Email: ${f.emails.join(", ")}` : ""].filter(Boolean).join("\n");
    const message = clip(`From the WhatsApp group "${chat}".\n${detail}\n\nWhat was said:\n${said}`, 2000);
    const blockers: string[] = [];
    let write: Proposal["write"] = null;
    if (status === "duplicate") {
      // Already in the CRM: nothing new to create; the agent sees it in the list.
    } else if (f.emails[0] && f.names[0]) {
      write = { table: "contact_submissions", row: { name: f.names[0], email: f.emails[0], phone: f.phones[0] ?? null, message, status: "new", notes: "Proposed by Si.Clienty from a WhatsApp export" } };
    } else {
      // contact_submissions needs an email (and crm_clients an email and an owner), so a lead with
      // only a phone becomes a follow-up task for the agent instead.
      write = { table: "crm_tasks", row: { title: clip(`New WhatsApp lead: ${who} (${describe(f)})`, 120), message, assignee_agent_id: assignee, priority: "high", status: "open", due_date: null } };
      if (assignee === null) blockers.push("no agent to assign: set ONEON1_DEFAULT_AGENT_ID");
    }
    proposals.push({
      id: proposalId("wa-lead", chat, acc.key),
      kind: "lead",
      source: { channel: "whatsapp", where: `${chat}, line ${first.line}`, at: first.at, from: first.sender },
      summary: `${who}: ${describe(f)}`,
      crm: status,
      match: match ? { how: match.how, table: match.contact.table, id: match.contact.id } : null,
      write,
      asana: null,
      draft: null,
      blockers,
      approved: false,
    });
  }

  const seen = opts.seen ?? new Set<string>();
  return { chat, messages: messages.length, proposals: proposals.filter((p) => !seen.has(p.id)).sort((a, b) => (a.kind === b.kind ? a.source.at.localeCompare(b.source.at) : a.kind === "lead" ? -1 : 1)) };
}
