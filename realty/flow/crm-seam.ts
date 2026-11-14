import { normalizePhone } from "../extract.ts";
import type { DeskListing } from "./recommendations.ts";
import type { CrmSource, Listing } from "./source.ts";

/**
 * The seam where the 1on1 CRM plugs into live matching and the desk. Two questions only:
 *   listings()   our own listings (CRM properties), matched against WhatsApp requests and the market's requests
 *   agents()     1on1's agents with their CRM id, email and WhatsApp number, so the desk can show the signed-in
 *                agent their own requests and the matches on listings they hold, and tell an agent's request
 *                from one nobody owns yet
 *
 * liveCrmSeam wraps the read-only CRM source (live-crm.ts: GETs only, signed in as the bot login). It fails closed:
 * if the CRM can't be reached, listings() is the "not connected" state and agents() is empty, never a throw. With no
 * CRM settings the seam is NOT_CONNECTED. Nothing here writes to the CRM. Portable: no node:*, no next, no bare process.
 */

export const CRM_NOT_CONNECTED_TEXT = "CRM not connected yet, so our own listings aren't in these matches and requests can't be tied to an agent.";
export const CRM_UNREACHABLE_TEXT = "The 1on1 CRM couldn't be reached just now, so our own listings aren't in these matches. Try again in a minute.";

export type CrmListingsState = { status: "not-connected"; text: string } | { status: "ok"; listings: Listing[] };

/** An agent as the desk needs one. email is lower-cased; phone is normalized (+1868…) or null when the CRM has none. */
export type SeamAgent = { id: number; email: string | null; phone: string | null };

export interface CrmSeam {
  readonly connected: boolean;
  listings(): Promise<CrmListingsState>;
  /** 1on1's agents. Empty when the CRM isn't connected or can't be reached. */
  agents(): Promise<SeamAgent[]>;
}

export const NOT_CONNECTED: CrmSeam = {
  connected: false,
  async listings() {
    return { status: "not-connected", text: CRM_NOT_CONNECTED_TEXT };
  },
  async agents() {
    return [];
  },
};

export function seamAgent(a: { id: number; email: string | null; phone: string | null }): SeamAgent {
  const email = a.email?.trim().toLowerCase() || null;
  return { id: a.id, email, phone: a.phone ? normalizePhone(a.phone) : null };
}

/** The seam over a read-only CrmSource (LiveCrmSource in production). Fails closed. */
export function liveCrmSeam(source: Pick<CrmSource, "listings" | "agents">): CrmSeam {
  return {
    connected: true,
    async listings() {
      try {
        return { status: "ok", listings: await source.listings() };
      } catch {
        return { status: "not-connected", text: CRM_UNREACHABLE_TEXT };
      }
    },
    async agents() {
      try {
        return (await source.agents()).map(seamAgent);
      } catch {
        return [];
      }
    },
  };
}

/**
 * One of our listings in the market's listing shape, for match_requests (tt-market-search src/match/tools-text.ts):
 * ref, url, title, listing_type, property_type, area, beds, price, currency, price_period, agency, holder_agent_id.
 * A field the CRM doesn't give is left out, so the market treats it as unknown. Only active listings are sent.
 */
export function toMatchListing(l: Listing): DeskListing {
  const out: DeskListing = { id: `oneonone:${l.id}`, ref: `oneonone:${l.id}`, title: l.title, listing_type: l.listingType, agency: "1on1 Realtors", currency: l.currency };
  if (l.url) out.url = l.url;
  if (l.area) out.area = l.area;
  if (l.beds) out.beds = l.beds;
  if (l.price) {
    out.price = l.price;
    out.price_period = l.listingType === "rent" ? "month" : "sale";
  }
  if (l.propertyKind === "land" || l.propertyKind === "commercial") out.property_type = l.propertyKind;
  if (l.agentId > 0) out.holder_agent_id = String(l.agentId);
  return out;
}
