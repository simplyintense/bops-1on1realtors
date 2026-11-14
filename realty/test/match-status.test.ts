import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GATE_COOKIE, gateConfig, makeSession } from "../../lib/gate.ts";
import { digestOf, liveDesk, type LiveRequest } from "../flow/live-match.ts";
import { applyStatus, followUpsOf, listingKey, parseStatusPost, type StatusRow } from "../flow/match-status.ts";
import type { MatchItem } from "../flow/recommendations.ts";
import { setMatchFollowUp } from "../node/match-status.ts";
import { purgeExpiredPeriskope } from "../node/periskope-intake.ts";
import { PeriskopeStore, requestIdOf } from "../node/periskope-store.ts";

/**
 * Match follow-up status (Contacted, Not a fit, Closed): the rules (realty/flow/match-status.ts), the desk's hiding, the digest's
 * detail, and the staff route (realty/node/match-status.ts). Bops's own store only: nothing is sent and the CRM is never called.
 */

const NOW = new Date("2026-11-13T20:00:00.000Z");
const OWNER = "miles@1on1.example";
const AGENT = "kerry@1on1.example";
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example", BOPS_OWNER_EMAILS: OWNER };
const cfg = gateConfig(GATE);
if (!cfg || cfg === "misconfigured") throw new Error("test config");

const RENT: LiveRequest = { intent: "rent", area: "Westmoorings", beds: 2, propertyType: "apartment", priceMin: null, priceMax: 9000, currency: "TTD", monthly: true };
const hit = (title: string, url: string | null = `https://example.com/listing/${title.toLowerCase()}`, source: string | null = "Example Realty"): MatchItem => ({
  title,
  url,
  area: "Westmoorings",
  price: "TT$8,500",
  beds: 2,
  source,
  reason: "Same area",
});
const ALPHA = hit("Alpha");
const BRAVO = hit("Bravo");
const CHARLIE = hit("Charlie");

/** Three requests on the desk: msg-a (two matches), msg-b (one), msg-c (none: nothing fits yet). Ids are the WhatsApp message ids. */
function seeded() {
  const root = mkdtempSync(join(tmpdir(), "match-status-"));
  const store = new PeriskopeStore(root);
  const add = (messageId: string, receivedAt: string, matches: MatchItem[]) =>
    store.addLive({ messageId, chatId: "group-1", senderPhone: "+18685550101", receivedAt, request: RENT, status: "matched", matchedAt: receivedAt, matches });
  add("msg-a", "2026-11-13T18:00:00.000Z", [ALPHA, BRAVO]);
  add("msg-b", "2026-11-13T17:00:00.000Z", [CHARLIE]);
  add("msg-c", "2026-11-13T16:00:00.000Z", []);
  return { root, store, a: requestIdOf("msg-a"), b: requestIdOf("msg-b"), c: requestIdOf("msg-c") };
}

const set = (store: PeriskopeStore, requestId: string, m: MatchItem, status: StatusRow["status"] | null, by = AGENT, at = "2026-11-13T19:00:00.000Z") =>
  store.setMatchStatus({ requestId, listingKey: listingKey(m), status, by, at });

