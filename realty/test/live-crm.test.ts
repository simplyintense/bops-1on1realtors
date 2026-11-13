import assert from "node:assert/strict";
import { test } from "node:test";
import { crmSourceFromEnv, LiveCrmSource } from "../flow/live-crm.ts";
import { missingListingFields } from "../flow/listing-audit.ts";
import { chooseAgent } from "../flow/route.ts";
import { FixtureCrm } from "../flow/source.ts";
import { loadFixtureCrm } from "../node/jsonl.ts";

/**
 * The read-only live CRM adapter against a fake Supabase (auth + PostgREST GETs). The fetch global is
 * replaced with one that throws, so only the injected fetcher is ever used and nothing reaches a network.
 * Dummy credentials only; nothing here prints a header or body.
 */

const ENV = {
  ONEON1_CRM_URL: "https://exampleproj.supabase.co",
  ONEON1_CRM_ANON_KEY: "dummy-anon",
  ONEON1_CRM_BOT_EMAIL: "bot@example.com",
  ONEON1_CRM_BOT_PASSWORD: "dummy-password",
  ONEON1_CRM_WRITES: "1", // must make no difference: this path never writes
};
const BASE = "https://exampleproj.supabase.co";
const TOKEN_URL = `${BASE}/auth/v1/token?grant_type=password`;

const offline = () => {
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("no network in tests");
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
};

const TABLES: Record<string, Record<string, unknown>[]> = {
  agents: [
    { id: 7, name: "Dana Listing", email: "dana@example.com", phone: "+1 868 555 0107" },
    { id: 8, name: "Eli Nolistings", email: "eli@example.com", phone: null },
  ],
  properties: [
    {
      id: 101, title: "Woodbrook 2-bed", price: "9500", currency: "TTD", listing_type: "for-rent",
      furnished_status: "Fully furnished", address: "12 Tragarete Rd", city: "Port of Spain", region: "North",
      property_type: "Apartment", bedrooms: 2, bathrooms: 2, square_feet: 1100, lot_size: null,
      features: "Parking, AC, water tank", url: "https://example.com/p/101", google_maps_url: null,
      neighborhood: "Woodbrook", hoa_fees: 500, property_taxes: null, status: "Available",
    },
    {
      id: 102, title: "Sparse listing", price: null, currency: "USD", listing_type: "sale",
      furnished_status: null, address: null, city: null, region: "Central",
      property_type: null, bedrooms: null, bathrooms: null, square_feet: null, lot_size: null,
      features: null, url: null, google_maps_url: null, neighborhood: null, hoa_fees: null, property_taxes: null, status: "Sold",
    },
    {
      id: 103, title: "Acre in Arima", price: 300000, currency: "TTD", listing_type: null,
      furnished_status: null, address: null, city: "Arima", region: null, property_type: "Land",
      bedrooms: null, bathrooms: null, square_feet: null, lot_size: "1 acre", features: null, url: null,
      google_maps_url: null, neighborhood: null, hoa_fees: null, property_taxes: null, status: "off-market",
    },
    {
      id: 104, title: "No type, residential", price: 1, currency: "TTD", listing_type: "", property_type: "House",
      city: "Chaguanas", status: "active",
    },
  ],
  property_agents: [
    { property_id: 101, agent_id: 7 },
    { property_id: 102, agent_id: 7 },
    { property_id: 101, agent_id: 8 }, // second link: the first one wins
  ],
  images: [{ property_id: 101 }, { property_id: 101 }, { property_id: 101 }, { property_id: 103 }],
  locations: [{ property_id: 103, address: "Lot 4, Arima Old Rd", google_maps_url: "https://maps.example.com/103" }],
  property_inquiries: [
    { id: "aaaaaaaa-0000-0000-0000-000000000001", property_id: 101, name: "Pat Renter", email: "pat@example.com", phone: "+1 868 555 0201", message: "Is it still available?", created_at: "2026-11-12T10:00:00Z" },
    { id: "aaaaaaaa-0000-0000-0000-000000000002", property_id: 999, name: "Lou Orphan", email: null, phone: null, message: "Saw this on Facebook", created_at: "2026-11-12T12:00:00Z" },
  ],
  contact_submissions: [
    { id: "bbbbbbbb-0000-0000-0000-000000000001", name: "Kim General", email: "kim@example.com", phone: null, message: "Looking for a house to buy", created_at: "2026-11-12T11:00:00Z" },
  ],
};

type Call = { method: string; url: string; headers: Record<string, string> };

