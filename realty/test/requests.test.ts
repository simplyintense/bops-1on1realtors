import assert from "node:assert/strict";
import { test } from "node:test";
import {
  budgetLabel,
  jsonHits,
  readOnlyCall,
  requestArgs,
  requestCriteriaFromParams,
  requestRow,
  searchRequests,
  sortFromParams,
  sortRequests,
  OPEN_REQUESTS,
  type BuyerRequest,
} from "../flow/requests.ts";
import { staffRequests } from "../node/requests.ts";
import { fakeCaller, fakeMarketFetch, REQ_BUY, REQ_NO_INTENT, REQ_RENT, REQ_USD } from "./desk-fakes.ts";

/**
 * The buyer-request feed (realty/flow/requests.ts, realty/node/requests.ts) against a fake market. The row view is built
 * from an allowlist, so the private fields can't reach a page; an empty or failed market is an honest status, never rows.
 */

const ALLOWED_ROW_FIELDS = [
  "ref",
  "receivedAt",
  "intent",
  "area",
  "propertyType",
  "bedsMin",
  "bathsMin",
  "priceMin",
  "priceMax",
  "currency",
  "status",
  "agency",
].sort();

const PRIVATE = ["Ava Fixture", "Bo Fixture", "Cy Fixture", "Sam Fixture", "+1 868 555 0199", "+1 868 555 0198", "msg-SECRET", "grp-SECRET", "call +1"];

const row = (h: Record<string, unknown>): BuyerRequest => {
  const r = requestRow(h);
  assert.ok(r, "fixture should give a row");
  return r;
};

test("search_market_requests hits become rows; no private field reaches a row or its JSON", async () => {
  const f = fakeCaller({ search_market_requests: { total: 2, hits: [REQ_RENT, REQ_BUY] } });
  const r = await searchRequests(OPEN_REQUESTS, f.caller);
  assert.equal(r.status, "ok");
  assert.equal(r.rows.length, 2);
  const [rent, buy] = r.rows;
  assert.equal(rent.ref, "req-101");
  assert.equal(rent.area, "Westmoorings");
  assert.equal(rent.intent, "rent");
  assert.equal(rent.propertyType, "apartment");
  assert.equal(rent.bedsMin, 2);
  assert.equal(rent.priceMax, 9000);
  assert.equal(rent.currency, "TTD");
  assert.equal(rent.agency, "Example Realty");
  assert.equal(rent.receivedAt, "2026-11-12T14:05:00.000Z");
  assert.equal(buy.agency, null);
  assert.equal(buy.priceMin, 2000000);
  for (const x of r.rows) assert.deepEqual(Object.keys(x).sort(), ALLOWED_ROW_FIELDS);
  const json = JSON.stringify(r);
  for (const p of PRIVATE) assert.ok(!json.includes(p), `leaked ${p}`);
  assert.deepEqual(f.tools(), ["search_market_requests"]);
});

test("the feed sends only the filters that are set; status defaults to open; limit is 20 at most", () => {
  assert.deepEqual(requestArgs(requestCriteriaFromParams(new URLSearchParams())), { status: "open", limit: 20 });
  const c = requestCriteriaFromParams(new URLSearchParams("q=pool&intent=rent&area=Westmoorings&priceMax=9000&bedsMin=2.7&status=any"));
  assert.deepEqual(requestArgs(c), { status: "any", limit: 20, query: "pool", intent: "rent", area: "Westmoorings", price_max: 9000, beds_min: 2 });
  assert.deepEqual(requestArgs(requestCriteriaFromParams(new URLSearchParams("intent=sell&status=bogus"))), { status: "open", limit: 20 });
  assert.equal(requestArgs(OPEN_REQUESTS, 500).limit, 20);
});

test("zero hits is an honest empty state: ok, with no rows", async () => {
  const f = fakeCaller({ search_market_requests: { total: 0, hits: [] } });
  assert.deepEqual(await searchRequests(OPEN_REQUESTS, f.caller), { status: "ok", rows: [] });
});

test("no market configured is not-configured, and nothing is called", async () => {
  assert.deepEqual(await searchRequests(OPEN_REQUESTS, null), { status: "not-configured" });
  assert.deepEqual(await staffRequests(OPEN_REQUESTS, { env: {} }), { status: "not-configured" });
});

test("a tool error, a failed call, a timeout and an unreadable reply are errors, never rows", async () => {
  const toolError = fakeCaller({ search_market_requests: new Error("tool error") });
  assert.deepEqual(await searchRequests(OPEN_REQUESTS, toolError.caller), { status: "error", reason: "unavailable" });

  const timeout = Object.assign(new Error("slow"), { name: "TimeoutError" });
  const slow = fakeCaller({ search_market_requests: timeout });
  assert.deepEqual(await searchRequests(OPEN_REQUESTS, slow.caller), { status: "error", reason: "timeout" });

  const garbage = { callTool: async () => ({ content: [{ type: "text", text: "not json at all" }] }) };
  assert.deepEqual(await searchRequests(OPEN_REQUESTS, garbage), { status: "error", reason: "unavailable" });

  const env = { ONEON1_MARKET_SEARCH_URL: "http://127.0.0.1:8787/mcp", ONEON1_MARKET_SEARCH_TOKEN: "test-token-not-real-0123" };
  const down = await staffRequests(OPEN_REQUESTS, { env, fetcher: fakeMarketFetch({ http: 500 }).fetcher });
  assert.deepEqual(down, { status: "error", reason: "unavailable" });
  const late = await staffRequests(OPEN_REQUESTS, { env, fetcher: fakeMarketFetch({ throws: new DOMException("late", "TimeoutError") }).fetcher });
  assert.deepEqual(late, { status: "error", reason: "timeout" });
});

