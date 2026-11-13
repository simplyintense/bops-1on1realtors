import assert from "node:assert/strict";
import { test } from "node:test";
import type { Inquiry } from "../flow/engine.ts";
import { matchOurListings } from "../flow/match.ts";
import { chooseAgent, inquiryProblem } from "../flow/route.ts";
import { loadFixtureCrm } from "../node/jsonl.ts";

/** Routing rules for leads, on the fixture CRM: listing agent, area and type cover, load, and no match. */

const crm = loadFixtureCrm();
const agents = await crm.agents();
const listings = await crm.listings();
const noLoad = () => 0;

const inq = (over: Partial<Inquiry> = {}): Inquiry => ({
  ref: "t-1",
  source: "whatsapp",
  name: "Test Client",
  phone: "+1 868 555 0900",
  email: null,
  listingId: null,
  listingType: null,
  area: null,
  budget: null,
  beds: null,
  message: "",
  ...over,
});

test("a listing's own agent gets an inquiry about that listing, whatever the load", () => {
  const busy = (id: number) => (id === 1 ? 50 : 0);
  const c = chooseAgent(inq({ listingId: "L-101", listingType: "rent", area: "Woodbrook" }), agents, listings, busy, []);
  assert.equal(c.agent?.id, 1);
  assert.match(c.reason, /listing agent for L-101/);
});

test("with no listing, an agent who covers the area and the listing type gets it", () => {
  const c = chooseAgent(inq({ listingType: "sale", area: "Maraval" }), agents, listings, noLoad, []);
  assert.equal(c.agent?.id, 2);
});

test("area names match regardless of case and spacing", () => {
  const c = chooseAgent(inq({ listingType: "sale", area: "  maraval " }), agents, listings, noLoad, []);
  assert.equal(c.agent?.id, 2);
});

test("an agent who doesn't handle the listing type isn't picked", () => {
  // Cora covers Arima but only sells; Dev covers Arima but only rents.
  const sale = chooseAgent(inq({ listingType: "sale", area: "Arima" }), agents, listings, noLoad, []);
  const rent = chooseAgent(inq({ listingType: "rent", area: "Arima" }), agents, listings, noLoad, []);
  assert.equal(sale.agent?.id, 3);
  assert.equal(rent.agent?.id, 4);
});

test("between agents who both cover it, the one with the fewest open leads wins", () => {
  // Woodbrook rent: Ava (1) and Bram (2) both cover it.
  const ava = chooseAgent(inq({ listingType: "rent", area: "Woodbrook" }), agents, listings, (id) => (id === 1 ? 2 : 0), []);
  assert.equal(ava.agent?.id, 2, "Ava has 2 open leads, so Bram gets it");
  const tie = chooseAgent(inq({ listingType: "rent", area: "Woodbrook" }), agents, listings, noLoad, []);
  assert.equal(tie.agent?.id, 1, "on a tie the lower agent id wins, so the answer never changes between runs");
});

test("no agent covering the area and type gives no agent, with the reason", () => {
  const c = chooseAgent(inq({ listingType: "sale", area: "Scarborough, Tobago" }), agents, listings, noLoad, []);
  assert.equal(c.agent, null);
  assert.equal(c.reason, "no agent covers sale in Scarborough, Tobago");
});

test("an agent who already had the lead is never offered it again (the backup is someone new)", () => {
  const c = chooseAgent(inq({ listingId: "L-101", listingType: "rent", area: "Woodbrook" }), agents, listings, noLoad, [1]);
  assert.equal(c.agent?.id, 2, "the listing agent is excluded, so the next agent covering Woodbrook rent takes it");
  const none = chooseAgent(inq({ listingType: "rent", area: "Woodbrook" }), agents, listings, noLoad, [1, 2]);
  assert.equal(none.agent, null);
  assert.equal(none.reason, "no agent left covers rent in Woodbrook");
});

test("bad data is named before routing: no contact, bad phone, bad email, unknown listing", () => {
  assert.equal(inquiryProblem(inq({ phone: null, email: null }), listings), "no phone or email to reach the client");
  assert.match(inquiryProblem(inq({ phone: "12" }), listings) ?? "", /isn't valid/);
  assert.match(inquiryProblem(inq({ email: "not-an-email" }), listings) ?? "", /isn't valid/);
  assert.equal(inquiryProblem(inq({ listingId: "L-999" }), listings), "listing L-999 isn't in the CRM");
  assert.equal(inquiryProblem(inq(), listings), null);
});

test("our matching listings respect type, area, budget, beds and status; and exclude the one asked about", () => {
  const sam = inq({ listingId: "L-101", listingType: "rent", area: "Woodbrook", budget: { max: 9000, currency: "TTD" }, beds: 2 });
  assert.deepEqual(matchOurListings(sam, listings).map((l) => l.id), ["L-103"]);
  // Sold listings never match; nothing to search on gives nothing.
  assert.deepEqual(matchOurListings(inq({ listingType: "sale", area: "Port of Spain" }), listings).map((l) => l.id), []);
  assert.deepEqual(matchOurListings(inq(), listings), []);
  // A budget in another currency doesn't compare against TTD prices.
  assert.deepEqual(matchOurListings(inq({ listingType: "rent", budget: { max: 9000, currency: "USD" } }), listings), []);
});
