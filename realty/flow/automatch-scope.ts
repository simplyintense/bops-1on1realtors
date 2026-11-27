import { type Band } from "./automatch.ts";
import { canSeeLead } from "./automatch-leads.ts";

/**
 * Who sees which Automatch pairs (app/realty/automatch). An owner sees every pair, and may narrow the list to one agent's
 * listings (or the unassigned ones) with ?agent=. Anyone else sees only the pairs on listings they hold, and no filter of
 * theirs changes that: the server, not the page, decides.
 *
 * Portable: no node:*, no next, no bare process. Pure.
 */

/** The fields of an Automatch pair that scoping reads. */
export type ScopePair = { band: Band; listing: { agentId: number | null; agentName: string | null } };

/** The owner's filter: one agent's CRM id, the unassigned listings, or null (all). */
export type AgentFilter = number | "unassigned" | null;

/** One row of the owner's "Assigned to agents" breakdown: this agent's pairs at 50 and above, by band. */
export type AgentAssignmentCount = { agentId: number | null; name: string; strong: number; fair: number; total: number };

/**
 * The CRM agent id the CRM holds for this email, or null. Both sides are trimmed and lower-cased, so a mixed-case email matches
 * whichever case the CRM or the sign-in has. Matched by email only (names can collide). Pure.
 */
export function agentIdOf(email: string | null | undefined, agents: readonly { id: number; email: string | null }[]): number | null {
  const e = (email ?? "").trim().toLowerCase();
  if (!e) return null;
  return agents.find((a) => (a.email ?? "").trim().toLowerCase() === e)?.id ?? null;
}

/**
 * The owner's agent filter from ?agent=. A non-owner always gets null, whatever the query says, so a signed-in agent can't
 * widen their view by naming another agent or "unassigned". For an owner: "unassigned", a positive whole number (an agent's
 * CRM id), and anything else (missing, zero, garbage) is null, which shows every pair. Pure.
 */
export function parseOwnerAgentFilter(owner: boolean, raw: string | null | undefined): AgentFilter {
  if (!owner) return null;
  const s = (raw ?? "").trim();
  if (s === "unassigned") return "unassigned";
  if (!/^[1-9]\d*$/.test(s)) return null;
  const id = Number(s);
  return Number.isSafeInteger(id) ? id : null;
}

/** The pairs this viewer may see: canSeeLead's rule (an owner sees all; anyone else only the listings they hold). Pure. */
export function scopeAutomatchPairs<T extends ScopePair>(pairs: readonly T[], me: { owner: boolean; agentId: number | null }): T[] {
  return pairs.filter((p) => canSeeLead(me, p.listing.agentId));
}

/** The owner's filter applied to the pairs: one agent's listings, the unassigned ones, or all when the filter is null. Pure. */
export function applyOwnerAgentFilter<T extends ScopePair>(pairs: readonly T[], filter: AgentFilter): T[] {
  if (filter == null) return [...pairs];
  if (filter === "unassigned") return pairs.filter((p) => p.listing.agentId == null);
  return pairs.filter((p) => p.listing.agentId === filter);
}

/** Strong and fair counts of these pairs (the rows as they stand, after folding). Pure. */
export function recountBands(pairs: readonly ScopePair[]): { strong: number; fair: number } {
  let strong = 0;
  let fair = 0;
  for (const p of pairs) {
    if (p.band === "strong") strong += 1;
    else fair += 1;
  }
  return { strong, fair };
}

/**
 * Each agent's pairs at 50 and above, for the owner's breakdown. Assigned agents with at least one pair come first, by name
 * (case-insensitive, locale-aware); the Unassigned group comes last and only when it has a pair. Pure.
 */
export function agentAssignmentCounts<T extends ScopePair & { listing: { agentId: number | null } }>(pairs: readonly T[]): AgentAssignmentCount[] {
  const byAgent = new Map<number | null, AgentAssignmentCount>();
  for (const p of pairs) {
    const key = p.listing.agentId ?? null;
    let row = byAgent.get(key);
    if (!row) {
      row = { agentId: key, name: key == null ? "Unassigned" : (p.listing.agentName ?? `agent #${key}`), strong: 0, fair: 0, total: 0 };
      byAgent.set(key, row);
    }
    if (p.band === "strong") row.strong += 1;
    else row.fair += 1;
    row.total = row.strong + row.fair;
  }
  const assigned = [...byAgent.values()].filter((r) => r.agentId != null).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const unassigned = byAgent.get(null);
  return unassigned ? [...assigned, unassigned] : assigned;
}
