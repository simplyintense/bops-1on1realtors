import assert from "node:assert/strict";
import { test } from "node:test";
import { CRM_MISSING_TEXT, recommendationsFor, reasonText, type DeskListing } from "../flow/recommendations.ts";
import type { ToolCaller } from "../flow/areas.ts";
import { DESK_TOOLS, OPEN_REQUESTS, searchRequests, type RequestsResult } from "../flow/requests.ts";
import { parseAllowlist } from "../../lib/gate.ts";
import { staffRecommendations } from "../node/requests.ts";
import { type Answer, fakeCaller, fakeMarketFetch, MATCH_LIVE, MATCH_ROUTED, MATCH_UNASSIGNED, REQ_BUY, REQ_NO_INTENT, REQ_OLD, REQ_RENT, REQ_USD } from "./desk-fakes.ts";

/**
 * The desk's "Top recommendations for you" (realty/flow/recommendations.ts) against a fake market. Nothing invented: no
 * requests, no buyers; no CRM listings, no match_requests or score_matches. Scores and grades never reach the view, and
 * unassigned matches reach only an owner. Only the desk's read-only tools are called.
 */

const OWNERS = parseAllowlist("wendy@example.test, miles@example.test");
const ALL_REQUESTS = [REQ_BUY, REQ_RENT, REQ_USD, REQ_NO_INTENT, REQ_OLD];
const UNASSIGNED_TITLE = "Unassigned flat, Westmoorings";

/** One desk run: the market answers (the requests and two matches by default), the requests read from it, then the recommendations. */
async function run(answers: Record<string, Answer>, o: { email?: string | null; listings?: DeskListing[] | null; requests?: RequestsResult } = {}) {
  const f = fakeCaller({ search_market_requests: { total: 5, hits: ALL_REQUESTS }, match_buyer: { total: 2, hits: [MATCH_ROUTED, MATCH_UNASSIGNED] }, ...answers });
  const requests = o.requests ?? (await searchRequests(OPEN_REQUESTS, f.caller));
  const recs = await recommendationsFor({ email: o.email ?? null, owners: OWNERS, listings: o.listings, requests, caller: f.caller });
  return { recs, f };
}

test("no CRM listings: the status is missing, and match_requests and score_matches are never called", async () => {
  const cases: (DeskListing[] | null | undefined)[] = [undefined, null, []];
  for (const listings of cases) {
    const { recs, f } = await run({}, { listings });
    assert.deepEqual(recs.listings, { status: "missing", missing: "crm-listings" });
    assert.ok(!f.tools().includes("match_requests"));
    assert.ok(!f.tools().includes("score_matches"));
  }
  assert.ok(CRM_MISSING_TEXT.startsWith("1on1 CRM listings aren't connected yet"));
});

test("with a real listings array, match_requests gets the listings and score_matches is never called", async () => {
  const listings: DeskListing[] = [{ id: "L1", title: "Listing 1", area: "Maraval" }];
  const { recs, f } = await run({ match_requests: { total: 1, hits: [MATCH_ROUTED] } }, { listings });
  assert.equal(recs.listings.status, "ok");
  assert.equal(recs.listings.status === "ok" ? recs.listings.items.length : -1, 1);
  const args = f.calls.find((c) => c.tool === "match_requests")?.args ?? {};
  assert.deepEqual(args.listings, listings);
  assert.equal(args.limit, 5);
  assert.ok(!("requests" in args), "match_requests does not take a requests argument");
  assert.ok(!f.tools().includes("score_matches"));
});

test("live matches: match_buyer for the newest three requests with an intent, each with that request's own fields", async () => {
  const { f } = await run({});
  const buyer = f.calls.filter((c) => c.tool === "match_buyer");
  assert.equal(buyer.length, 3);
  // Newest first: USD (13 Nov), rent (12 Nov), buy (11 Nov). The no-intent request and the 1 Nov one are left out.
  assert.deepEqual(buyer[0].args, { buyer: { intent: "rent", ref: "req-103", area: "Glencoe", price_max: 15000, currency: "USD", posted_at: "2026-11-13T08:00:00.000Z" }, limit: 5 });
  assert.deepEqual(buyer[1].args, {
    buyer: {
      intent: "rent",
      ref: "req-101",
      area: "Westmoorings",
      price_max: 9000,
      currency: "TTD",
      beds_min: 2,
      property_type: "apartment",
      posted_at: "2026-11-12T14:05:00.000Z",
    },
    limit: 5,
  });
  assert.deepEqual(buyer[2].args, {
    buyer: {
      intent: "buy",
      ref: "req-102",
      area: "Maraval",
      price_min: 2000000,
      price_max: 2500000,
      currency: "TTD",
      beds_min: 3,
      property_type: "townhouse",
      posted_at: "2026-11-11T09:00:00.000Z",
    },
    limit: 5,
  });
});

