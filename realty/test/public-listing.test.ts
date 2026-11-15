import assert from "node:assert/strict";
import { test } from "node:test";
import { PUBLIC_SITE_ORIGIN, publicListingUrl } from "../flow/live-crm.ts";
import { askBudgetLabel, scorePair } from "../flow/automatch.ts";
import { USD_TO_TTD, moneyWithTtd, shortMoney, ttdValue } from "../flow/fx.ts";
import { fitsOurListing, listingPriceLabel, listingTtd, type LiveRequest } from "../flow/live-match.ts";
import { crmSeamFromEnv } from "../node/crm-shared.ts";
import type { Listing } from "../flow/source.ts";

/**
 * A listing's public link (the owner's site rule, ported), and the TTD equivalent (price_ttd_equiv) used for matching a TTD
 * request. Invented rows and prices only; the CRM is a fake Supabase.
 */

const NOW = new Date("2026-11-14T12:00:00.000Z");

test("publicListingUrl: an active listing with a slug links to /property/slug", () => {
  assert.equal(publicListingUrl({ id: 5, slug: "test-flat-westmoorings", status: "active" }), `${PUBLIC_SITE_ORIGIN}/property/test-flat-westmoorings`);
  assert.equal(PUBLIC_SITE_ORIGIN, "https://1on1realtors.com");
});

test("publicListingUrl: no slug links to /listing/id", () => {
  assert.equal(publicListingUrl({ id: 202, slug: null, status: "active" }), `${PUBLIC_SITE_ORIGIN}/listing/202`);
  assert.equal(publicListingUrl({ id: 202, slug: "", status: "active" }), `${PUBLIC_SITE_ORIGIN}/listing/202`);
  assert.equal(publicListingUrl({ id: 202 }), `${PUBLIC_SITE_ORIGIN}/listing/202`, "no status column value at all counts as active");
});

test("publicListingUrl: pending is public", () => {
  assert.equal(publicListingUrl({ id: 9, slug: "pending-one", status: "pending" }), `${PUBLIC_SITE_ORIGIN}/property/pending-one`);
  assert.equal(publicListingUrl({ id: 9, slug: null, status: "PENDING" }), `${PUBLIC_SITE_ORIGIN}/listing/9`, "the status is read case-insensitively");
});

test("publicListingUrl: sold, withdrawn and other statuses are not public (null)", () => {
  for (const status of ["sold", "withdrawn", "rented", "let", "unavailable", "under offer"])
    assert.equal(publicListingUrl({ id: 3, slug: "gone", status }), null, status);
});

test("publicListingUrl: show_on_website false is not public, whatever the status", () => {
  assert.equal(publicListingUrl({ id: 4, slug: "hidden", status: "active", show_on_website: false }), null);
  assert.equal(publicListingUrl({ id: 4, slug: "hidden", status: "pending", show_on_website: false }), null);
});

test("publicListingUrl: only show_on_website false hides a listing; true, null or missing do not", () => {
  assert.equal(publicListingUrl({ id: 4, slug: "a", status: "active", show_on_website: true }), `${PUBLIC_SITE_ORIGIN}/property/a`);
  assert.equal(publicListingUrl({ id: 4, slug: "a", status: "active", show_on_website: null }), `${PUBLIC_SITE_ORIGIN}/property/a`);
  assert.equal(publicListingUrl({ id: 4, slug: "a", status: "active" }), `${PUBLIC_SITE_ORIGIN}/property/a`);
});

test("publicListingUrl: a blank status counts as active", () => {
  assert.equal(publicListingUrl({ id: 6, slug: "blank", status: "" }), `${PUBLIC_SITE_ORIGIN}/property/blank`);
  assert.equal(publicListingUrl({ id: 6, slug: "blank", status: null }), `${PUBLIC_SITE_ORIGIN}/property/blank`);
  assert.equal(publicListingUrl({ id: 6, slug: "blank", status: "   " }), `${PUBLIC_SITE_ORIGIN}/property/blank`);
});

/* ---- the CRM rows through the read-only seam ---- */

