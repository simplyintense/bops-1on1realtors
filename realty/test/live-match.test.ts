import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SAMPLE_CHAT, SAMPLE_MESSAGES, sampleEnvelope } from "../fixtures/whatsapp-samples.ts";
import { crmSeam, fixedCrmSeam, NOT_CONNECTED } from "../flow/crm-seam.ts";
import { digestOf, liveBuyerArgs, liveDesk, liveRequestOf, matchOnArrival, requestLabel } from "../flow/live-match.ts";
import { interpret } from "../flow/periskope.ts";
import { GATE_COOKIE, gateConfig, makeSession } from "../../lib/gate.ts";
import { handleWebhook, optOutSender, ownerAccess, purgeExpiredPeriskope, setConsent } from "../node/periskope-intake.ts";
import { staffDigest } from "../node/requests.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { replaySamples } from "../node/replay.ts";
import { fakeCaller } from "./desk-fakes.ts";

const KEY = "test-signing-key";
const NOW = new Date("2026-11-13T20:00:00.000Z");

/** A match_buyer hit the way the market sends one, with a score and a contact's phone that must not reach the view. */
const HIT = {
  listing_ref: "terracaribbean:123",
  title: "2 bed apartment, Westmoorings",
  url: "https://example.com/listing/123",
  area: "Westmoorings",
  price: 8500,
  currency: "TTD",
  beds: 2,
  score: 0.91,
  grade: "A",
  reason: "Same area; TT$8,500 fits up to TT$9,000; 2 bed. Call +1 868 555 0199",
  route_to: "unassigned",
  recommended_contact: { agency: "Example Realty", phone: "+1 868 555 0199", url: "https://example.com/agent" },
};

function world(market = fakeCaller({ match_buyer: { matches: [HIT] } })) {
  const root = mkdtempSync(join(tmpdir(), "live-match-"));
  const opts = { root, env: { PERISKOPE_SIGNING_KEY: KEY }, now: () => NOW, crm: null, market: market.caller, fetch: (async () => { throw new Error("no network in tests"); }) as typeof fetch };
  const post = (payload: unknown) => {
    const raw = Buffer.from(JSON.stringify(payload));
    return handleWebhook(raw, createHmac("sha256", KEY).update(raw).digest("hex"), opts);
  };
  const consent = () => setConsent({ chatId: SAMPLE_CHAT, groupName: "1on1 agents", noticePostedAt: "2026-11-01T12:00:00Z", adminOkBy: "Office admin", adminOkAt: "2026-11-02T12:00:00Z", active: true }, opts);
  return { root, opts, post, consent, market, store: () => new PeriskopeStore(root) };
}

const sample = (id: string) => SAMPLE_MESSAGES.find((m) => m.id === id)!;

test("the samples parse the way agents write them: Westmoorings rent, Diego Martin buy, Chaguanas townhouse, a listing and chatter", () => {
  for (const m of SAMPLE_MESSAGES) assert.equal(interpret(m.body).kind, m.expect, m.id);
  const r = liveRequestOf(interpret(sample("sample-westmoorings-rent").body).facts);
  assert.deepEqual(r, { intent: "rent", area: "Westmoorings", beds: 2, propertyType: "apartment", priceMin: null, priceMax: 9000, currency: "TTD", monthly: true });
  assert.equal(requestLabel(r), "rent · 2 bed apartment · Westmoorings · up to TT$9,000 a month");
  const d = liveRequestOf(interpret(sample("sample-diego-martin-buy").body).facts);
  assert.equal(d.intent, "buy");
  assert.equal(d.area, "Diego Martin");
  assert.equal(d.priceMax, 1_800_000);
});

test("match_buyer gets only the fields the request has, with the market's property types", () => {
  const args = liveBuyerArgs({ intent: "buy", area: "Chaguanas", beds: 3, propertyType: "condo", priceMin: null, priceMax: 1_200_000, currency: "TTD", monthly: false }, "m-1", "2026-11-13T20:00:00.000Z");
  assert.deepEqual(args, { buyer: { intent: "buy", ref: "m-1", posted_at: "2026-11-13T20:00:00.000Z", area: "Chaguanas", price_max: 1_200_000, currency: "TTD", beds_min: 3, property_type: "apartment" }, limit: 5 });
});

test("matching never throws: no intent, no market, a failure and a timeout are statuses, and scores never reach a match", async () => {
  const r = liveRequestOf(interpret(sample("sample-westmoorings-rent").body).facts);
  assert.equal((await matchOnArrival({ ...r, intent: null }, "m", "t", fakeCaller().caller)).status, "no-intent");
  assert.equal((await matchOnArrival(r, "m", "t", null)).status, "not-configured");
  assert.equal((await matchOnArrival(r, "m", "t", fakeCaller({ match_buyer: new Error("down") }).caller)).status, "unavailable");
  const slow = Object.assign(new Error("slow"), { name: "TimeoutError" });
  assert.equal((await matchOnArrival(r, "m", "t", fakeCaller({ match_buyer: slow }).caller)).status, "timeout");
  const ok = await matchOnArrival(r, "m", "t", fakeCaller({ match_buyer: { matches: [HIT] } }).caller);
  assert.equal(ok.status, "matched");
  assert.equal(ok.matches.length, 1);
  assert.equal(ok.matches[0].title, "2 bed apartment, Westmoorings");
  assert.doesNotMatch(JSON.stringify(ok.matches), /0\.91|"grade"|"score"|555 0199/);
  assert.match(ok.matches[0].reason ?? "", /\[number removed\]/);
});