test("matches show the market's reason text; the view has no score or grade, and no route_to", async () => {
  const { recs } = await run({});
  assert.equal(recs.buyers.status, "ok");
  const matches = recs.buyers.status === "ok" ? recs.buyers.matches : [];
  // The same listing matched three requests; it's shown once, for the newest request it matched.
  assert.equal(matches.length, 1);
  const [m] = matches;
  assert.equal(m.title, "3 bed townhouse, Maraval");
  assert.equal(m.reason, "Same area and budget; 3 beds as asked.");
  assert.equal(m.price, "TT$2,300,000");
  assert.deepEqual(m.forRequest, { area: "Glencoe", budget: "up to US$15,000", beds: null, intent: "rent", propertyType: null });
  const json = JSON.stringify(recs);
  assert.doesNotMatch(json, /"score"|"grade"|0\.92/);
  assert.ok(!json.includes("agent-private-7"), "route_to must not reach the view");
});

test("unassigned matches: an owner sees them; anyone else gets none, and no one's email", async () => {
  const owner = await run({}, { email: "miles@example.test" });
  assert.equal(owner.recs.owner, true);
  assert.deepEqual(owner.recs.unassigned?.map((m) => m.title), [UNASSIGNED_TITLE]);
  assert.equal(owner.recs.unassigned?.[0].reason, "Call [number removed] or [email removed] about the 2-bed flat");
  assert.ok(owner.recs.buyers.status === "ok" && owner.recs.buyers.matches.every((m) => m.title !== UNASSIGNED_TITLE));
  assert.ok(!JSON.stringify(owner.recs).includes("wendy@example.test"), "no other owner's address in the view");

  const other = await run({}, { email: "agent@example.test" });
  assert.equal(other.recs.owner, false);
  assert.equal(other.recs.unassigned, null);
  const json = JSON.stringify(other.recs);
  for (const s of [UNASSIGNED_TITLE, "wendy@example.test", "miles@example.test", "agent@example.test", "ava@example.com", "+1 868 555 0199"]) {
    assert.ok(!json.includes(s), `view leaks ${s}`);
  }
  assert.ok(other.recs.buyers.status === "ok" && other.recs.buyers.matches.length === 1, "routed matches still show to staff");

  const signedOut = await run({}, { email: null });
  assert.equal(signedOut.recs.owner, false);
  assert.equal(signedOut.recs.unassigned, null);
});

test("only the desk's read-only tools are called, never learn_* or opt-out", async () => {
  const { f } = await run({}, { email: "miles@example.test", listings: [{ id: "L1", title: "Listing" }] });
  assert.ok(f.tools().length > 0);
  for (const t of f.tools()) {
    assert.ok((DESK_TOOLS as readonly string[]).includes(t), `${t} isn't a desk tool`);
    assert.ok(!t.startsWith("learn_") && !t.includes("optout") && !t.includes("opt_out"), t);
  }
});

test("no buyer requests: no buyers and no match_buyer call; nothing is invented", async () => {
  const none = await run({ search_market_requests: { total: 0, hits: [] } });
  assert.deepEqual(none.recs.buyers, { status: "no-requests" });
  assert.ok(!none.f.tools().includes("match_buyer"));

  const noIntent = await run({ search_market_requests: { total: 1, hits: [REQ_NO_INTENT] } });
  assert.deepEqual(noIntent.recs.buyers, { status: "no-requests" });
  assert.ok(!noIntent.f.tools().includes("match_buyer"));
});

test("market not configured, or the request feed down: the buyer status says so, and no buyer is called", async () => {
  const off = await run({}, { requests: { status: "not-configured" } });
  assert.deepEqual(off.recs.buyers, { status: "not-configured" });
  assert.ok(!off.f.tools().includes("match_buyer"));

  const down = await run({}, { requests: { status: "error", reason: "timeout" } });
  assert.deepEqual(down.recs.buyers, { status: "error", reason: "timeout" });
  assert.ok(!down.f.tools().includes("match_buyer"));
});

