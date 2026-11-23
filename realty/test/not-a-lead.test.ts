import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GATE_COOKIE, agentMayReach, gateConfig, makeSession } from "../../lib/gate.ts";
import { askOf, excludedDemand, type DemandRow } from "../flow/automatch.ts";
import type { LiveRequest } from "../flow/live-match.ts";
import { NOT_CONNECTED, type CrmSeam } from "../flow/crm-seam.ts";
import { interpret, postRecordOf } from "../flow/periskope.ts";
import { setNotALead } from "../node/not-a-lead.ts";
import { PeriskopeStore, requestIdOf } from "../node/periskope-store.ts";
import { syncFromJsonl, withSearchStore } from "../node/search-store.ts";

/**
 * "Not a lead" (realty/node/not-a-lead.ts, app/api/realty/not-a-lead): a kind override with status "ignored" that takes a request
 * out of matching, search and the desk. Bops's own store only; nothing is sent and the CRM is not written.
 */

const NOW = new Date("2026-11-20T14:00:00.000Z");
const SENT = "2026-11-20T13:40:00.000Z";
const OWNER = "miles@1on1.example";
const AGENT = "kerry@1on1.example";
const OTHER_AGENT = "eve@1on1.example";
const AGENT_PHONE = "+18685550101";
const OTHER_PHONE = "+18685550102";
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example", BOPS_OWNER_EMAILS: OWNER };
const cfg = gateConfig(GATE);
if (!cfg || cfg === "misconfigured") throw new Error("test config");

const ASK = "Client looking for a 2 bed house in Maraval under 1.2M";
const ASK_ID = "ask-1";
const OTHER_ASK = "Client needs a 3 bed house for sale in Maraval, 2m budget";
const OTHER_ASK_ID = "ask-2";
const RENT: LiveRequest = { intent: "rent", area: "Westmoorings", beds: 2, propertyType: "apartment", priceMin: null, priceMax: 9000, currency: "TTD", monthly: true };

const msg = (body: string, id: string) => ({ messageId: id, chatId: "group-1@g.us", sender: "18685550101@c.us", senderName: "Test Agent", chatName: "Test Group", body, hasText: true, textOnly: true, fromMe: false, mediaUrls: [], sentAt: SENT as string | null });
const stored = (body: string, id: string) => postRecordOf({ message: msg(body, id), phone: AGENT_PHONE, interpretation: interpret(body), sentAt: SENT });

const SEAM: CrmSeam = {
  ...NOT_CONNECTED,
  connected: true,
  agents: async () => [
    { id: 7, name: "Kerry", email: AGENT, phone: AGENT_PHONE },
    { id: 8, name: "Eve", email: OTHER_AGENT, phone: OTHER_PHONE },
  ],
};

/** Two buyer asks in the store, both live on Kerry's WhatsApp number: the posts are the demand, the live rows are the desk's cards. */
function seeded() {
  const root = mkdtempSync(join(tmpdir(), "not-a-lead-"));
  const store = new PeriskopeStore(root);
  store.reprojectObservation([stored(ASK, ASK_ID), stored(OTHER_ASK, OTHER_ASK_ID)]);
  for (const messageId of [ASK_ID, OTHER_ASK_ID]) {
    store.addLive({ messageId, chatId: "group-1@g.us", senderPhone: AGENT_PHONE, receivedAt: SENT, request: RENT, status: "matched", matchedAt: SENT, matches: [] });
  }
  return { root, store, id: requestIdOf(ASK_ID), other: requestIdOf(OTHER_ASK_ID) };
}

