import assert from "node:assert/strict";
import { test } from "node:test";
import type { Inquiry } from "../flow/engine.ts";
import { missingListingFields } from "../flow/listing-audit.ts";
import { MANAGEMENT_ONLY, managementFlags } from "../flow/management.ts";
import type { Listing } from "../flow/source.ts";
import { loadFixtureCrm } from "../node/jsonl.ts";
import {
  channelFromSource,
  enquiryChannel,
  enquiryKind,
  enquiryTally,
  listingTypeFromKind,
  propertyKindFromCrm,
} from "../flow/taxonomy.ts";

/** Unit 1 of v1 beta: enquiry taxonomy, listing audit, management flags. Pure functions, no I/O. */

const inquiry = (over: Partial<Inquiry> = {}): Inquiry => ({
  ref: "t-1",
  source: "property_inquiry",
  name: "Test",
  phone: null,
  email: null,
  listingId: null,
  listingType: null,
  area: null,
  budget: null,
  beds: null,
  message: "",
  ...over,
});

test("propertyKindFromCrm: land and commercial win over rent/sale", () => {
  const cases: [string | null, string | null, string | null][] = [
    ["for-sale", "Land", "land"],
    ["for-rent", "Residential Lot", "land"],
    ["sale", "2 acres", "land"],
    ["for-sale", "Parcel", "land"],
    ["for-rent", "Office", "commercial"],
    ["for-sale", "WAREHOUSE", "commercial"],
    ["rent", "Retail space", "commercial"],
    ["for-sale", "Industrial", "commercial"],
    ["for-rent", "Shop", "commercial"],
    ["for-rent", "Apartment", "rental"],
    ["rent", null, "rental"],
    ["Rental", "House", "rental"],
    ["for-sale", "House", "residential_sale"],
    ["sale", null, "residential_sale"],
    [null, null, null],
    ["", "Townhouse", null],
  ];
  for (const [lt, pt, want] of cases) assert.equal(propertyKindFromCrm(lt, pt), want, `${lt} / ${pt}`);
});

test("listingTypeFromKind: only rental is rent", () => {
  assert.equal(listingTypeFromKind("rental"), "rent");
  assert.equal(listingTypeFromKind("residential_sale"), "sale");
  assert.equal(listingTypeFromKind("land"), "sale");
  assert.equal(listingTypeFromKind("commercial"), "sale");
});

test("channelFromSource: source mapping, a clear hint wins, an ambiguous one is ignored", () => {
  assert.equal(channelFromSource("website_contact"), "website");
  assert.equal(channelFromSource("property_inquiry"), "website");
  assert.equal(channelFromSource("whatsapp"), "whatsapp");
  assert.equal(channelFromSource("website_contact", "Facebook"), "facebook");
  assert.equal(channelFromSource("website_contact", "saw it on Instagram"), "instagram");
  assert.equal(channelFromSource("website_contact", "phone"), "phone");
  assert.equal(channelFromSource("website_contact", "referred by a friend"), "referral");
  assert.equal(channelFromSource("property_inquiry", "WhatsApp"), "whatsapp");
  assert.equal(channelFromSource("whatsapp", "contact form"), "website");
  assert.equal(channelFromSource("website_contact", "please call me, my phone is 555"), "website");
  assert.equal(channelFromSource("website_contact", "facebook or instagram"), "website");
  assert.equal(channelFromSource("bogus" as Inquiry["source"]), null);
});

test("enquiryChannel and enquiryKind prefer what's set, else derive, else null", () => {
  assert.equal(enquiryChannel(inquiry({ channel: "referral" })), "referral");
  assert.equal(enquiryChannel(inquiry({ source: "whatsapp" })), "whatsapp");

  const land = { propertyKind: "land" } as Listing;
  assert.equal(enquiryKind(inquiry({ propertyKind: "commercial", listingType: "rent" }), land), "commercial");
  assert.equal(enquiryKind(inquiry({ listingType: "sale" }), land), "land");
  assert.equal(enquiryKind(inquiry({ listingType: "rent" })), "rental");
  assert.equal(enquiryKind(inquiry({ listingType: "sale" })), "residential_sale");
  assert.equal(enquiryKind(inquiry()), null);
});

test("enquiryTally: counts by kind and channel, unknowns are not invented", async () => {
  const crm = loadFixtureCrm();
  const leads = (await crm.inquiries()).map((i) => ({ inquiry: i }));
  leads.push({ inquiry: inquiry({ channel: "facebook", propertyKind: "land" }) });
  leads.push({ inquiry: inquiry() });
  const t = enquiryTally(leads, await crm.listings());
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  assert.equal(sum(t.kind), leads.length);
  assert.equal(sum(t.channel), leads.length);
  assert.equal(t.kind.land, 1);
  assert.ok(t.kind.unknown >= 1);
  assert.equal(t.channel.facebook, 1);
  assert.equal(t.channel.unknown, 0);
});

