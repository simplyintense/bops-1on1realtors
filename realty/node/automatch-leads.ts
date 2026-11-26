import { ownerAllowed } from "../../lib/gate.ts";
import { leadsView, type LeadsView } from "../flow/automatch-leads.ts";
import { runtimeEnv } from "../flow/env.ts";
import { bandOf } from "../flow/automatch.ts";
import { automatchRun, type AutomatchOpts, type AutomatchResult, type AutomatchRow } from "./automatch.ts";
import { periskopeRoot } from "./periskope-root.ts";
import { PeriskopeStore } from "./periskope-store.ts";

/**
 * Automatch lead cards (app/realty/desk, app/realty/automatch). The cards are the STRONG rows (75 and above) of the Automatch
 * matching, seen by whoever may see them (flow/automatch-leads.ts): an owner sees all, anyone else sees the listings they hold
 * (matched by the CRM agent with their email), and nobody else. Unassigned listings are the office's, owners only.
 *
 * Writes: only Bops's own first-seen record for each strong pair (match-seen.jsonl, which the stale rule reads). Nothing is sent,
 * nothing is written to the CRM, and nothing calls out beyond the read-only Automatch matching.
 */

export type LeadOptions = AutomatchOpts & { email: string | null; showHidden?: boolean };

/** The agent id the CRM holds for this email (liveDesk's rule: the email, lower-cased), or null. */
function agentIdOf(email: string | null, agents: readonly { id: number; email: string | null }[]): number | null {
  const e = email?.trim().toLowerCase();
  if (!e) return null;
  return agents.find((a) => a.email === e)?.id ?? null;
}

/**
 * The cards this signed-in person may see. Records first sight of every strong pair (for anyone who looks, so the stale clock
 * doesn't depend on who looked first), then builds the cards from the store's statuses and first-seen times.
 */
export async function staffLeads(o: LeadOptions): Promise<LeadsView> {
  return (await loadAutomatchWithLeads(o)).leads;
}

/**
 * Automatch pairs and lead cards from a single matching run. The Automatch page used to call staffAutomatch and
 * staffLeads separately, which scored the same demand twice.
 */
export async function staffAutomatchWithLeads(o: LeadOptions): Promise<{ owner: false } | ({ owner: boolean } & AutomatchResult & { leads: LeadsView })> {
  const env = o.env ?? runtimeEnv();
  if (!o.email && !ownerAllowed(null, env)) return { owner: false };
  return loadAutomatchWithLeads({ ...o, env });
}

async function loadAutomatchWithLeads(o: LeadOptions): Promise<{ owner: boolean } & AutomatchResult & { leads: LeadsView }> {
  const env = o.env ?? runtimeEnv();
  const now = o.now ?? new Date();
  const { result, agents } = await automatchRun({ ...o, env, now });
  const store = new PeriskopeStore(o.root ?? periskopeRoot(env));
  store.recordMatchSeen(
    result.pairs.filter((p) => bandOf(p.score) === "strong" && p.ask.postId).map((p) => ({ requestId: p.ask.postId as string, listingKey: p.listingKey, at: now.toISOString() })),
  );
  const owner = ownerAllowed(o.email, env);
  const leads = leadsView(result.pairs, {
    owner,
    agentId: agentIdOf(o.email, agents),
    statuses: store.matchStatuses(),
    firstSeen: store.matchSeenRows(),
    now,
    showHidden: o.showHidden,
  });
  return { owner, ...result, leads };
}

/**
 * The lead (strong Automatch row) for one request and listing, and whether this signed-in person may set its outcome: an owner,
 * or the agent who holds the listing. null when there's no such lead. Read only.
 */
export async function leadAccess(requestId: string, listingKey: string, o: LeadOptions): Promise<{ row: AutomatchRow; allowed: boolean } | null> {
  const env = o.env ?? runtimeEnv();
  const { result, agents } = await automatchRun({ ...o, env });
  const row = result.pairs.find((p) => bandOf(p.score) === "strong" && p.ask.postId === requestId && p.listingKey === listingKey);
  if (!row) return null;
  const owner = ownerAllowed(o.email, env);
  const agentId = agentIdOf(o.email, agents);
  return { row, allowed: owner || (row.listing.agentId != null && row.listing.agentId === agentId) };
}