test("with no CRM a WhatsApp buyer request is stored and matched on arrival, without the message text", async () => {
  const w = world();
  await w.consent();
  const r = await w.post(sampleEnvelope(sample("sample-westmoorings-rent")));
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "buyer request stored (no CRM: not routed)");
  assert.equal(r.body.matching, "matched");
  assert.equal(r.body.matches, 1);
  const [row] = w.store().live();
  assert.equal(row.messageId, "sample-westmoorings-rent");
  assert.equal(row.senderPhone, "+18685550101");
  assert.equal(row.status, "matched");
  assert.equal(row.request.area, "Westmoorings");
  assert.equal(row.matches[0].area, "Westmoorings");
  assert.doesNotMatch(JSON.stringify(row), /Good morning|furnished/i);
  assert.deepEqual(w.market.tools(), ["match_buyer"]);
  assert.equal(w.store().leads().length, 0, "no CRM: no lead-flow lead");
});

test("a second delivery of the same message id is not stored or matched again", async () => {
  const w = world();
  await w.consent();
  await w.post(sampleEnvelope(sample("sample-chaguanas-townhouse")));
  const again = await w.post(sampleEnvelope(sample("sample-chaguanas-townhouse")));
  assert.equal(again.body.result, "ignored: already seen");
  assert.equal(w.store().live().length, 1);
  assert.equal(w.market.calls.length, 1);
});

test("a market failure still takes the request (200, marked seen) with the failure recorded", async () => {
  const w = world(fakeCaller({ match_buyer: new Error("down") }));
  await w.consent();
  const r = await w.post(sampleEnvelope(sample("sample-diego-martin-buy")));
  assert.equal(r.status, 200);
  assert.equal(r.body.matching, "unavailable");
  assert.equal(w.store().live()[0].status, "unavailable");
  assert.ok(w.store().isSeen("sample-diego-martin-buy"));
});

test("listings and chatter are not matched; with no signing key the webhook is 503 and stores nothing", async () => {
  const w = world();
  await w.consent();
  await w.post(sampleEnvelope(sample("sample-maraval-listing")));
  await w.post(sampleEnvelope(sample("sample-chatter")));
  assert.equal(w.store().live().length, 0);
  assert.equal(w.market.calls.length, 0);
  const raw = Buffer.from(JSON.stringify(sampleEnvelope(sample("sample-westmoorings-rent"))));
  const r = await handleWebhook(raw, "anything", { ...w.opts, env: {} });
  assert.equal(r.status, 503);
  assert.equal(w.store().live().length, 0);
});

test("opt-out and the retention purge remove live requests with the sender's other records", async () => {
  const w = world();
  await w.consent();
  await w.post(sampleEnvelope(sample("sample-westmoorings-rent")));
  await w.post(sampleEnvelope(sample("sample-chaguanas-townhouse")));
  await optOutSender("+18685550101", w.opts);
  assert.deepEqual(w.store().live().map((r) => r.messageId), ["sample-chaguanas-townhouse"]);
  purgeExpiredPeriskope(w.store(), new Date(NOW.getTime() + 61 * 86_400_000), {});
  assert.equal(w.store().live().length, 0);
});

test("the replay runs every sample through the signed webhook into a throwaway store and leaves nothing behind", async () => {
  const market = fakeCaller({ match_buyer: { matches: [HIT] } });
  const before = readdirSync(tmpdir()).filter((f) => f.startsWith("bops-replay-")).length;
  const r = await replaySamples({ env: { ONEON1_MARKET_WRITE_URL: "https://ingest.example", ONEON1_MARKET_INGEST_TOKEN: "t" }, market: market.caller, now: () => NOW, fetch: (async () => { throw new Error("must not post to market-ingest"); }) as typeof fetch });
  assert.equal(r.market, "configured");
  assert.equal(r.messages.length, SAMPLE_MESSAGES.length);
  const requests = r.messages.filter((m) => m.expect === "buyer_request");
  assert.equal(requests.length, 3);
  for (const m of requests) {
    assert.equal(m.result, "buyer request stored (no CRM: not routed)");
    assert.equal(m.status, "matched");
    assert.equal(m.matches.length, 1);
  }
  assert.equal(r.messages.find((m) => m.id === "sample-westmoorings-rent")?.label, "rent · 2 bed apartment · Westmoorings · up to TT$9,000 a month");
  assert.match(r.messages.find((m) => m.id === "sample-maraval-listing")!.result, /listing/);
  assert.match(r.messages.find((m) => m.id === "sample-chatter")!.result, /dropped/);
  assert.equal(r.duplicate, "ignored: already seen");
  assert.equal(readdirSync(tmpdir()).filter((f) => f.startsWith("bops-replay-")).length, before);
});