test("a failing match_buyer is an error status, never a throw; a partial failure keeps what answered", async () => {
  const bad = await run({ match_buyer: new Error("tool error") });
  assert.deepEqual(bad.recs.buyers, { status: "error", reason: "unavailable" });

  const slow = await run({ match_buyer: Object.assign(new Error("slow"), { name: "TimeoutError" }) });
  assert.deepEqual(slow.recs.buyers, { status: "error", reason: "timeout" });

  const f = fakeCaller({ search_market_requests: { total: 5, hits: ALL_REQUESTS }, match_buyer: { total: 1, hits: [MATCH_ROUTED] } });
  const flaky: ToolCaller = {
    callTool: (name, args) => {
      const buyer = args.buyer && typeof args.buyer === "object" ? (args.buyer as { ref?: unknown }) : null;
      return name === "match_buyer" && buyer?.ref === "req-101" ? Promise.reject(new Error("boom")) : f.caller.callTool(name, args);
    },
  };
  const requests = await searchRequests(OPEN_REQUESTS, f.caller);
  const recs = await recommendationsFor({ email: null, owners: OWNERS, requests, caller: flaky });
  assert.equal(recs.buyers.status, "ok");
  assert.equal(recs.buyers.status === "ok" ? recs.buyers.matches.length : -1, 1);
});

test("reason text: phone numbers and emails are taken out; amounts stay", () => {
  assert.equal(reasonText("Call +1 868 555 0199 today"), "Call [number removed] today");
  assert.equal(reasonText("ava@example.com wants it"), "[email removed] wants it");
  assert.equal(reasonText("Budget 1500000 TTD"), "Budget 1500000 TTD");
  assert.equal(reasonText("   "), null);
  assert.equal(reasonText(undefined), null);
});

test("the node wrapper: the market's settings and BOPS_OWNER_EMAILS, read-only, and not-configured without them", async () => {
  const env = {
    ONEON1_MARKET_SEARCH_URL: "http://127.0.0.1:8787/mcp",
    ONEON1_MARKET_SEARCH_TOKEN: "test-token-not-real-0123",
    BOPS_OWNER_EMAILS: "miles@example.test",
  };
  const fake = fakeMarketFetch({ answers: { search_market_requests: { total: 1, hits: [REQ_RENT] }, match_buyer: { total: 2, hits: [MATCH_ROUTED, MATCH_UNASSIGNED] } } });
  const recs = await staffRecommendations({ email: "miles@example.test", env, fetcher: fake.fetcher });
  assert.equal(recs.owner, true);
  assert.deepEqual(recs.unassigned?.map((m) => m.title), [UNASSIGNED_TITLE]);
  assert.deepEqual(recs.listings, { status: "missing", missing: "crm-listings" });
  assert.ok(fake.tools().every((t) => (DESK_TOOLS as readonly string[]).includes(t)));
  assert.deepEqual(fake.tools(), ["match_buyer", "search_market_requests"]);

  const off = await staffRecommendations({ email: "miles@example.test", env: {}, fetcher: fake.fetcher });
  assert.deepEqual(off.buyers, { status: "not-configured" });
  assert.equal(off.unassigned, null, "without BOPS_OWNER_EMAILS nobody is an owner");
});

test("a live Match shape: listing_ref, reason, recommended_contact.url, and a matches array; route_to unassigned is not routed; contact phone stays out of the view", async () => {
  const { recs } = await run({ match_buyer: { total: 1, matches: [MATCH_LIVE] } }, { email: "miles@example.test" });
  assert.equal(recs.buyers.status, "ok");
  assert.equal(recs.buyers.status === "ok" ? recs.buyers.matches.length : -1, 0, "unassigned is not in the buyers list");
  assert.equal(recs.unassigned?.length, 1);
  const m = recs.unassigned?.[0];
  assert.equal(m?.title, "src:listing-9");
  assert.equal(m?.url, "https://other.example/listing/9");
  assert.equal(m?.source, "Other Agency");
  assert.equal(m?.reason, "Fits the budget in Westmoorings.");
  const json = JSON.stringify(recs);
  assert.ok(!json.includes("868-555-0000"), "contact phone must not reach the view");
  assert.doesNotMatch(json, /"score"|"grade"|0\.81/);
});
