import { normalizePhone } from "../extract.ts";
import type { DeskListing } from "./recommendations.ts";

/**
 * The seam where the 1on1 CRM plugs into live matching and the desk. Two questions only:
 *   listings()          our own active listings, for match_requests / score_matches (CRM listings side)
 *   agentPhone(email)   the WhatsApp number of the signed-in agent, so the desk can show "your" requests
 *
 * The CRM isn't connected yet (the bot's CRM account is waiting on a signup fix), so crmSeam() returns
 * NOT_CONNECTED: no listings, an honest "CRM not connected" state, and no agent numbers. When the read-only CRM
 * adapter is ready (live-crm.ts reads agents and listings), it implements this interface and nothing else changes.
 * Read only: nothing here writes to the CRM. Portable: no node:*, no next, no bare process.
 */

export const CRM_NOT_CONNECTED_TEXT = "CRM not connected yet, so our own listings aren't in these matches and requests can't be tied to an agent.";

export type CrmListingsState = { status: "not-connected"; text: string } | { status: "ok"; listings: DeskListing[] };

export interface CrmSeam {
  readonly connected: boolean;
  listings(): Promise<CrmListingsState>;
  /** The agent's WhatsApp number, normalized (+1868…), or null when the email isn't a known agent. */
  agentPhone(email: string): Promise<string | null>;
}

export const NOT_CONNECTED: CrmSeam = {
  connected: false,
  async listings() {
    return { status: "not-connected", text: CRM_NOT_CONNECTED_TEXT };
  },
  async agentPhone() {
    return null;
  },
};

/** For tests and, later, the live adapter: a seam over fixed listings and agents. */
export function fixedCrmSeam(listings: DeskListing[], agents: { email: string; phone: string }[]): CrmSeam {
  return {
    connected: true,
    async listings() {
      return { status: "ok", listings };
    },
    async agentPhone(email) {
      const a = agents.find((x) => x.email.trim().toLowerCase() === email.trim().toLowerCase());
      return a ? normalizePhone(a.phone) : null;
    },
  };
}

/** The seam this server uses. Always NOT_CONNECTED until the read-only CRM adapter is wired in here. */
export function crmSeam(): CrmSeam {
  return NOT_CONNECTED;
}