test("the desk's live side: an agent sees only their own requests; unassigned requests are for owners only", async () => {
  const w = world();
  await w.consent();
  for (const m of SAMPLE_MESSAGES) await w.post(sampleEnvelope(m));
  const rows = w.store().live();
  assert.equal(rows.length, 3);
  const agents = [{ email: "kerry@1on1.example", phone: "+18685550101" }];

  const agent = liveDesk({ email: "Kerry@1on1.example", owner: false, agents, rows });
  assert.equal(agent.unassigned, null, "staff never get the unassigned list");
  assert.ok(agent.yours.status === "ok");
  assert.deepEqual(agent.yours.cards.map((c) => c.label), ["rent · 2 bed apartment · Westmoorings · up to TT$9,000 a month"]);
  assert.doesNotMatch(JSON.stringify(agent), /555010[23]|Diego Martin|Chaguanas/, "no one else's request in an agent's view");

  const owner = liveDesk({ email: "miles@1on1.example", owner: true, agents, rows });
  assert.deepEqual(owner.yours, { status: "no-agent" });
  assert.deepEqual(owner.unassigned?.map((c) => c.label.split(" · ")[2]).sort(), ["Chaguanas", "Diego Martin"]);
  assert.doesNotMatch(JSON.stringify(owner), /\+1868|sample-/, "cards carry no phone or message id");

  // No CRM: nobody is an agent, so staff see "no-agent" and owners see every request as unassigned.
  assert.deepEqual(liveDesk({ email: "kerry@1on1.example", owner: false, agents: [], rows }), { yours: { status: "no-agent" }, unassigned: null });
  assert.equal(liveDesk({ email: "miles@1on1.example", owner: true, agents: [], rows }).unassigned?.length, 3);
  assert.deepEqual(liveDesk({ email: null, owner: false, agents, rows }).yours, { status: "signed-out" });
});

test("the CRM seam: not connected says so honestly, with no listings and no agents", async () => {
  assert.equal(NOT_CONNECTED.connected, false);
  const l = await NOT_CONNECTED.listings();
  assert.equal(l.status, "not-connected");
  assert.match(l.status === "not-connected" ? l.text : "", /CRM not connected/);
  assert.deepEqual(await NOT_CONNECTED.agents(), []);
  assert.equal(crmSeam(), NOT_CONNECTED);
  const fixed = fixedCrmSeam([{ id: "L1" }], [{ email: " Kerry@1on1.example ", phone: "868-555-0101" }, { email: "x@1on1.example", phone: "n/a" }]);
  assert.deepEqual(await fixed.agents(), [{ email: "kerry@1on1.example", phone: "+18685550101" }]);
});

test("the daily digest counts the last 24 hours and is for owners only", async () => {
  const w = world();
  await w.consent();
  for (const m of SAMPLE_MESSAGES) await w.post(sampleEnvelope(m));
  const d = digestOf(w.store().live(), new Date(NOW.getTime() + 3_600_000));
  assert.equal(d.requests, 3);
  assert.equal(d.withMatches, 3);
  assert.equal(d.noMatches + d.notMatched, 0);
  assert.equal(digestOf(w.store().live(), new Date(NOW.getTime() + 25 * 3_600_000)).requests, 0, "older than a day is out");

  const env = { BOPS_OWNER_EMAILS: "miles@1on1.example, wendy@1on1.example" };
  assert.deepEqual(staffDigest({ email: "kerry@1on1.example", env, intakeRoot: w.root }), { owner: false });
  assert.deepEqual(staffDigest({ email: null, env, intakeRoot: w.root }), { owner: false });
  const owner = staffDigest({ email: "wendy@1on1.example", env, intakeRoot: w.root, now: new Date(NOW.getTime() + 60_000) });
  assert.ok(owner.owner && owner.digest.requests === 3 && owner.crm === "not-connected");
});

test("the replay endpoint's gate: owners only when sign-in is on, 401 signed out, 403 on the public demo", async () => {
  const env = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", BOPS_OWNER_EMAILS: "miles@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example" };
  const cfg = gateConfig(env);
  assert.ok(cfg && cfg !== "misconfigured", "test gate config is complete");
  const as = async (email: string | null) => {
    const headers: Record<string, string> = email ? { cookie: `${GATE_COOKIE}=${await makeSession(email, cfg)}` } : {};
    return ownerAccess(new Request("https://bops.example/api/realty/replay", { method: "POST", headers }), env);
  };
  assert.equal(await as("miles@1on1.example"), null);
  assert.equal((await as("kerry@1on1.example"))?.status, 403);
  assert.equal((await as(null))?.status, 401);
  assert.equal((await ownerAccess(new Request("https://bops.example/x", { method: "POST" }), { ONEON1_PUBLIC_DEMO: "1" }))?.status, 403);
});
