import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SAMPLE_CHAT, SAMPLE_MESSAGES, sampleEnvelope } from "../fixtures/whatsapp-samples.ts";
import { ExactAreaFallback, MemoryAreaResolver } from "../flow/areas.ts";
import { CRM_UNREACHABLE_TEXT, liveCrmSeam, NOT_CONNECTED, toMatchListing } from "../flow/crm-seam.ts";
import { SITE_LISTING_URL } from "../flow/live-crm.ts";
import { liveDesk, matchOurListings, type LiveEntry, type LiveRequest } from "../flow/live-match.ts";
import { recommendationsFor } from "../flow/recommendations.ts";
import type { Listing } from "../flow/source.ts";
import { crmSeamFromEnv } from "../node/crm-shared.ts";
import { handleWebhook, setConsent } from "../node/periskope-intake.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { fakeCaller } from "./desk-fakes.ts";

/**
 * Our own CRM listings in live matching: the read-only CRM seam (sign-in, GETs only, fail closed), the matching rules
 * for our listings, the holder on each match, and who sees what on the desk. A fake Supabase only; dummy credentials.
 */

const ENV = {
  ONEON1_CRM_URL: "https://exampleproj.supabase.co",
  ONEON1_CRM_ANON_KEY: "dummy-anon",
  ONEON1_CRM_BOT_EMAIL: "bot@example.com",
  ONEON1_CRM_BOT_PASSWORD: "dummy-password",
  ONEON1_CRM_WRITES: "1", // must make no difference: nothing here writes
};
const TOKEN_URL = "https://exampleproj.supabase.co/auth/v1/token?grant_type=password";

const TABLES: Record<string, Record<string, unknown>[]> = {
  agents: [
    { id: 7, name: "Dana Holder", email: "Dana@1on1.example", phone: "868 555 0107" },
    { id: 8, name: "Eli Nophone", email: "eli@1on1.example", phone: null },
  ],
  properties: [
    { id: 201, title: "Westmoorings 2-bed apartment", price: "8500", currency: "TTD", listing_type: "for-rent", city: "Westmoorings", property_type: "Residential", bedrooms: 2, status: "active", url: null, slug: "westmoorings-2bed-residential-for-rent-201" },
    { id: 202, title: "Diego Martin townhouse", price: 1700000, currency: "TTD", listing_type: "for-sale", city: "Diego Martin", property_type: "Residential", bedrooms: 3, status: "active", url: "https://1on1realtors.com/listing/202" },
  ],
  property_agents: [{ property_id: 201, agent_id: 7 }],
};

function fakeSupabase(o: { authStatus?: number } = {}) {
  const calls: { method: string; url: string }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (url === TOKEN_URL && method === "POST") return o.authStatus ? new Response("{}", { status: o.authStatus }) : Response.json({ access_token: "t", expires_in: 3600 });
    const m = new URL(url).pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (!m || method !== "GET") return new Response("nope", { status: 405 });
    return Response.json(TABLES[m[1]] ?? []);
  }) as typeof fetch;
  return { fetcher, calls };
}

const listing = (over: Partial<Listing>): Listing => ({
  id: "1", title: "A listing", listingType: "rent", area: "Westmoorings", price: 9000, currency: "TTD", beds: 2, baths: 1, agentId: 7, status: "active", url: "https://1on1realtors.com/property/a", ...over,
});
const RENT: LiveRequest = { intent: "rent", area: "Westmoorings", beds: 2, propertyType: "apartment", priceMin: null, priceMax: 9000, currency: "TTD", monthly: true };
const AREAS = new MemoryAreaResolver([
  { name: "Westmoorings", region: "North West", neighbours: ["Glencoe", "Diego Martin"] },
  { name: "Glencoe", region: "North West", neighbours: ["Westmoorings"] },
  { name: "Diego Martin", region: "North West", neighbours: ["Westmoorings"] },
  { name: "Maraval", region: "North West" },
  { name: "Chaguanas", region: "Central" },
]);

test("the CRM seam reads listings and agents with GETs only, signs in once, and links slug-only rows to 1on1realtors.com", async () => {
  const { fetcher, calls } = fakeSupabase();
  const seam = crmSeamFromEnv(ENV, fetcher);
  assert.equal(seam.connected, true);
  const l = await seam.listings();
  assert.ok(l.status === "ok");
  assert.equal(l.listings.length, 2);
  assert.equal(l.listings.find((x) => x.id === "201")?.url, `${SITE_LISTING_URL}westmoorings-2bed-residential-for-rent-201`);
  assert.equal(l.listings.find((x) => x.id === "202")?.url, "https://1on1realtors.com/listing/202");
  assert.equal(l.listings.find((x) => x.id === "201")?.agentId, 7);
  assert.equal(l.listings.find((x) => x.id === "202")?.agentId, 0, "no property_agents row: no holder");
  assert.deepEqual(await seam.agents(), [
    { id: 7, email: "dana@1on1.example", phone: "+18685550107" },
    { id: 8, email: "eli@1on1.example", phone: null },
  ]);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1, "one sign-in, the session is reused");
  for (const c of calls) assert.ok(c.method === "GET" || c.url === TOKEN_URL, `${c.method} ${c.url}`);
});