/** A staff request to the route, signed in as `email` (or signed out with null). */
const post = async (body: unknown, email: string | null, env: Record<string, string> = GATE, root?: string) =>
  setMatchFollowUp(
    new Request("https://bops.example/api/realty/match-status", {
      method: "POST",
      headers: { "content-type": "application/json", ...(email ? { cookie: `${GATE_COOKIE}=${await makeSession(email, cfg)}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { env, root, now: () => NOW },
  );

test("a listing's identity is its url, or its title and source when there's no url; the same title from two agencies is two listings", () => {
  assert.equal(listingKey(ALPHA), "url:https://example.com/listing/alpha");
  assert.equal(listingKey(hit("Alpha", null, "Example Realty")), "title:Alpha|Example Realty");
  assert.notEqual(listingKey(hit("Alpha", null, "Example Realty")), listingKey(hit("Alpha", null, "Other Realty")));
});

test("set, same again (nothing changes: the first setter and time stay), a different status overwrites, and null clears", () => {
  const rows: StatusRow[] = [];
  const first = applyStatus(rows, { requestId: "r", listingKey: "k", status: "contacted", by: AGENT, at: "t1" });
  assert.equal(first.changed, true);
  const again = applyStatus(first.rows, { requestId: "r", listingKey: "k", status: "contacted", by: OWNER, at: "t2" });
  assert.equal(again.changed, false, "idempotent");
  assert.deepEqual(again.rows, first.rows, "the stored row is unchanged, so who and when stay");
  const over = applyStatus(again.rows, { requestId: "r", listingKey: "k", status: "not-a-fit", by: OWNER, at: "t3" });
  assert.deepEqual(over.rows, [{ requestId: "r", listingKey: "k", status: "not-a-fit", by: OWNER, at: "t3" }]);
  const cleared = applyStatus(over.rows, { requestId: "r", listingKey: "k", status: null, by: OWNER, at: "t4" });
  assert.deepEqual(cleared.rows, []);
  assert.equal(cleared.changed, true);
  assert.equal(applyStatus(cleared.rows, { requestId: "r", listingKey: "k", status: null, by: OWNER, at: "t5" }).changed, false, "clearing nothing is a no-op");
  // Another request's or listing's status is never touched.
  const two = applyStatus(first.rows, { requestId: "other", listingKey: "k", status: "closed", by: AGENT, at: "t6" });
  assert.equal(two.rows.length, 2);
});

test("the POST body is validated: the three statuses or null, a request id and a listing key; anything else is a 400 with the reason", () => {
  const ok = { requestId: requestIdOf("msg-a"), listingKey: "url:https://example.com/x", status: "closed" };
  assert.deepEqual(parseStatusPost(ok), { ok: true, post: ok });
  assert.deepEqual(parseStatusPost({ ...ok, status: null }), { ok: true, post: { ...ok, status: null } });
  assert.equal(parseStatusPost({ ...ok, status: "won" }).ok, false);
  assert.equal(parseStatusPost({ ...ok, status: undefined }).ok, false, "a missing status is not a clear");
  assert.equal(parseStatusPost({ ...ok, requestId: "msg-a" }).ok, false, "a WhatsApp message id isn't a request id");
  assert.equal(parseStatusPost({ ...ok, listingKey: "" }).ok, false);
  assert.equal(parseStatusPost({ ...ok, listingKey: "x".repeat(2001) }).ok, false);
  assert.equal(parseStatusPost(["not", "an", "object"]).ok, false);
  assert.equal(parseStatusPost(null).ok, false);
});

test("the desk hides not-a-fit and closed matches by default and shows them with showHidden; contacted stays and is labelled", () => {
  const { store, a, b, c } = seeded();
  set(store, a, ALPHA, "not-a-fit");
  set(store, a, BRAVO, "closed");
  set(store, b, CHARLIE, "contacted");
  const rows = store.live();
  const statuses = store.matchStatuses();
  const ids = (showHidden: boolean) => liveDesk({ email: OWNER, owner: true, agents: [], rows, statuses, showHidden }).unassigned?.map((x) => x.requestId);

  assert.deepEqual(ids(false), [b, c], "msg-a has no visible match left, so it's gone; msg-c never had one, so it stays");
  assert.deepEqual(ids(true), [a, b, c]);

  const bCard = liveDesk({ email: OWNER, owner: true, agents: [], rows, statuses }).unassigned?.find((x) => x.requestId === b);
  assert.equal(bCard?.matches.length, 1, "contacted is still a match on the desk");
  assert.equal(bCard?.follow[listingKey(CHARLIE)]?.status, "contacted");

  const aShown = liveDesk({ email: OWNER, owner: true, agents: [], rows, statuses, showHidden: true }).unassigned?.find((x) => x.requestId === a);
  assert.deepEqual(aShown?.matches.map((m) => m.title), ["Alpha", "Bravo"], "shown again with showHidden");
  assert.equal(aShown?.follow[listingKey(ALPHA)]?.status, "not-a-fit");
});

test("a request with some matches marked keeps the rest on the desk", () => {
  const { store, a } = seeded();
  set(store, a, ALPHA, "not-a-fit");
  const card = liveDesk({ email: OWNER, owner: true, agents: [], rows: store.live(), statuses: store.matchStatuses() }).unassigned?.find((x) => x.requestId === a);
  assert.deepEqual(card?.matches.map((m) => m.title), ["Bravo"]);
});

test("the digest keeps every match with its status, who set it and when, and hides nothing", () => {
  const { store, a } = seeded();
  set(store, a, ALPHA, "not-a-fit", OWNER, "2026-11-13T19:30:00.000Z");
  set(store, a, BRAVO, "contacted", AGENT, "2026-11-13T19:45:00.000Z");
  const d = digestOf(store.live(), NOW, 24, store.matchStatuses());
  assert.equal(d.requests, 3);
  const card = d.cards.find((x) => x.requestId === a);
  assert.deepEqual(card?.matches.map((m) => m.title), ["Alpha", "Bravo"], "the not-a-fit match is still in the digest");
  assert.deepEqual(card?.follow[listingKey(ALPHA)], { status: "not-a-fit", by: OWNER, at: "2026-11-13T19:30:00.000Z" });
  assert.deepEqual(card?.follow[listingKey(BRAVO)], { status: "contacted", by: AGENT, at: "2026-11-13T19:45:00.000Z" });
  assert.deepEqual(followUpsOf(store.matchStatuses(), requestIdOf("msg-c")), {}, "a request with no statuses has none");
});

test("the desk and digest carry the desk's request id, never the WhatsApp message id or a phone number", () => {
  const { store, a } = seeded();
  set(store, a, ALPHA, "closed");
  const desk = JSON.stringify(liveDesk({ email: OWNER, owner: true, agents: [], rows: store.live(), statuses: store.matchStatuses(), showHidden: true }));
  const digest = JSON.stringify(digestOf(store.live(), NOW, 24, store.matchStatuses()));
  for (const json of [desk, digest]) {
    assert.ok(json.includes(a));
    assert.doesNotMatch(json, /msg-a|msg-b|group-1|\+1868/);
  }
});

test("the route: an agent can set a status on a match on the desk; the stored record has the signed-in email and time, and no phone or message", async () => {
  const { root, a } = seeded();
  const body = { requestId: a, listingKey: listingKey(ALPHA), status: "contacted" };
  const r = await post(body, AGENT, GATE, root);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ...body, changed: true });
  const stored = readFileSync(join(root, "match-status.jsonl"), "utf8");
  assert.match(stored, new RegExp(`"by":"${AGENT}"`));
  assert.match(stored, new RegExp(`"at":"${NOW.toISOString()}"`));
  assert.doesNotMatch(stored, /\+1868|msg-a|Good morning/);
});

test("the route is idempotent: the same status again is a success with changed false; a different one overwrites; null clears", async () => {
  const { root, store, a } = seeded();
  const key = listingKey(ALPHA);
  assert.equal((await post({ requestId: a, listingKey: key, status: "closed" }, AGENT, GATE, root)).body.changed, true);
  const again = await post({ requestId: a, listingKey: key, status: "closed" }, OWNER, GATE, root);
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false);
  assert.equal(store.matchStatuses()[0].by, AGENT, "the first setter stays");
  assert.equal((await post({ requestId: a, listingKey: key, status: "not-a-fit" }, OWNER, GATE, root)).body.changed, true);
  assert.equal(store.matchStatuses()[0].status, "not-a-fit");
  const cleared = await post({ requestId: a, listingKey: key, status: null }, OWNER, GATE, root);
  assert.equal(cleared.body.changed, true);
  assert.deepEqual(store.matchStatuses(), []);
});

test("the route refuses what isn't on the desk: an unknown request, a listing that isn't its match, a bad body", async () => {
  const { root, a } = seeded();
  assert.equal((await post({ requestId: requestIdOf("nobody"), listingKey: listingKey(ALPHA), status: "contacted" }, AGENT, GATE, root)).status, 404);
  assert.equal((await post({ requestId: a, listingKey: listingKey(CHARLIE), status: "contacted" }, AGENT, GATE, root)).status, 404);
  assert.equal((await post({ requestId: a, listingKey: listingKey(ALPHA), status: "won" }, AGENT, GATE, root)).status, 400);
  assert.equal((await post("not json", AGENT, GATE, root)).status, 400);
  assert.deepEqual(new PeriskopeStore(root).matchStatuses(), []);
});

test("the route is staff-gated: 401 signed out, 403 on the public demo, 503 when the gate is set up wrong; nothing is written", async () => {
  const { root, store, a } = seeded();
  const body = { requestId: a, listingKey: listingKey(ALPHA), status: "contacted" };
  assert.equal((await post(body, null, GATE, root)).status, 401);
  assert.equal((await post(body, AGENT, { ...GATE, ONEON1_PUBLIC_DEMO: "1" }, root)).status, 403);
  assert.equal((await post(body, AGENT, { ...GATE, BOPS_GATE_SECRET: "short" }, root)).status, 503);
  assert.deepEqual(store.matchStatuses(), []);
});

test("the route never touches the CRM or the network: it answers with fetch and the CRM refusing everything", async () => {
  const { root, a } = seeded();
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("no network in tests");
  }) as typeof fetch;
  try {
    const env = { ...GATE, ONEON1_CRM_URL: "https://crm.example", ONEON1_CRM_TOKEN: "t" };
    const r = await post({ requestId: a, listingKey: listingKey(ALPHA), status: "closed" }, AGENT, env, root);
    assert.equal(r.status, 200);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = real;
  }
});

test("purge takes a request's statuses with it, as it takes the request", () => {
  const { store, a } = seeded();
  set(store, a, ALPHA, "contacted");
  assert.equal(store.matchStatuses().length, 1);
  purgeExpiredPeriskope(store, new Date(NOW.getTime() + 61 * 86_400_000), {});
  assert.equal(store.live().length, 0);
  assert.deepEqual(store.matchStatuses(), []);
});