function fakeCrm(opts: { refuse?: string[]; authStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, headers: { ...(init?.headers as Record<string, string>) } });
    if (url === TOKEN_URL && method === "POST") {
      if (opts.authStatus) return new Response("{}", { status: opts.authStatus });
      return Response.json({ access_token: "t", expires_in: 3600 });
    }
    const u = new URL(url);
    const m = u.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m || method !== "GET") return new Response("nope", { status: 405 });
    const table = m[1];
    if (opts.refuse?.includes(table)) return new Response("denied", { status: 403 });
    let rows = TABLES[table] ?? [];
    if (u.searchParams.get("deleted_at") === "is.null") rows = rows.filter((r) => r.deleted_at == null);
    const off = Number(u.searchParams.get("offset") ?? 0);
    const lim = Number(u.searchParams.get("limit") ?? 1000);
    return Response.json(rows.slice(off, off + lim));
  }) as typeof fetch;
  return { fetcher, calls };
}

function assertReadOnly(calls: Call[]) {
  assert.ok(calls.length > 0);
  for (const c of calls) {
    if (c.method === "POST") assert.equal(c.url, TOKEN_URL, "the only POST allowed is the sign-in");
    else assert.equal(c.method, "GET");
    assert.ok(!["PATCH", "PUT", "DELETE"].includes(c.method));
    if (c.url.includes("/rest/v1/")) {
      assert.equal(c.method, "GET");
      assert.equal(c.headers.authorization, "Bearer t");
      assert.ok(c.headers.apikey, "apikey header present");
    }
  }
}

test("factory: no or incomplete CRM env gives the fixture CRM", async () => {
  const restore = offline();
  try {
    for (const env of [{}, { ...ENV, ONEON1_CRM_BOT_PASSWORD: "" }, { ...ENV, ONEON1_CRM_URL: "https://evil.example.com" }]) {
      const src = crmSourceFromEnv(env, undefined, () => loadFixtureCrm());
      assert.ok(src instanceof FixtureCrm);
      assert.equal((await src.agents())[0].name, "Ava Sample");
    }
  } finally {
    restore();
  }
});

test("factory: a full CRM env gives the live source, reading through the injected fetcher only", async () => {
  const restore = offline();
  try {
    const { fetcher, calls } = fakeCrm();
    const src = crmSourceFromEnv(ENV, fetcher);
    assert.ok(src instanceof LiveCrmSource);
    assert.equal((await src.agents()).length, 2);
    assertReadOnly(calls);
  } finally {
    restore();
  }
});

test("listings map from properties, property_agents, images and locations", async () => {
  const restore = offline();
  try {
    const { fetcher, calls } = fakeCrm();
    const listings = await crmSourceFromEnv(ENV, fetcher).listings();
    assert.deepEqual(listings.map((l) => l.id), ["101", "102", "103"], "104 has no usable type and isn't land/commercial: skipped");

    const full = listings[0];
    assert.equal(full.listingType, "rent");
    assert.equal(full.propertyKind, "rental");
    assert.equal(full.area, "Woodbrook");
    assert.equal(full.price, 9500);
    assert.equal(full.currency, "TTD");
    assert.equal(full.beds, 2);
    assert.equal(full.agentId, 7);
    assert.equal(full.status, "active");
    assert.equal(full.address, "12 Tragarete Rd");
    assert.equal(full.fees, 500);
    assert.equal(full.squareFeet, 1100);
    assert.equal(full.furnishing, "Fully furnished");
    assert.deepEqual(full.amenities, ["Parking, AC, water tank"]);
    assert.equal(full.photoCount, 3);
    assert.equal(full.viewingArrangements, null);
    assert.deepEqual(missingListingFields(full), ["viewing_arrangements"]);

    const sparse = listings[1];
    assert.equal(sparse.listingType, "sale");
    assert.equal(sparse.propertyKind, "residential_sale");
    assert.equal(sparse.area, "Central");
    assert.equal(sparse.currency, "USD");
    assert.equal(sparse.status, "sold");
    assert.equal(sparse.beds, 0);
    assert.equal(sparse.fees, null);
    assert.equal(sparse.photoCount, 0);
    assert.deepEqual(missingListingFields(sparse), [
      "exact_location_directions", "price_rent_and_fees", "size_beds_baths",
      "utilities_parking_amenities", "furnishing", "viewing_arrangements", "photos",
    ]);

    const land = listings[2];
    assert.equal(land.listingType, "sale");
    assert.equal(land.propertyKind, "land");
    assert.equal(land.status, "withdrawn");
    assert.equal(land.agentId, 0, "no property_agents row");
    assert.equal(land.address, "Lot 4, Arima Old Rd", "falls back to locations.address");
    assert.equal(land.directions, "https://maps.example.com/103");
    assert.equal(land.lotSize, "1 acre");
    assert.equal(land.photoCount, 1);
    assert.ok(!missingListingFields(land).includes("size_beds_baths"));

    // Reads only the catalog's columns.
    const propCall = calls.find((c) => c.url.includes("/rest/v1/properties?"))!;
    assert.ok(new URL(propCall.url).searchParams.get("select")!.split(",").includes("google_maps_url"));
    assertReadOnly(calls);
  } finally {
    restore();
  }
});