test("fail closed: a CRM that refuses sign-in is 'not connected' with no agents, never a throw; no settings is NOT_CONNECTED", async () => {
  const seam = crmSeamFromEnv(ENV, fakeSupabase({ authStatus: 500 }).fetcher);
  assert.deepEqual(await seam.listings(), { status: "not-connected", text: CRM_UNREACHABLE_TEXT });
  assert.deepEqual(await seam.agents(), []);
  assert.equal(crmSeamFromEnv({}), NOT_CONNECTED);
  const broken = liveCrmSeam({ listings: () => Promise.reject(new Error("down")), agents: () => Promise.reject(new Error("down")) });
  assert.equal((await broken.listings()).status, "not-connected");
  assert.deepEqual(await broken.agents(), []);
});

test("our listings match by the co-broke rules: rent vs sale, same or nearby area, price within 20%, beds within one, kind of place", async () => {
  const listings = [
    listing({ id: "same", price: 8500 }),
    listing({ id: "near", area: "Glencoe", price: 10_500, beds: 3 }),
    listing({ id: "region-only", area: "Maraval" }),
    listing({ id: "other-island", area: "Chaguanas" }),
    listing({ id: "too-dear", price: 11_000 }),
    listing({ id: "usd", currency: "USD", price: 2000 }),
    listing({ id: "sale", listingType: "sale" }),
    listing({ id: "beds", beds: 4 }),
    listing({ id: "land", propertyKind: "land" }),
    listing({ id: "sold", status: "sold" }),
    listing({ id: "unheld", price: 7000, agentId: 0 }),
  ];
  const got = await matchOurListings(RENT, listings, AREAS);
  assert.deepEqual(got.map((m) => m.title && m.reason && m.source), got.map(() => "1on1 Realtors"));
  assert.equal(got.length, 3);
  assert.match(got[0].reason ?? "", /^in Westmoorings, TT\$7,000 for a TT\$9,000 budget, 2 bed, our listing$/);
  assert.match(got[1].reason ?? "", /^in Westmoorings, TT\$8,500/);
  assert.match(got[2].reason ?? "", /^Glencoe, near Westmoorings, TT\$10,500 for a TT\$9,000 budget, 3 bed/);
  assert.deepEqual(got.map((m) => m.holder), [null, 7, 7], "same area first, cheapest first; holder kept, null with no agent");
  assert.equal(got[1].price, "TT$8,500");
  assert.doesNotMatch(JSON.stringify(got), /score|grade/);
  assert.deepEqual(await matchOurListings({ ...RENT, intent: null }, listings, AREAS), []);
  assert.deepEqual(await matchOurListings({ ...RENT, area: null }, listings, AREAS), []);
  // With no area directory, only the same name matches.
  assert.equal((await matchOurListings(RENT, listings, new ExactAreaFallback())).length, 2);
});

function world(ours: { listings: () => Promise<Listing[]> } | null) {
  const root = mkdtempSync(join(tmpdir(), "crm-match-"));
  const KEY = "k";
  const opts = { root, env: { PERISKOPE_SIGNING_KEY: KEY }, now: () => new Date("2026-11-14T04:00:00Z"), crm: null, ours, market: fakeCaller({ match_buyer: { matches: [] } }).caller, fetch: (async () => { throw new Error("no network"); }) as typeof fetch };
  const post = (payload: unknown) => {
    const raw = Buffer.from(JSON.stringify(payload));
    return handleWebhook(raw, createHmac("sha256", KEY).update(raw).digest("hex"), opts);
  };
  const consent = () => setConsent({ chatId: SAMPLE_CHAT, groupName: "g", noticePostedAt: "2026-11-01T00:00:00Z", adminOkBy: "Office admin", adminOkAt: "2026-11-01T00:00:00Z", active: true }, opts);
  return { post, consent, store: () => new PeriskopeStore(root) };
}

test("on arrival a WhatsApp request is matched against our CRM listings too, each match with its holder", async () => {
  const w = world({ listings: async () => [listing({ id: "201", title: "Westmoorings 2-bed apartment", price: 8500 })] });
  await w.consent();
  const r = await w.post(sampleEnvelope(SAMPLE_MESSAGES[0]));
  assert.equal(r.body.ours, 1);
  const [row] = w.store().live();
  assert.equal(row.ours?.[0].title, "Westmoorings 2-bed apartment");
  assert.equal(row.ours?.[0].holder, 7);
});

test("fail closed on arrival: our listings unreadable means no matches of ours, and the request is still taken", async () => {
  const w = world({ listings: () => Promise.reject(new Error("CRM down")) });
  await w.consent();
  const r = await w.post(sampleEnvelope(SAMPLE_MESSAGES[0]));
  assert.equal(r.status, 200);
  assert.equal(r.body.ours, 0);
  assert.equal(w.store().live().length, 1);
});

