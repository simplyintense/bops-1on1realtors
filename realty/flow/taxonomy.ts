import type { Inquiry, Lead, ListingType } from "./engine.ts";
import type { Listing } from "./source.ts";

/**
 * The enquiry taxonomy for reports: what kind of property and which channel. Anything we can't tell
 * stays null (counted as "unknown"), never guessed.
 */

export type PropertyKind = "rental" | "residential_sale" | "land" | "commercial";
export type EnquiryChannel = "whatsapp" | "facebook" | "instagram" | "website" | "phone" | "referral";

const LAND = /\b(land|lots?|acres?|acreage|parcels?)\b/i;
const COMMERCIAL = /\b(commercial|offices?|warehouses?|retail|industrial|shops?)\b/i;
const RENT = /^(for[- ]?rent|rent|rental)$/i;
const SALE = /\b(sale|sell|selling)\b/i;

/**
 * The CRM's listing type and property type as a PropertyKind. Land and commercial win over rent/sale.
 * Returns null when neither says anything (no listing type, or one that is neither rent nor sale-like).
 */
export function propertyKindFromCrm(listingType: string | null | undefined, propertyType: string | null | undefined): PropertyKind | null {
  const type = propertyType ?? "";
  if (LAND.test(type)) return "land";
  if (COMMERCIAL.test(type)) return "commercial";
  const lt = (listingType ?? "").trim();
  if (RENT.test(lt)) return "rental";
  if (SALE.test(lt)) return "residential_sale";
  return null;
}

export function listingTypeFromKind(kind: PropertyKind): ListingType {
  return kind === "rental" ? "rent" : "sale";
}

const HINTS: [EnquiryChannel, RegExp][] = [
  ["facebook", /\b(facebook|fb|messenger)\b/i],
  ["instagram", /\b(instagram|insta|ig)\b/i],
  ["whatsapp", /\bwhats\s?app\b/i],
  // Not bare "call"/"phone": "call me back" or "my phone is" in a web form doesn't make it a phone lead.
  ["phone", /^\s*phone\s*$|\b(phone call|telephone|phoned in|called in)\b/i],
  ["referral", /\b(referral|referred)\b/i],
  ["website", /\b(website|web form|contact form)\b/i],
];

/**
 * The channel from Inquiry.source, unless the hint (a CRM source string or free text) names exactly
 * one channel; two or more named is ambiguous and the hint is ignored.
 */
export function channelFromSource(source: Inquiry["source"], hint?: string | null): EnquiryChannel | null {
  if (hint) {
    const named = HINTS.filter(([, re]) => re.test(hint));
    if (named.length === 1) return named[0][0];
  }
  if (source === "website_contact" || source === "property_inquiry") return "website";
  if (source === "whatsapp") return "whatsapp";
  return null;
}

export function enquiryChannel(inquiry: Inquiry): EnquiryChannel | null {
  return inquiry.channel ?? channelFromSource(inquiry.source);
}

/** The inquiry's own kind, else its listing's, else from listingType. Null when none of those is known. */
export function enquiryKind(inquiry: Inquiry, listing?: Listing | null): PropertyKind | null {
  return inquiry.propertyKind ?? listing?.propertyKind ?? propertyKindFromCrm(inquiry.listingType, null);
}

export type EnquiryTally = {
  kind: Record<PropertyKind | "unknown", number>;
  channel: Record<EnquiryChannel | "unknown", number>;
};

/** Counts by kind and channel for the daily/weekly report. Listings (optional) resolve kind by listingId. */
export function enquiryTally(leads: Pick<Lead, "inquiry">[], listings: Listing[] = []): EnquiryTally {
  const tally: EnquiryTally = {
    kind: { rental: 0, residential_sale: 0, land: 0, commercial: 0, unknown: 0 },
    channel: { whatsapp: 0, facebook: 0, instagram: 0, website: 0, phone: 0, referral: 0, unknown: 0 },
  };
  for (const { inquiry } of leads) {
    const listing = listings.find((l) => l.id === inquiry.listingId);
    tally.kind[enquiryKind(inquiry, listing) ?? "unknown"]++;
    tally.channel[enquiryChannel(inquiry) ?? "unknown"]++;
  }
  return tally;
}