test("agents get areas and listing types from their properties; no listings means both types, no areas", async () => {
  const restore = offline();
  try {
    const { fetcher, calls } = fakeCrm();
    const agents = await crmSourceFromEnv(ENV, fetcher).agents();
    const dana = agents.find((a) => a.id === 7)!;
    assert.equal(dana.name, "Dana Listing");
    assert.equal(dana.email, "dana@example.com");
    assert.deepEqual(new Set(dana.areas), new Set(["Port of Spain", "Woodbrook", "North", "Central"]));
    assert.deepEqual(new Set(dana.listingTypes), new Set(["rent", "sale"]));
    const eli = agents.find((a) => a.id === 8)!;
    assert.equal(eli.phone, null);
    assert.deepEqual(eli.areas, []);
    assert.deepEqual(eli.listingTypes, ["sale", "rent"]);
    assertReadOnly(calls);
  } finally {
    restore();
  }
});

test("inquiries from both tables, linked to listings, in time order, deleted rows filtered", async () => {
  const restore = offline();
  try {
    const { fetcher, calls } = fakeCrm();
    const inquiries = await crmSourceFromEnv(ENV, fetcher).inquiries();
    assert.deepEqual(inquiries.map((i) => i.name), ["Pat Renter", "Kim General", "Lou Orphan"]);

    const [pat, kim, lou] = inquiries;
    assert.equal(pat.source, "property_inquiry");
    assert.equal(pat.ref, "aaaaaaaa-0000-0000-0000-000000000001");
    assert.equal(pat.listingId, "101");
    assert.equal(pat.listingType, "rent");
    assert.equal(pat.area, "Woodbrook");
    assert.equal(pat.beds, 2);
    assert.equal(pat.propertyKind, "rental");
    assert.equal(pat.channel, "website");
    assert.equal(pat.budget, null);

    assert.equal(kim.source, "website_contact");
    assert.equal(kim.listingId, null);
    assert.equal(kim.listingType, null);
    assert.equal(kim.area, null);
    assert.equal(kim.beds, null);
    assert.equal(kim.propertyKind, null);
    assert.equal(kim.channel, "website");

    assert.equal(lou.listingId, "999", "listing not in the CRM read: kept as the id, no listing details");
    assert.equal(lou.listingType, null);
    assert.equal(lou.channel, "facebook", "the message names exactly one channel");

    for (const t of ["property_inquiries", "contact_submissions"]) {
      const c = calls.find((x) => x.url.includes(`/rest/v1/${t}?`))!;
      assert.equal(new URL(c.url).searchParams.get("deleted_at"), "is.null");
    }
    assertReadOnly(calls);
  } finally {
    restore();
  }
});

test("routing copes with a listing that has no agent (agentId 0)", async () => {
  const restore = offline();
  try {
    const { fetcher } = fakeCrm();
    const src = crmSourceFromEnv(ENV, fetcher);
    const [agents, listings] = await Promise.all([src.agents(), src.listings()]);
    const land = listings.find((l) => l.id === "103")!;
    const pick = chooseAgent(
      { ref: "x", source: "property_inquiry", name: "N", phone: null, email: null, listingId: "103", listingType: "sale", area: null, budget: null, beds: null, message: "" },
      agents, listings, () => 0, [],
    );
    assert.equal(land.agentId, 0);
    // No listing agent: falls through to the covering agents (both cover sale with area null), least loaded first.
    assert.equal(pick.agent?.id, 7);
    assert.match(pick.reason, /covers any area/);
  } finally {
    restore();
  }
});

test("a refused table is empty and named in missing; the rest still loads", async () => {
  const restore = offline();
  try {
    const { fetcher, calls } = fakeCrm({ refuse: ["images", "contact_submissions"] });
    const src = crmSourceFromEnv(ENV, fetcher) as LiveCrmSource;
    const listings = await src.listings();
    assert.equal(listings.length, 3);
    assert.ok(listings.every((l) => l.photoCount === 0));
    const inquiries = await src.inquiries();
    assert.deepEqual(inquiries.map((i) => i.source), ["property_inquiry", "property_inquiry"]);
    assert.deepEqual([...src.missing].sort(), ["contact_submissions", "images"]);
    assertReadOnly(calls);
  } finally {
    restore();
  }
});

test("sign-in refused: throws instead of returning an empty CRM", async () => {
  const restore = offline();
  try {
    const { fetcher, calls } = fakeCrm({ authStatus: 400 });
    const src = crmSourceFromEnv(ENV, fetcher);
    await assert.rejects(src.listings(), /couldn't sign in/);
    await assert.rejects(src.inquiries(), /couldn't sign in/);
    assert.ok(calls.every((c) => c.url === TOKEN_URL));
  } finally {
    restore();
  }
});