test("the desk: the holder gets the match on their listing; the requester gets theirs; unheld and unassigned are owners only", () => {
  const mk = (id: string, phone: string, ours: { holder: number | null }[]): LiveEntry => ({
    messageId: id, senderPhone: phone, receivedAt: "2026-11-14T03:00:00Z", request: RENT, status: "matched", matches: [],
    ours: ours.map((o, i) => ({ title: `${id}-ours-${i}`, url: null, area: "Westmoorings", price: null, beds: 2, source: "1on1 Realtors", reason: "r", holder: o.holder })),
  });
  const rows = [
    mk("from-outside", "+18685550199", [{ holder: 7 }, { holder: null }]),
    mk("from-eli", "+18685550108", [{ holder: 7 }]),
  ];
  const agents = [
    { id: 7, email: "dana@1on1.example", phone: "+18685550107" },
    { id: 8, email: "eli@1on1.example", phone: "+18685550108" },
  ];
  const dana = liveDesk({ email: "dana@1on1.example", owner: false, agents, rows });
  assert.deepEqual(dana.onListings.flatMap((c) => c.ours.map((m) => m.title)), ["from-outside-ours-0", "from-eli-ours-0"]);
  assert.equal(dana.unassigned, null);
  assert.equal(dana.unheld, null);
  assert.doesNotMatch(JSON.stringify(dana), /ours-1|\+1868/, "no unheld match and no phone in a non-owner's view");

  const eli = liveDesk({ email: "eli@1on1.example", owner: false, agents, rows });
  assert.ok(eli.yours.status === "ok" && eli.yours.phoneKnown && eli.yours.cards.length === 1);
  assert.deepEqual(eli.onListings, []);
  assert.doesNotMatch(JSON.stringify(eli), /from-outside/, "an unassigned request never reaches a non-owner");

  const owner = liveDesk({ email: "miles@1on1.example", owner: true, agents, rows });
  assert.equal(owner.unassigned?.length, 1, "only the request from a number that isn't an agent");
  assert.deepEqual(owner.unheld?.flatMap((c) => c.ours.map((m) => m.title)), ["from-outside-ours-1"]);
});

test("the market's requests against our listings: holder_agent_id is sent, an agent sees only their own, owners see all", async () => {
  const listings = [listing({ id: "201" }), listing({ id: "202", agentId: 0, listingType: "sale", propertyKind: "land", price: 0 })].map(toMatchListing);
  assert.deepEqual(listings[0], { id: "oneonone:201", ref: "oneonone:201", title: "A listing", listing_type: "rent", agency: "1on1 Realtors", currency: "TTD", url: "https://1on1realtors.com/property/a", area: "Westmoorings", beds: 2, price: 9000, price_period: "month", holder_agent_id: "7" });
  assert.equal("holder_agent_id" in listings[1], false);
  assert.equal(listings[1].property_type, "land");
  const answer = { matches: [
    { listing_ref: "oneonone:201", reason: "fits", route_to: "7", recommended_contact: { url: "https://1on1realtors.com/property/mine" } },
    { listing_ref: "oneonone:202", reason: "fits", route_to: "unassigned", recommended_contact: { url: "https://1on1realtors.com/property/unheld" } },
    { listing_ref: "oneonone:203", reason: "fits", route_to: "9", recommended_contact: { url: "https://1on1realtors.com/property/someone-elses" } },
  ] };
  const run = async (email: string | null, agentId: number | null) => {
    const f = fakeCaller({ match_requests: answer });
    const recs = await recommendationsFor({ email, owners: ["miles@1on1.example"], listings, agentId, requests: { status: "ok", rows: [] }, caller: f.caller });
    return { items: recs.listings.status === "ok" ? recs.listings.items.map((i) => i.url?.split("/").pop()) : recs.listings.status, f };
  };
  assert.deepEqual((await run("dana@1on1.example", 7)).items, ["mine"]);
  assert.deepEqual((await run("miles@1on1.example", null)).items, ["mine", "unheld", "someone-elses"]);
  const nobody = await run("temp@1on1.example", null);
  assert.deepEqual(nobody.items, []);
  assert.equal(nobody.f.calls.length, 0, "not an agent or owner: the market isn't asked");
  const sent = (await run("dana@1on1.example", 7)).f.calls[0].args.listings as Record<string, unknown>[];
  assert.equal(sent.length, 2);
});

test("the session is refreshed when it is about to expire", async () => {
  let n = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === TOKEN_URL && init?.method === "POST") {
      n += 1;
      return Response.json({ access_token: `t${n}`, expires_in: 30 }); // under the one-minute margin: never reused
    }
    return Response.json([]);
  }) as typeof fetch;
  const seam = crmSeamFromEnv(ENV, fetcher);
  await seam.agents();
  await seam.agents();
  assert.equal(n, 2);
});
