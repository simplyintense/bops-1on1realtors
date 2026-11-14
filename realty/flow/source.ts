import type { Agent } from "../agents.ts";
import type { Currency, Inquiry, ListingType } from "./engine.ts";
import type { PropertyKind } from "./taxonomy.ts";

/**
 * What the lead flow reads from the CRM: agents (with the areas and listing types they cover), our
 * listings and new inquiries. FixtureCrm.from(data) is the fixture (fixtures/crm.json, made-up people);
 * LiveCrmSource (live-crm.ts) is the read-only live adapter. No file access in this module.
 */

export type FlowAgent = Agent & { areas: string[]; listingTypes: ListingType[] };

export type Listing = {
  id: string;
  title: string;
  listingType: ListingType;
  area: string;
  price: number;
  currency: Currency;
  beds: number;
  baths: number;
  agentId: number;
  status: "active" | "sold" | "withdrawn";
  url: string;
  // Optional detail for the listing audit (listing-audit.ts). Missing means the field is flagged.
  propertyKind?: PropertyKind;
  address?: string | null;
  /** A Google Maps link or written directions. */
  directions?: string | null;
  /** HOA, taxes or other fees; 0 counts as present. */
  fees?: number | null;
  squareFeet?: string | number | null;
  lotSize?: string | number | null;
  /** Utilities, parking, amenities. */
  amenities?: string[] | string | null;
  furnishing?: string | null;
  /** No CRM column for this: it stays flagged until someone fills it in. */
  viewingArrangements?: string | null;
  photoCount?: number;
};

export interface CrmSource {
  agents(): Promise<FlowAgent[]>;
  listings(): Promise<Listing[]>;
  inquiries(): Promise<Inquiry[]>;
}

export type Fixture = { agents: FlowAgent[]; listings: Listing[]; inquiries: Inquiry[] };

export class FixtureCrm implements CrmSource {
  private readonly data: Fixture;

  constructor(data: Fixture) {
    this.data = data;
  }

  static from(data: Fixture): FixtureCrm {
    return new FixtureCrm(data);
  }

  async agents() {
    return this.data.agents;
  }

  async listings() {
    return this.data.listings;
  }

  async inquiries() {
    return this.data.inquiries;
  }
}
