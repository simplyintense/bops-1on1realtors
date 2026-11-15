import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GATE_COOKIE, gateConfig, makeSession, ownerAllowed } from "../../lib/gate.ts";
import { OPEN_REQUESTS } from "../flow/requests.ts";
import { NOT_CONNECTED, type CrmSeam } from "../flow/crm-seam.ts";
import { ownerAccess, staffAccess } from "../node/periskope-intake.ts";
import { staffDigest, staffRecommendations, staffRequests } from "../node/requests.ts";
import { fakeMarketFetch, REQ_RENT } from "./desk-fakes.ts";

/**
 * Owner-only screens and APIs (BOPS_OWNER_EMAILS, lib/gate.ts ownerAllowed). The pages themselves are JSX and can't run under
 * node --test, so they check these helpers: a page that is not for the viewer redirects and reads nothing (realty/node/requests.ts,
 * realty/node/periskope-intake.ts ownerAccess), and the desk's and digest's data is built here, not in the page.
 */

const OWNER = "miles@1on1.example";
const AGENT = "kerry@1on1.example";
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example", BOPS_OWNER_EMAILS: OWNER };
const MARKET = { ONEON1_MARKET_SEARCH_URL: "http://127.0.0.1:8787/mcp", ONEON1_MARKET_SEARCH_TOKEN: "test-token-not-real-0123" };
const cfg = gateConfig(GATE);
if (!cfg || cfg === "misconfigured") throw new Error("test config");

const intake = () => mkdtempSync(join(tmpdir(), "owner-gate-"));

test("ownerAllowed: only the owner list when the gate is on; anyone when it's off (no session to check), as ownerAccess", () => {
  assert.equal(ownerAllowed(OWNER, GATE), true);
  assert.equal(ownerAllowed("MILES@1on1.example", GATE), true);
  assert.equal(ownerAllowed(AGENT, GATE), false, "a signed-in agent isn't an owner");
  assert.equal(ownerAllowed(null, GATE), false, "signed out");
  assert.equal(ownerAllowed(OWNER, { ...GATE, BOPS_GATE_SECRET: "short" }), false, "a misconfigured gate says no");
  assert.equal(ownerAllowed(null, {}), true, "gate off");
});

test("owner APIs: 403 for a signed-in agent, 401 signed out, 403 on the public demo; the owner and the gate-off server pass", async () => {
  const req = async (email: string | null) =>
    new Request("https://bops.example/api/realty/replay", { method: "POST", headers: email ? { cookie: `${GATE_COOKIE}=${await makeSession(email, cfg)}` } : {} });
  assert.equal(await ownerAccess(await req(OWNER), GATE), null);
  assert.equal((await ownerAccess(await req(AGENT), GATE))?.status, 403);
  assert.equal((await ownerAccess(await req(null), GATE))?.status, 401);
  assert.equal((await ownerAccess(await req(OWNER), { ...GATE, ONEON1_PUBLIC_DEMO: "1" }))?.status, 403);
  assert.equal(await ownerAccess(await req(null), {}), null, "gate off: the window token is the check");
  assert.equal((await staffAccess(await req(AGENT), GATE)), null, "an agent passes the staff gate, not the owner one");
});

test("the buyer-request feed is owners only: an agent gets no rows and the market isn't called", async () => {
  const env = { ...GATE, ...MARKET };
  const f = fakeMarketFetch({ answers: { search_market_requests: { total: 1, hits: [REQ_RENT] } } });
  assert.deepEqual(await staffRequests(OPEN_REQUESTS, { env, email: AGENT, fetcher: f.fetcher }), { status: "owners-only" });
  assert.deepEqual(await staffRequests(OPEN_REQUESTS, { env, email: null, fetcher: f.fetcher }), { status: "owners-only" });
  assert.equal(f.calls.length, 0, "no market call for a non-owner");
  const owner = await staffRequests(OPEN_REQUESTS, { env, email: OWNER, fetcher: f.fetcher });
  assert.ok(owner.status === "ok" && owner.rows.length === 1, "the owner gets the rows");
});

test("the desk's market side and unassigned requests are owners only: an agent gets neither, and no market call", async () => {
  const env = { ...GATE, ...MARKET };
  const intakeRoot = intake();
  const f = fakeMarketFetch({ answers: { search_market_requests: { total: 1, hits: [REQ_RENT] }, match_buyer: { total: 0, hits: [] } } });
  const agent = await staffRecommendations({ email: AGENT, env, fetcher: f.fetcher, seam: NOT_CONNECTED, intakeRoot });
  assert.deepEqual(agent.buyers, { status: "owners-only" });
  assert.equal(agent.unassigned, null);
  assert.equal(agent.live.unassigned, null);
  assert.equal(agent.live.unheld, null);
  assert.equal(f.calls.length, 0, "no market call for an agent");
  const owner = await staffRecommendations({ email: OWNER, env, fetcher: f.fetcher, seam: NOT_CONNECTED, intakeRoot });
  assert.notEqual(owner.buyers.status, "owners-only");
  assert.ok(f.calls.some((c) => c.tool === "search_market_requests"));
});

test("the daily digest is owners only: anyone else gets { owner: false }, and the CRM isn't read for them", async () => {
  let reads = 0;
  const seam: CrmSeam = { connected: true, listings: async () => (reads++, { status: "ok" as const, listings: [] }), agents: async () => [] };
  const intakeRoot = intake();
  assert.deepEqual(await staffDigest({ email: AGENT, env: GATE, intakeRoot, seam }), { owner: false });
  assert.deepEqual(await staffDigest({ email: null, env: GATE, intakeRoot, seam }), { owner: false });
  assert.equal(reads, 0);
  const owner = await staffDigest({ email: OWNER, env: GATE, intakeRoot, seam });
  assert.ok(owner.owner);
  assert.equal(reads, 1);
});
