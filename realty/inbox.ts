import { findActions } from "./actions.ts";
import { type CrmIndex } from "./dedupe.ts";
import { leadFacts, type LeadFacts } from "./extract.ts";
import { clip, proposalId, type Proposal } from "./proposals.ts";
import { describe } from "./wa-reader.ts";

/**
 * An agent's inbox sorter: each new email gets a category (lead, viewing request, offer, follow-up,
 * other), and the ones that matter get proposals: a CRM record (new lead, deduped), a CRM or Asana task,
 * and a reply drafted in the agent's name for them to review and send themselves. Plain rules, so the
 * same mail always sorts the same way and the reasons are listed. It never sends anything.
 */

export type Category = "lead" | "viewing_request" | "offer" | "follow_up" | "other";

export type Email = { id: string; threadId: string | null; from: string; to: string; subject: string; date: string; messageId: string | null; body: string };

export type Sorted = { category: Category; reasons: string[]; facts: LeadFacts };

const RULES: { cat: Exclude<Category, "other">; weight: number; re: RegExp; why: string }[] = [
  { cat: "offer", weight: 3, re: /\b(make|making|submit|submitting|put in|put forward)\s(an?\s)?offer\b|\bcounter[\s-]?offer\b|\boffer (of|for|at)\b/i, why: "mentions an offer" },
  { cat: "offer", weight: 2, re: /\b(willing to pay|agreement for sale|deposit|down payment|accept (the|your) (price|offer)|best price|negotiat)/i, why: "talks price terms" },
  { cat: "viewing_request", weight: 3, re: /\b(viewing|showing|tour)\b|\b(view|see|visit|look at) the (house|home|property|apartment|unit|place|land|lot|townhouse)\b/i, why: "asks to view" },
  { cat: "viewing_request", weight: 1, re: /\b(appointment|available (on|this|next)|what time|when can (i|we))\b/i, why: "asks for a time" },
  { cat: "lead", weight: 3, re: /\b(new (contact form|property inquiry|enquiry|inquiry|lead)|website (form|enquiry|inquiry))\b/i, why: "a website lead notice" },
  { cat: "lead", weight: 2, re: /\b(interested in|looking (for|to (buy|rent))|is (it|this|the property) still available|in the market for|searching for|enquir(y|ing) about|inquir(y|ing) about|price of)\b/i, why: "asks about a property" },
  { cat: "follow_up", weight: 2, re: /\b(following up|follow(ing)?[\s-]up|checking in|any update|just checking|as discussed|gentle reminder|circling back|touching base)\b/i, why: "follows up" },
];

const NOISE = /\b(unsubscribe|newsletter|no-?reply|noreply|do not reply|mailer-daemon|notification settings|view in browser)\b/i;

/** Sorts one email. A website lead notice from no-reply is still a lead; other no-reply mail is "other". */
export function classify(e: Email): Sorted {
  const text = `${e.subject}\n${e.body}`;
  const score: Record<string, number> = {};
  const reasons: string[] = [];
  for (const r of RULES) {
    if (r.re.test(text)) {
      score[r.cat] = (score[r.cat] ?? 0) + r.weight;
      reasons.push(r.why);
    }
  }
  const facts = leadFacts(text);
  if (facts.budget && (score.offer ?? 0) > 0) score.offer += 1;
  if ((facts.interest.intent || facts.interest.types.length || facts.areas.length) && (score.lead ?? 0) > 0) score.lead += 1;
  if (/^\s*(re|fwd?):/i.test(e.subject) && !Object.keys(score).length && !NOISE.test(text)) {
    score.follow_up = 1;
    reasons.push("a reply in an existing thread");
  }
  // Ties go to the one that needs the agent soonest: an offer, then a viewing, then a lead.
  const order: Category[] = ["offer", "viewing_request", "lead", "follow_up"];
  let best: Category = "other";
  for (const c of order) if ((score[c] ?? 0) > (score[best] ?? 0)) best = c;
  const isNotice = (score.lead ?? 0) >= 3 && reasons.includes("a website lead notice");
  if (NOISE.test(`${e.from}\n${text}`) && !isNotice && (score[best] ?? 0) < 3) return { category: "other", reasons: ["looks like a newsletter or automated mail"], facts };
  return { category: best, reasons: best === "other" ? ["nothing a realtor needs to act on"] : reasons, facts };
}

/** "Name <email>" → its parts. */
export function parseAddress(from: string): { name: string | null; email: string | null } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  const e = /[^\s<>]+@[^\s<>]+/.exec(from);
  return { name: null, email: e ? e[0].toLowerCase() : null };
}

export type InboxAgent = { slug: string; email: string; name: string; crmAgentId: number | null };

const firstName = (n: string | null) => (n ? n.split(/\s+/)[0] : null);