const complete: Listing = {
  id: "L-900",
  title: "Three-bed house, Maraval",
  listingType: "sale",
  area: "Maraval",
  price: 2_500_000,
  currency: "TTD",
  beds: 3,
  baths: 2,
  agentId: 1,
  status: "active",
  url: "https://example.com/listings/L-900",
  propertyKind: "residential_sale",
  address: "12 Example Rd, Maraval",
  directions: null,
  fees: 0,
  squareFeet: null,
  lotSize: null,
  amenities: ["water tank", "2 parking"],
  furnishing: "Unfurnished",
  viewingArrangements: "Weekdays after 4pm, call agent",
  photoCount: 12,
};

test("missingListingFields: a complete listing has nothing missing", () => {
  assert.deepEqual(missingListingFields(complete), []);
});

test("missingListingFields: a sparse fixture listing (L-101) is flagged for everything it doesn't hold", async () => {
  const l101 = (await loadFixtureCrm().listings()).find((l) => l.id === "L-101")!;
  assert.deepEqual(missingListingFields(l101), [
    "exact_location_directions",
    "utilities_parking_amenities",
    "furnishing",
    "viewing_arrangements",
    "photos",
  ]);
});

test("missingListingFields: per-field rules", () => {
  const miss = (over: Partial<Listing>) => missingListingFields({ ...complete, ...over });
  assert.deepEqual(miss({ status: "" as Listing["status"] }), ["availability_status"]);
  assert.deepEqual(miss({ status: "unknown" as Listing["status"] }), ["availability_status"]);
  assert.deepEqual(miss({ status: "Under-Offer" as Listing["status"] }), []);
  assert.deepEqual(miss({ address: "  ", directions: null }), ["exact_location_directions"]);
  assert.deepEqual(miss({ address: null, directions: "https://maps.google.com/?q=1,2" }), []);
  assert.deepEqual(miss({ price: 0 }), ["price_rent_and_fees"]);
  assert.deepEqual(miss({ price: Number.NaN }), ["price_rent_and_fees"]);
  assert.deepEqual(miss({ fees: null }), []);
  assert.deepEqual(miss({ beds: 0, baths: 1 }), ["size_beds_baths"]);
  assert.deepEqual(miss({ beds: 0, baths: 1, squareFeet: 450 }), []);
  assert.deepEqual(miss({ propertyKind: "land", beds: 0, baths: 0 }), ["size_beds_baths"]);
  assert.deepEqual(miss({ propertyKind: "land", beds: 0, baths: 0, lotSize: "5,000 sq ft" }), []);
  assert.deepEqual(miss({ propertyKind: "commercial", squareFeet: 1200 }), []);
  assert.deepEqual(miss({ propertyKind: "commercial" }), ["size_beds_baths"]);
  assert.deepEqual(miss({ amenities: [] }), ["utilities_parking_amenities"]);
  assert.deepEqual(miss({ amenities: "AC, parking" }), []);
  assert.deepEqual(miss({ furnishing: "" }), ["furnishing"]);
  assert.deepEqual(miss({ viewingArrangements: undefined }), ["viewing_arrangements"]);
  assert.deepEqual(miss({ photoCount: 0 }), ["photos"]);
});

test("managementFlags: flags management matters", () => {
  const cases: [string, string[]][] = [
    ["Please change the asking price to $2.1M", ["price_contract_changes"]],
    ["We need to amend the contract before closing", ["price_contract_changes"]],
    ["Can you send the commission invoice?", ["commissions_invoicing"]],
    ["What is the commission split on this one?", ["commissions_invoicing"]],
    ["Please send the title deed", ["compliance_docs"]],
    ["KYC documents attached", ["compliance_docs"]],
    ["Here's the compliance pack", ["compliance_docs"]],
    ["I want to complain about the agent", ["complaints"]],
    ["This deal is unusual", ["unusual_deals"]],
    ["It's off-market, keep it quiet", ["unusual_deals"]],
    ["Part of it paid under the table", ["unusual_deals"]],
  ];
  for (const [text, want] of cases) assert.deepEqual(managementFlags(text), want, text);
});

test("managementFlags: ordinary enquiries are not flagged", () => {
  for (const text of [
    "What's the price?",
    "Is the rent negotiable?",
    "Is the two-bedroom in Woodbrook still available? Could we see it this week?",
    "Lovely place, no complaints at all",
    "Please call me, I'd like to view on Saturday",
    "The layout is unusual but I like it",
  ]) {
    assert.deepEqual(managementFlags(text), [], text);
  }
});

test("MANAGEMENT_ONLY lists every flag", () => {
  assert.deepEqual([...MANAGEMENT_ONLY].sort(), [
    "commissions_invoicing",
    "complaints",
    "compliance_docs",
    "price_contract_changes",
    "unusual_deals",
  ]);
});