test("the node wrapper reads the market over fetch, through MarketClient, and only calls search_market_requests", async () => {
  const env = { ONEON1_MARKET_SEARCH_URL: "http://127.0.0.1:8787/mcp", ONEON1_MARKET_SEARCH_TOKEN: "test-token-not-real-0123" };
  const fake = fakeMarketFetch({ answers: { search_market_requests: { total: 1, hits: [REQ_USD] } } });
  const r = await staffRequests(OPEN_REQUESTS, { env, fetcher: fake.fetcher });
  assert.equal(r.status, "ok");
  assert.equal(r.status === "ok" ? r.rows[0].ref : null, "req-103");
  assert.deepEqual(fake.tools(), ["search_market_requests"]);
  assert.equal(fake.calls[0].args.status, "open");
});

test("only the allowed read-only tools can be called; learn_* and opt-out are refused", async () => {
  const f = fakeCaller();
  await assert.rejects(readOnlyCall(f.caller, "learn_area_alias" as never, { alias: "x" }), /not a read-only desk tool/);
  await assert.rejects(readOnlyCall(f.caller, "learn_area_neighbour" as never, {}), /not a read-only desk tool/);
  await assert.rejects(readOnlyCall(f.caller, "register_market_optout" as never, {}), /not a read-only desk tool/);
  assert.equal(f.calls.length, 0);
});

test("jsonHits reads the hits array from the second block, and nothing else", () => {
  assert.deepEqual(jsonHits({ content: [{ type: "text", text: "summary" }, { type: "text", text: '{"hits":[{"id":"a"}]}' }] }), [{ id: "a" }]);
  assert.equal(jsonHits({ content: [{ type: "text", text: '{"total":0}' }] }), null);
  assert.equal(jsonHits({}), null);
});

test("requestRow needs something to show: a bare status is no row", () => {
  assert.equal(requestRow({}), null);
  assert.equal(requestRow({ status: "open" }), null);
  assert.equal(requestRow({ id: 7 })?.ref, "7");
  assert.equal(requestRow({ ...REQ_USD, price_max: "15000.50" })?.priceMax, 15000.5);
});

test("sort: date, area, budget and beds, both ways; a missing value goes last in either direction", () => {
  const rent = row(REQ_RENT); // Westmoorings, TTD 9,000, 2 beds, 12 Nov
  const buy = row(REQ_BUY); // Maraval, TTD 2,000,000 to 2,500,000, 3 beds, 11 Nov
  const usd = row(REQ_USD); // Glencoe, USD 15,000, no beds, 13 Nov
  const noArea = row({ ...REQ_NO_INTENT, intent: "buy", area: null, received_at: "2026-11-10T00:00:00Z" }); // no area, no beds, no budget
  const rows = [rent, buy, usd, noArea];
  const ids = (xs: BuyerRequest[]) => xs.map((x) => x.ref);
  assert.deepEqual(ids(sortRequests(rows, { key: "date", dir: "desc" })), ["req-103", "req-101", "req-102", "req-104"]);
  assert.deepEqual(ids(sortRequests(rows, { key: "date", dir: "asc" })), ["req-104", "req-102", "req-101", "req-103"]);
  assert.deepEqual(ids(sortRequests(rows, { key: "area", dir: "asc" })), ["req-103", "req-102", "req-101", "req-104"]);
  assert.deepEqual(ids(sortRequests(rows, { key: "area", dir: "desc" })), ["req-101", "req-102", "req-103", "req-104"]);
  assert.deepEqual(ids(sortRequests(rows, { key: "budget", dir: "desc" })), ["req-102", "req-103", "req-101", "req-104"]);
  assert.deepEqual(ids(sortRequests(rows, { key: "budget", dir: "asc" })), ["req-101", "req-103", "req-102", "req-104"]);
  assert.deepEqual(ids(sortRequests(rows, { key: "beds", dir: "asc" })), ["req-101", "req-102", "req-103", "req-104"]);
  assert.deepEqual(ids(sortRequests(rows, { key: "beds", dir: "desc" })), ["req-102", "req-101", "req-103", "req-104"]);
  // The input is not reordered in place.
  assert.deepEqual(ids(rows), ["req-101", "req-102", "req-103", "req-104"]);
});

test("sortFromParams: newest first by default; area starts ascending; a bad key falls back to date", () => {
  assert.deepEqual(sortFromParams(new URLSearchParams()), { key: "date", dir: "desc" });
  assert.deepEqual(sortFromParams(new URLSearchParams("sort=area")), { key: "area", dir: "asc" });
  assert.deepEqual(sortFromParams(new URLSearchParams("sort=bogus&dir=asc")), { key: "date", dir: "asc" });
});

test("budget label: a range, a ceiling, a floor, or none", () => {
  assert.equal(budgetLabel(row(REQ_BUY)), "TT$2,000,000 – TT$2,500,000");
  assert.equal(budgetLabel(row(REQ_RENT)), "up to TT$9,000");
  assert.equal(budgetLabel(row(REQ_USD)), "up to US$15,000");
  assert.equal(budgetLabel(row({ ...REQ_BUY, price_min: null, price_max: null })), null);
  assert.equal(budgetLabel(row({ ...REQ_BUY, price_max: null })), "from TT$2,000,000");
});