const ENV = {
  ONEON1_CRM_URL: "https://exampleproj.supabase.co",
  ONEON1_CRM_ANON_KEY: "dummy-anon",
  ONEON1_CRM_BOT_EMAIL: "bot@example.com",
  ONEON1_CRM_BOT_PASSWORD: "dummy-password",
};

const PROPERTIES = [
  // Our own page, from the slug. The CRM's url column is ignored now.
  { id: 301, title: "Slug flat", price: 9000, currency: "TTD", listing_type: "for-rent", city: "Westmoorings", property_type: "Residential", bedrooms: 2, status: "active", url: "https://other.example/x", slug: "slug-flat", show_on_website: true, price_ttd_equiv: null },
  // Sold: no link, and not active so not matched.
  { id: 302, title: "Sold flat", price: 9000, currency: "TTD", listing_type: "for-rent", city: "Westmoorings", property_type: "Residential", bedrooms: 2, status: "sold", slug: "sold-flat", show_on_website: true },
  // Active but hidden from the website: still active for matching, no link.
  { id: 303, title: "Hidden flat", price: 9000, currency: "TTD", listing_type: "for-rent", city: "Westmoorings", property_type: "Residential", bedrooms: 2, status: "active", slug: "hidden-flat", show_on_website: false },
  // USD listing with a TTD equivalent.
  { id: 304, title: "USD house", price: 250000, currency: "USD", listing_type: "for-sale", city: "Westmoorings", property_type: "Residential", bedrooms: 3, status: "active", slug: "usd-house", show_on_website: true, price_ttd_equiv: 1700000 },
];

function fakeCrm() {
  const tables: Record<string, Record<string, unknown>[]> = { properties: PROPERTIES, agents: [], property_agents: [], images: [], locations: [] };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/v1/token")) return Response.json({ access_token: "t", expires_in: 3600 });
    const m = new URL(url).pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m || (init?.method ?? "GET") !== "GET") return new Response("nope", { status: 405 });
    return Response.json(tables[m[1]] ?? []);
  }) as typeof fetch;
}

test("the CRM listings carry the public link (or none) and the TTD equivalent", async () => {
  const seam = crmSeamFromEnv(ENV, fakeCrm());
  const r = await seam.listings();
  assert.ok(r.status === "ok");
  const by = (id: string) => r.listings.find((l) => l.id === id)!;
  assert.equal(by("301").url, `${PUBLIC_SITE_ORIGIN}/property/slug-flat`, "the site's link, not the CRM url column");
  assert.equal(by("302").url, "", "sold: no link");
  assert.equal(by("302").status, "sold");
  assert.equal(by("303").url, "", "hidden from the website: no link");
  assert.equal(by("303").status, "active", "still active for matching");
  assert.equal(by("304").price, 250000);
  assert.equal(by("304").currency, "USD", "the original price and currency are kept");
  assert.equal(by("304").ttdEquiv, 1700000);
  assert.equal(by("301").ttdEquiv, null, "no price_ttd_equiv: null");
});

/* ---- price: everything is compared in TTD at the fixed rate (fx.ts) ---- */

const LISTING = (over: Partial<Listing>): Listing => ({
  id: "1", title: "A listing", listingType: "sale", area: "Westmoorings", price: 250000, currency: "USD", beds: 3, baths: 2, agentId: 7, status: "active", url: "", ttdEquiv: 1700000, ...over,
});
const SALE_TTD: LiveRequest = { intent: "buy", area: "Westmoorings", beds: 3, propertyType: "house", priceMin: null, priceMax: 1800000, currency: "TTD", monthly: false };
const SALE_USD: LiveRequest = { ...SALE_TTD, priceMax: 260000, currency: "USD" };

test("the fixed rate is one labelled constant, and money converts at it", () => {
  assert.equal(USD_TO_TTD, 6.78);
  assert.equal(ttdValue(250000, "USD"), 1695000);
  assert.equal(ttdValue(1700000, "TTD"), 1700000);
  assert.equal(shortMoney(1700000, "TTD"), "TT$1.7m");
  assert.equal(shortMoney(260000, "USD"), "US$260k");
  assert.equal(moneyWithTtd(500000, "USD"), "US$500k ≈ TT$3.39m");
  assert.equal(moneyWithTtd(500000, "USD", 3_400_000), "US$500k ≈ TT$3.4m", "the CRM's TTD equivalent wins when it has one");
});