/** A staff request to the route, signed in as `email` (or signed out with null). */
const mark = async (body: unknown, email: string | null, root: string, env: Record<string, string> = GATE) =>
  setNotALead(
    new Request("https://bops.example/api/realty/not-a-lead", {
      method: "POST",
      headers: { "content-type": "application/json", ...(email ? { cookie: `${GATE_COOKIE}=${await makeSession(email, cfg)}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { env, root, now: () => NOW, seam: SEAM },
  );

const demandIds = (root: string) => withSearchStore(root, (s) => s.search({ kind: "demand", limit: 50 }).rows.flatMap((r) => r.messageIds));

test("a status of ignored is excluded from demand: the rule, the Automatch ask, and the store's demand list", () => {
  const demand: DemandRow = { id: "d-1", area: "Maraval", development: null, beds: 2, price: 1_200_000, currency: "TTD", type: "house", listingType: "sale", lastSentAt: SENT, status: "ignored" };
  assert.equal(excludedDemand(demand), true);
  assert.equal(askOf(demand), null, "an ignored ask is not an Automatch ask");
  assert.notEqual(askOf({ ...demand, status: null }), null, "the same ask, not ignored, is one");

  const { root, store, id } = seeded();
  assert.equal(store.demand().length, 2);
  store.setKindOverride({ messageId: ASK_ID, status: "ignored", by: OWNER, reason: "Not a lead" });
  store.reprojectObservation(store.posts());
  assert.deepEqual(store.demand().map((p) => p.messageId), [OTHER_ASK_ID]);
  syncFromJsonl(root, { force: true });
  assert.deepEqual(demandIds(root), [OTHER_ASK_ID], "search drops it too");
  assert.equal(id.length, 24);
});

test("an owner marks any request in the store: 200, changed, and the override records who, why and when", async () => {
  const { root, store, id } = seeded();
  const r = await mark({ requestId: id }, OWNER, root);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { requestId: id, notALead: true, changed: true });
  const over = store.kindOverrides().find((o) => o.messageId === ASK_ID);
  assert.equal(over?.status, "ignored");
  assert.equal(over?.reason, "Not a lead");
  assert.equal(over?.by, OWNER);
  assert.equal(over?.at, NOW.toISOString());
  assert.deepEqual(demandIds(root), [OTHER_ASK_ID], "reproject and sync drop it from demand and search at once");
  assert.equal(store.liveShown().some((r) => r.messageId === ASK_ID), false, "and from the desk's live list");
  assert.equal(store.live().some((r) => r.messageId === ASK_ID), true, "the request itself is kept, only hidden");
});

test("the agent whose desk shows the request can mark it; the agent who can't see it gets 403, and nothing is written", async () => {
  const { root, store, id, other } = seeded();
  const refused = await mark({ requestId: id }, OTHER_AGENT, root);
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: "That request isn't yours." });
  assert.deepEqual(store.kindOverrides(), [], "the refusal writes nothing");
  assert.equal((await mark({ requestId: id }, AGENT, root)).status, 200, "Kerry's own request");
  assert.equal(store.kindOverrides().find((o) => o.messageId === ASK_ID)?.by, AGENT);
  assert.equal((await mark({ requestId: other }, AGENT, root)).body.changed, true);
});

test("the route is staff-gated: 401 signed out, 403 on the public demo, 503 when the gate is set up wrong; nothing is written", async () => {
  const { root, store, id } = seeded();
  assert.equal((await mark({ requestId: id }, null, root)).status, 401);
  assert.equal((await mark({ requestId: id }, OWNER, root, { ...GATE, ONEON1_PUBLIC_DEMO: "1" })).status, 403);
  assert.equal((await mark({ requestId: id }, OWNER, root, { ...GATE, BOPS_GATE_SECRET: "short" })).status, 503);
  assert.deepEqual(store.kindOverrides(), []);
});

test("an unknown request is 404, a malformed request id is 400, and a body that isn't JSON is 400; nothing is written", async () => {
  const { root, store, id } = seeded();
  assert.equal((await mark({ requestId: requestIdOf("nobody") }, OWNER, root)).status, 404);
  assert.equal((await mark({ requestId: "NOT-A-REQUEST-ID" }, OWNER, root)).status, 400);
  assert.equal((await mark({ requestId: id.slice(0, 23) }, OWNER, root)).status, 400);
  assert.equal((await mark("not json", OWNER, root)).status, 400);
  assert.deepEqual(store.kindOverrides(), []);
});

test("marking again is idempotent: changed false, and the first setter and time stay", async () => {
  const { root, store, id } = seeded();
  await mark({ requestId: id }, OWNER, root);
  const again = await mark({ requestId: id }, AGENT, root);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { requestId: id, notALead: true, changed: false });
  const over = store.kindOverrides().find((o) => o.messageId === ASK_ID);
  assert.equal(over?.by, OWNER, "the first setter stays");
  assert.equal(store.kindOverrides().length, 1);
});

test("clear takes the flag off again: the request returns to demand and the desk, and other override fields are kept", async () => {
  const { root, store, id } = seeded();
  store.setKindOverride({ messageId: ASK_ID, set: "demand", area: "Maraval", by: "cli", reason: "buyer request" });
  await mark({ requestId: id }, OWNER, root);
  const cleared = await mark({ requestId: id, clear: true }, OWNER, root);
  assert.deepEqual(cleared.body, { requestId: id, notALead: false, changed: true });
  const over = store.kindOverrides().find((o) => o.messageId === ASK_ID);
  assert.equal(over?.status, null);
  assert.equal(over?.set, "demand", "the side correction is kept");
  assert.equal(over?.area, "Maraval", "the place correction is kept");
  assert.equal(store.liveShown().some((r) => r.messageId === ASK_ID), true);
  assert.deepEqual([...demandIds(root)].sort(), [ASK_ID, OTHER_ASK_ID].sort());
  assert.deepEqual(await mark({ requestId: id, clear: true }, OWNER, root), { status: 200, body: { requestId: id, notALead: false, changed: false } }, "clearing twice changes nothing");
});

test("the route is an agent API for POST only, so agents can reach it through the gate", () => {
  assert.equal(agentMayReach("/api/realty/not-a-lead", "POST"), true);
  assert.equal(agentMayReach("/api/realty/not-a-lead", "GET"), false);
  assert.equal(agentMayReach("/api/realty/not-a-lead/extra", "POST"), false);
});