/** A short reply in the agent's voice, with blanks for what only they know. Always for their review. */
export function draftReply(cat: Category, e: Email, agent: InboxAgent, facts: LeadFacts): { subject: string; body: string } | null {
  const who = parseAddress(e.from);
  const hi = `Hi ${firstName(who.name) ?? "there"},`;
  const sign = `\n\nBest regards,\n${agent.name}\n1on1 Realtors`;
  const what = describe(facts);
  const subject = /^re:/i.test(e.subject) ? e.subject : `Re: ${e.subject || "your enquiry"}`;
  switch (cat) {
    case "lead":
      return { subject, body: `${hi}\n\nThank you for getting in touch with 1on1 Realtors${what !== "property" ? ` about a ${what}` : ""}. I'd be glad to help. [Add details or matching listings here.]\n\nWhat's the best number and time to reach you?${sign}` };
    case "viewing_request":
      return { subject, body: `${hi}\n\nThank you for your interest. I can arrange a viewing on [day] at [time]. Does that suit you? If not, please send me a couple of times that work.${sign}` };
    case "offer":
      return { subject, body: `${hi}\n\nThank you for your offer. I've received it and will present it to the owner, and I'll come back to you by [day]. [Add any conditions or documents needed.]${sign}` };
    case "follow_up":
      return { subject, body: `${hi}\n\nThanks for following up. [Add the update here.]${sign}` };
    default:
      return null;
  }
}

export type InboxOptions = { agent: InboxAgent; crm: CrmIndex | null; asanaProject: string | null; seen?: Set<string> };

/** Proposals for one email: at most one CRM record or task, one Asana task and one draft, all unapproved. */
export function proposalsForEmail(e: Email, opts: InboxOptions): { sorted: Sorted; proposals: Proposal[] } {
  const sorted = classify(e);
  if (sorted.category === "other") return { sorted, proposals: [] };
  const { agent } = opts;
  const who = parseAddress(e.from);
  const f = sorted.facts;
  if (who.email && !f.emails.includes(who.email) && who.email !== agent.email.toLowerCase()) f.emails.unshift(who.email);
  if (who.name && !f.names.includes(who.name)) f.names.push(who.name);
  const match = opts.crm?.match(f) ?? null;
  const crm = !match ? "new" : match.how === "name" ? "possible_duplicate" : "duplicate";
  const label = { lead: "Lead", viewing_request: "Viewing request", offer: "Offer", follow_up: "Follow-up" }[sorted.category];
  const name = who.name ?? who.email ?? "unknown sender";
  const due = findActions(e.body, e.date.slice(0, 10)).map((a) => a.due).find(Boolean) ?? null;
  const source = { channel: "email" as const, where: `${agent.slug} inbox, ${clip(e.subject || "(no subject)", 60)}`, at: e.date, from: e.from };
  const blockers = agent.crmAgentId === null ? [`no CRM agent id for ${agent.slug} (ONEON1_INBOX_AGENTS)`] : [];
  const summary = `${label}: ${name}${describe(f) !== "property" ? ` (${describe(f)})` : ""}`;
  const message = clip(`${label} from ${e.from} on ${e.date}.\nSubject: ${e.subject}\nWhy: ${sorted.reasons.join(", ")}\n\n${e.body}`, 2000);
  const draft = draftReply(sorted.category, e, agent, f);
  const asana = { project: opts.asanaProject, name: clip(`${label}: ${name} (${agent.name})`, 120), notes: message, due_on: due };

  let write: Proposal["write"];
  if (sorted.category === "lead" && crm !== "duplicate" && who.email) {
    write = { table: "contact_submissions", row: { name: who.name ?? who.email, email: who.email, phone: f.phones[0] ?? null, message, status: "new", notes: `Proposed by the ${agent.slug} inbox sorter` } };
  } else {
    write = { table: "crm_tasks", row: { title: clip(summary, 120), message, assignee_agent_id: agent.crmAgentId, priority: sorted.category === "offer" ? "high" : "medium", status: "open", due_date: due } };
  }

  const proposals: Proposal[] = [
    {
      id: proposalId("email", agent.slug, e.id),
      kind: sorted.category === "lead" ? "lead" : "task",
      source,
      summary,
      crm,
      match: match ? { how: match.how, table: match.contact.table, id: match.contact.id } : null,
      write,
      asana: opts.asanaProject ? asana : { ...asana, project: null },
      draft: draft && who.email ? { to: who.email, subject: draft.subject, body: draft.body, threadId: e.threadId } : null,
      blockers: write.table === "crm_tasks" ? blockers : [],
      approved: false,
    },
  ];
  const seen = opts.seen ?? new Set<string>();
  return { sorted, proposals: proposals.filter((p) => !seen.has(p.id)) };
}

/** ONEON1_INBOX_AGENTS: "slug:email:crmAgentId:Display Name" entries, comma separated. */
export function parseInboxAgents(raw: string | undefined): InboxAgent[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [slug, email, id, ...name] = s.split(":");
      return { slug: (slug ?? "").trim().toLowerCase(), email: (email ?? "").trim().toLowerCase(), crmAgentId: id && /^\d+$/.test(id.trim()) ? Number(id) : null, name: name.join(":").trim() || slug };
    })
    .filter((a) => /^[a-z0-9_-]+$/.test(a.slug) && /@/.test(a.email));
}