test("a TTD request fits a USD listing on its TTD equivalent (price_ttd_equiv), or on the fixed rate without one", () => {
  assert.equal(fitsOurListing(SALE_TTD, LISTING({})), true, "TT$1.7m fits a TT$1.8m budget");
  assert.equal(fitsOurListing(SALE_TTD, LISTING({ ttdEquiv: null })), true, "no equivalent: US$250,000 at 6.78 is TT$1.695m, which fits");
  assert.equal(fitsOurListing(SALE_TTD, LISTING({ ttdEquiv: 2600000 })), false, "TT$2.6m is past the 20% band of TT$1.8m");
  assert.equal(listingTtd(LISTING({})), 1700000);
  assert.equal(listingTtd(LISTING({ ttdEquiv: null })), 1695000);
});

test("a USD request fits a TTD listing too: the budget converts to TTD", () => {
  assert.equal(fitsOurListing(SALE_USD, LISTING({})), true, "US$250,000 fits a US$260,000 budget");
  assert.equal(fitsOurListing(SALE_USD, LISTING({ currency: "TTD", price: 1700000, ttdEquiv: 1700000 })), true, "TT$1.7m fits US$260,000 (TT$1.76m)");
  assert.equal(fitsOurListing(SALE_USD, LISTING({ currency: "TTD", price: 3500000, ttdEquiv: 3500000 })), false, "TT$3.5m is past the band of US$260,000");
});

test("automatch scores a USD ask in TTD, and the reason and the budget keep the original currency", () => {
  const ask = { area: "Westmoorings", beds: 3, budget: 260000, currency: "USD" as const, type: "house", listingType: "sale" as const, lastSeenAt: NOW.toISOString() };
  const s = scorePair(ask, LISTING({}), { areaRelation: "same", now: NOW });
  assert.equal(s.parts.price, 25, "US$250,000 is TT$1.7m, within US$260,000 (TT$1.76m)");
  assert.match(s.reason, /US\$250k ≈ TT\$1\.7m within US\$260k ≈ TT\$1\.76m budget/);
  assert.equal(askBudgetLabel(260000, "USD"), "asked in US$ (US$260k ≈ TT$1.76m)");
  assert.equal(askBudgetLabel(1800000, "TTD"), "TT$1,800,000");
});

test("automatch scores a TTD ask on the TTD equivalent, and the reason says so", () => {
  const ask = { area: "Westmoorings", beds: 3, budget: 1800000, currency: "TTD" as const, type: "house", listingType: "sale" as const, lastSeenAt: NOW.toISOString() };
  const s = scorePair(ask, LISTING({}), { areaRelation: "same", now: NOW });
  assert.equal(s.parts.price, 25, "within the budget on the TTD equivalent");
  assert.match(s.reason, /TT\$1\.7m within TT\$1\.8m budget/);
  const dear = scorePair(ask, LISTING({ ttdEquiv: 1900000 }), { areaRelation: "same", now: NOW });
  assert.ok(dear.parts.price > 0 && dear.parts.price < 25, "a little over the budget on the TTD equivalent");
  assert.equal(scorePair(ask, LISTING({ price: 0 }), { areaRelation: "same", now: NOW }).parts.price, 0, "no price, no price points");
});

test("the price shown keeps the original price and currency, with the TTD equivalent for a US$ listing", () => {
  assert.equal(listingPriceLabel(LISTING({})), "US$250k ≈ TT$1.7m");
  assert.equal(listingPriceLabel(LISTING({ ttdEquiv: null })), "US$250k ≈ TT$1.7m", "the fixed rate when the CRM has no equivalent");
  assert.equal(listingPriceLabel(LISTING({ currency: "TTD", price: 1700000, ttdEquiv: 1700000 })), "TT$1,700,000");
  assert.equal(listingPriceLabel(LISTING({ price: 0 })), null, "no price, no label");
});
