import assert from "node:assert/strict";
import test from "node:test";
import { contactLinks } from "../flow/listing-contact.ts";
import { parseMatch } from "../flow/recommendations.ts";

/** A match with the `listing` object tt-market-search returns from match_buyer, score_matches and match_requests. */
function withListing(listing: Record<string, unknown>, root: Record<string, unknown> = {}) {
  return { listing_ref: "mybunchofkeys:77", reason: "fits the budget", route_to: "unassigned", listing, ...root };
}

/** The contact links a desk row or market popup would build from a parsed match. */
function linksOf(item: { agentPhone?: string | null; agentWhatsapp?: string | null; agentEmail?: string | null }, text = "Hi") {
  return contactLinks({ phone: item.agentPhone, whatsapp: item.agentWhatsapp, email: item.agentEmail }, text);
}

test("the listing object gives title, area, price_text, beds, type, url, agent and agency", () => {
  const m = parseMatch(
    withListing({
      title: "Modern townhouse, Diego Martin",
      area: "Diego Martin",
      price: 1700000,
      currency: "TTD",
      price_text: "TT$1,700,000",
      beds: 3,
      baths: 2,
      listing_type: "sale",
      property_class: "townhouse",
      url: "https://mybunchofkeys.com/property/modern-townhouse/",
      agent: "Ravi Test",
      agency: "MyBunchOfKeys Realty",
      agent_phone: "+18687660211",
      agent_whatsapp: "+18687660211",
      agent_email: "ravi@example.com",
    }),
  );
  assert.ok(m);
  const i = m.item;
  assert.equal(i.title, "Modern townhouse, Diego Martin");
  assert.equal(i.url, "https://mybunchofkeys.com/property/modern-townhouse/");
  assert.equal(i.area, "Diego Martin");
  assert.equal(i.price, "TT$1,700,000");
  assert.equal(i.beds, 3);
  assert.equal(i.listingType, "sale");
  assert.equal(i.propertyClass, "townhouse");
  assert.equal(i.agent, "Ravi Test");
  assert.equal(i.agency, "MyBunchOfKeys Realty");
  assert.equal(i.agentPhone, "+18687660211");
  assert.equal(i.agentWhatsapp, "+18687660211");
  assert.equal(i.agentEmail, "ravi@example.com");
  assert.equal(m.routed, false);
});

test("without price_text the price is formatted from price and currency, as before", () => {
  const m = parseMatch(withListing({ title: "Flat", price: 8500, currency: "TTD" }));
  assert.equal(m?.item.price, "TT$8,500");
  const usd = parseMatch(withListing({ title: "Flat", price: 1200, currency: "USD" }));
  assert.equal(usd?.item.price, "US$1,200");
});

test("the listing object's title wins over the root title and the url's slug", () => {
  const m = parseMatch(
    withListing(
      { title: "From the listing", url: "https://mybunchofkeys.com/property/some-other-slug-words-here/" },
      { title: "Root title", url: "https://example.com/root" },
    ),
  );
  assert.equal(m?.item.title, "From the listing");
  assert.equal(m?.item.url, "https://mybunchofkeys.com/property/some-other-slug-words-here/");
});

test("MyBunchOfKeys-style listing: phone and WhatsApp, no email: Call and WhatsApp, no Email", () => {
  const m = parseMatch(
    withListing({
      title: "West park villa",
      agent: "Ravi Test",
      agency: "MyBunchOfKeys Realty",
      agent_phone: "+1868 766 0211",
      agent_whatsapp: "+1868 766 0211",
    }),
  );
  const links = linksOf(m!.item);
  assert.equal(m?.item.agentEmail ?? null, null);
  assert.equal(links.tel, "tel:+18687660211");
  assert.equal(links.whatsapp, "https://wa.me/18687660211?text=Hi");
  assert.equal(links.mail, null);
});

test("RE/MAX-style listing: phone and email, no WhatsApp: WhatsApp falls back to the phone", () => {
  const m = parseMatch(
    withListing({
      title: "Chaguanas house",
      agency: "RE/MAX Trinidad",
      agent_phone: "766-0211",
      agent_email: "agent@remax.example",
    }),
  );
  const links = linksOf(m!.item);
  assert.equal(m?.item.agentWhatsapp ?? null, null);
  assert.equal(links.tel, "tel:+18687660211");
  assert.equal(links.whatsapp, "https://wa.me/18687660211?text=Hi");
  assert.equal(links.mail, "mailto:agent@remax.example");
});

test("a listing with only an email gives an Email link and no Call or WhatsApp", () => {
  const m = parseMatch(withListing({ title: "Lot", agent_email: "info@agency.example" }));
  const links = linksOf(m!.item);
  assert.equal(links.tel, null);
  assert.equal(links.whatsapp, null);
  assert.equal(links.mail, "mailto:info@agency.example");
});

test("a listing with no contact fields gives no links and nothing shown as undefined", () => {
  const m = parseMatch(withListing({ title: "Bare listing", price: 900000, currency: "TTD" }));
  const i = m!.item;
  assert.equal(i.agent ?? null, null);
  assert.equal(i.agency ?? null, null);
  assert.deepEqual(linksOf(i), { phoneText: null, tel: null, whatsapp: null, email: null, mail: null });
  assert.doesNotMatch(JSON.stringify(m), /undefined/);
});

test("an older hit with no listing object still parses: root fields and recommended_contact fall back", () => {
  const m = parseMatch({
    listing_ref: "remax:002022090047",
    reason: "in Chaguanas",
    route_to: "unassigned",
    recommended_contact: {
      url: "https://www.remax-caribbeanislands.com/002022090047",
      agency: "RE/MAX Trinidad",
      whatsapp: "+1868 766 0211",
      email: "agent@remax.example",
    },
  });
  assert.equal(m?.item.title, "remax:002022090047");
  assert.equal(m?.item.url, "https://www.remax-caribbeanislands.com/002022090047");
  assert.equal(m?.item.agency, "RE/MAX Trinidad");
  assert.equal(m?.item.agentWhatsapp, "+1868 766 0211");
  assert.equal(m?.item.agentEmail, "agent@remax.example");
  assert.equal(m?.item.agentPhone ?? null, null);
  assert.equal(m?.item.price, null);
});

test("recommended_contact's phone is not used as a Call number (only the listing's own phone is)", () => {
  const m = parseMatch({
    listing_ref: "x:1",
    reason: "fits",
    route_to: "unassigned",
    recommended_contact: { url: "https://example.com/l/1", phone: "868-555-0000" },
  });
  assert.equal(m?.item.agentPhone ?? null, null);
  assert.doesNotMatch(JSON.stringify(m), /868-555-0000/);
});

test("a bad email on the listing is dropped, not replaced by the root one", () => {
  const m = parseMatch(withListing({ title: "Lot", agent_email: "not-an-email" }, { email: "fallback@example.com" }));
  assert.equal(m?.item.agentEmail ?? null, null);
});
