import { readFileSync } from "node:fs";
import type { Agent } from "../agents.ts";
import type { Currency, Inquiry, ListingType } from "./engine.ts";

/**
 * What the lead flow reads from the CRM: agents (with the areas and listing types they cover), our
 * listings and new inquiries. Only the fixture version is built (fixtures/crm.json, made-up people and
 * listings). The live read-only CRM (realty/crm.ts) can implement the same interface later.
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
};

export interface CrmSource {
  agents(): Promise<FlowAgent[]>;
  listings(): Promise<Listing[]>;
  inquiries(): Promise<Inquiry[]>;
}

type Fixture = { agents: FlowAgent[]; listings: Listing[]; inquiries: Inquiry[] };

export class FixtureCrm implements CrmSource {
  private readonly data: Fixture;

  constructor(data: Fixture) {
    this.data = data;
  }

  static load(file = new URL("../fixtures/crm.json", import.meta.url)): FixtureCrm {
    const data = JSON.parse(readFileSync(file, "utf8")) as Fixture;
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
