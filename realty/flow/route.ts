import { normalizePhone } from "../extract.ts";
import type { Inquiry, LeadEngine } from "./engine.ts";
import type { FlowAgent, Listing } from "./source.ts";

/**
 * Who gets a lead. Two rules, in this order:
 *
 *   1. The listing's own agent, if the inquiry is about one specific listing.
 *   2. Otherwise, of the agents who cover the inquiry's area and listing type, the one with the fewest
 *      open leads (ties go to the lower agent id, so the same input always gives the same answer).
 *
 * An agent who already had the lead (timed out or passed) is never offered it again, so the backup
 * is always someone new. Nothing here looks at the time or sends anything.
 */

export type Choice = { agent: FlowAgent; reason: string } | { agent: null; reason: string };

/** Why an inquiry can't be worked at all (a problem with the data, not with the agents). Null if it can. */
export function inquiryProblem(inq: Inquiry, listings: Listing[]): string | null {
  if (!inq.name.trim()) return "no name on the inquiry";
  if (!inq.phone && !inq.email) return "no phone or email to reach the client";
  if (inq.phone && !normalizePhone(inq.phone)) return `phone number "${inq.phone}" isn't valid`;
  if (inq.email && !/^\S+@\S+\.\S+$/.test(inq.email)) return `email "${inq.email}" isn't valid`;
  if (inq.listingId && !listings.some((l) => l.id === inq.listingId)) return `listing ${inq.listingId} isn't in the CRM`;
  return null;
}

/** Open leads for an agent: ones they've accepted, and the one they've been offered and not yet answered. */
export function openLoad(engine: LeadEngine, agentId: number): number {
  return engine.all().filter((l) => (l.state === "accepted" && l.acceptedBy === agentId) || engine.openAttempt(l)?.agentId === agentId).length;
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function coversArea(agent: FlowAgent, area: string | null): boolean {
  return area === null || agent.areas.some((x) => sameText(x, area));
}

export function coversType(agent: FlowAgent, type: Inquiry["listingType"]): boolean {
  return type === null || agent.listingTypes.includes(type);
}

export function chooseAgent(
  inq: Inquiry,
  agents: FlowAgent[],
  listings: Listing[],
  load: (agentId: number) => number,
  alreadyOffered: number[],
): Choice {
  const listing = inq.listingId ? listings.find((l) => l.id === inq.listingId) : undefined;
  const listingAgent = listing ? agents.find((a) => a.id === listing.agentId) : undefined;
  if (listing && listingAgent && !alreadyOffered.includes(listingAgent.id)) {
    return { agent: listingAgent, reason: `listing agent for ${listing.id}` };
  }

  const covering = agents.filter((a) => !alreadyOffered.includes(a.id) && coversArea(a, inq.area) && coversType(a, inq.listingType));
  if (!covering.length) {
    const want = [inq.listingType, inq.area].filter(Boolean).join(" in ") || "this inquiry";
    return { agent: null, reason: `${alreadyOffered.length ? "no agent left" : "no agent"} covers ${want}` };
  }
  const ranked = [...covering].sort((a, b) => load(a.id) - load(b.id) || a.id - b.id);
  const pick = ranked[0];
  const area = inq.area ?? "any area";
  const left = alreadyOffered.length ? "left " : "";
  const why = covering.length === 1 ? `the only agent ${left}who covers it` : `fewest open leads (${load(pick.id)}) of ${covering.length} ${left}who cover it`;
  return { agent: pick, reason: `covers ${area}; ${why}` };
}
