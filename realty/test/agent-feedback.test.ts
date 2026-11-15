import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GATE_COOKIE, gateConfig, makeSession } from "../../lib/gate.ts";
import { MemoryAreaResolver } from "../flow/areas.ts";
import { agentFeedbackSummary, areaPairKey, learnFromFeedback, listingFingerprint, NEARBY_WRONG_AREA_POINTS, ourListingKey } from "../flow/agent-feedback.ts";
import { automatchPairs, type AutomatchPair } from "../flow/automatch.ts";
import type { CrmSeam, SeamAgent } from "../flow/crm-seam.ts";
import { listingKey, type StatusRow } from "../flow/match-status.ts";
import type { Listing } from "../flow/source.ts";
import { automatchRun } from "../node/automatch.ts";
import { setMatchFollowUp } from "../node/match-status.ts";
import { PeriskopeStore, requestIdOf } from "../node/periskope-store.ts";

/**
 * What agents told Bops (flow/agent-feedback.ts): the three rules that change Automatch's pairs, run through the real Automatch
 * pipeline (automatchRun, a fake CRM seam and a demand file in a temp root), and the Teach Bops summary. Invented people, 555-style
 * numbers and listings only. Nothing here calls out.
 */

const NOW = new Date("2026-11-15T12:00:00.000Z");
const DAY = 86_400_000;
const OWNER = "owner@1on1.example";
const DANA = "dana@1on1.example";
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example", BOPS_OWNER_EMAILS: OWNER };
const cfg = gateConfig(GATE);
if (!cfg || cfg === "misconfigured") throw new Error("test config");

/* Places: Westmoorings and Glencoe are neighbours; Maraval is far from both. */
const PLACES = [
  { name: "Westmoorings", region: "North West" as const, neighbours: ["Glencoe"] },
  { name: "Glencoe", region: "North West" as const, neighbours: ["Westmoorings"] },
  { name: "Maraval", region: "North West" as const, neighbours: [] },
];
const AREAS = new MemoryAreaResolver(PLACES);

const DANA_AGENT: SeamAgent = { id: 7, name: "Dana Holder", email: DANA, phone: null };

/** An active rent listing held by agent 7 (Dana) unless overridden. Invented. */
const LISTING = (over: Partial<Listing> = {}): Listing => ({
  id: "1",
  title: "Test flat, Westmoorings",
  listingType: "rent",
  area: "Westmoorings",
  price: 9000,
  currency: "TTD",
  beds: 2,
  baths: 1,
  agentId: 7,
  status: "active",
  url: "https://1on1realtors.com/property/test-flat-westmoorings",
  ...over,
});

/** The four listings: two in Westmoorings (the asks' area), two in Glencoe (a neighbour). */
const L1 = LISTING();
const L2 = LISTING({ id: "2", title: "Test flat, Westmoorings two", url: "https://1on1realtors.com/property/test-flat-westmoorings-two" });
const L3 = LISTING({ id: "3", title: "Test flat, Glencoe", area: "Glencoe", url: "https://1on1realtors.com/property/test-flat-glencoe" });
const L4 = LISTING({ id: "4", title: "Test flat, Glencoe two", area: "Glencoe", url: "https://1on1realtors.com/property/test-flat-glencoe-two" });

/** A demand post (a rent ask, 2 beds, TT$9,000, seen two days ago), from its own invented sender. */
const ask = (messageId: string, area: string, senderPhone: string) => ({
  messageId,
  chatId: "chat-test@g.us",
  groupName: "Test Group A",
  sentAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
  category: "buyer_request",
  senderPhone,
  senderName: "Test Renter",
  area,
  price: 9000,
  currency: "TTD",
  beds: 2,
  type: "apartment",
  listingType: "rent",
  originalText: "Invented test ask",
});
/** A1 and A2 ask in Westmoorings; A3 asks in Glencoe. Each from its own sender, so none are folded together. */
const A1 = { id: "msg-a1", rid: requestIdOf("msg-a1"), row: ask("msg-a1", "Westmoorings", "+18685550199") };
const A2 = { id: "msg-a2", rid: requestIdOf("msg-a2"), row: ask("msg-a2", "Westmoorings", "+18685550198") };
const A3 = { id: "msg-a3", rid: requestIdOf("msg-a3"), row: ask("msg-a3", "Glencoe", "+18685550197") };

function storeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-feedback-"));
  writeFileSync(join(root, "demand.jsonl"), [A1, A2, A3].map((a) => `${JSON.stringify(a.row)}\n`).join(""));
  return root;
}

function fakeSeam(listings: Listing[], agents: SeamAgent[] = [DANA_AGENT]): CrmSeam {
  return {
    connected: true,
    async listings() {
      return { status: "ok", listings };
    },
    async agents() {
      return agents;
    },
  };
}

/** The Automatch run over a seam and root, with the test's areas and clock. */
const run = (seam: CrmSeam, root: string) => automatchRun({ seam, root, areas: AREAS, now: NOW, env: GATE });

/** One row's key in the Automatch result: the ask's desk id and the listing's key. Invented listings only. */
const pairKeyOf = (r: { ask: { postId: string | null }; listingKey: string }) => `${r.ask.postId}|${r.listingKey}`;
const keysOf = async (seam: CrmSeam, root: string) => new Set((await run(seam, root)).result.pairs.map(pairKeyOf));
const scoreOf = async (seam: CrmSeam, root: string, a: { rid: string }, l: Listing) => (await run(seam, root)).result.pairs.find((p) => p.ask.postId === a.rid && p.listingKey === ourListingKey(l))?.score;

/** A staff request to the route, signed in as `email`. */
const post = async (body: unknown, email: string, root: string, seam: CrmSeam) =>
  setMatchFollowUp(
    new Request("https://bops.example/api/realty/match-status", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${GATE_COOKIE}=${await makeSession(email, cfg)}` },
      body: JSON.stringify(body),
    }),
    { env: GATE, seam, root, areas: AREAS, now: () => NOW },
  );

const outcome = (a: { rid: string }, l: Listing, status: string, reason?: string, note?: string) => ({
  requestId: a.rid,
  listingKey: ourListingKey(l),
  status,
  ...(reason ? { reason } : {}),
  ...(note ? { note } : {}),
});

/* ---------------- The pure helpers ---------------- */

test("a listing's fingerprint is its CRM id, price, beds and type; a changed price, beds or type changes it, and so does a new id", () => {
  assert.equal(listingFingerprint(L1), "1|9000|2|rent");
  assert.notEqual(listingFingerprint(L1), listingFingerprint({ ...L1, price: 8500 }));
  assert.notEqual(listingFingerprint(L1), listingFingerprint({ ...L1, beds: 3 }));
  assert.notEqual(listingFingerprint(L1), listingFingerprint({ ...L1, listingType: "sale" }));
  assert.notEqual(listingFingerprint(L1), listingFingerprint({ ...L1, id: "9" }));
  const renamed = { ...L1, title: "Renamed", url: "https://example.com/other" };
  assert.equal(listingFingerprint(renamed), listingFingerprint(L1), "a title or url change alone is not a re-listing");
});

test("an area pair is the same either way round, and blank or capitalised names match", () => {
  assert.equal(areaPairKey("Westmoorings", "Glencoe"), areaPairKey("glencoe", " Westmoorings "));
  assert.notEqual(areaPairKey("Westmoorings", "Glencoe"), areaPairKey("Westmoorings", "Maraval"));
});

test("the listing key is the same as a live match's: the url when there is one, else the title and our agency", () => {
  assert.equal(ourListingKey(L1), listingKey({ url: L1.url, title: L1.title, source: "1on1 Realtors" }));
  assert.equal(ourListingKey({ id: "5", title: "", url: "" }), listingKey({ url: null, title: "1on1 Realtors listing 5", source: "1on1 Realtors" }));
});

/* ---------------- Rule 1: listing-unavailable ---------------- */

test("rule 1: a listing reported unavailable is not matched while it's present with the same fingerprint, and every ask loses it", async () => {
  const root = storeRoot();
  const seam = fakeSeam([L1, L2]);
  const before = await keysOf(seam, root);
  assert.ok(before.has(`${A1.rid}|${ourListingKey(L2)}`) && before.has(`${A2.rid}|${ourListingKey(L2)}`));

  const r = await post(outcome(A1, L2, "not-a-fit", "listing-unavailable"), DANA, root, seam);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await keysOf(seam, root);
  assert.ok(!after.has(`${A1.rid}|${ourListingKey(L2)}`), "A1's pair for L2 is gone");
  assert.ok(!after.has(`${A2.rid}|${ourListingKey(L2)}`), "A2's pair for L2 is gone too: the listing is not matched");
  assert.ok(after.has(`${A1.rid}|${ourListingKey(L1)}`), "other listings still match");
});

test("rule 1: the same listing still present with the same fingerprint stays suppressed on every later run", async () => {
  const root = storeRoot();
  const seam = fakeSeam([L1, L2]);
  await post(outcome(A1, L2, "closed", "listing-unavailable"), DANA, root, seam);
  assert.equal((await keysOf(seam, root)).has(`${A2.rid}|${ourListingKey(L2)}`), false);
  assert.equal((await keysOf(fakeSeam([L1, L2]), root)).has(`${A2.rid}|${ourListingKey(L2)}`), false, "a later run, unchanged, is still suppressed");
});

test("rule 1: once the listing is re-listed (its fingerprint changed) it matches again", async () => {
  const root = storeRoot();
  const seam = fakeSeam([L1, L2]);
  await post(outcome(A1, L2, "not-a-fit", "listing-unavailable"), DANA, root, seam);
  const relisted = fakeSeam([L1, { ...L2, price: 8500 }]);
  const again = await keysOf(relisted, root);
  assert.ok(again.has(`${A1.rid}|${ourListingKey(L2)}`), "a new price is a re-listing: A1 matches L2 again");
  assert.ok(again.has(`${A2.rid}|${ourListingKey(L2)}`), "and so does every ask");
});

test("rule 1: a listing that has left the active list has no pairs, and the other listing is untouched", async () => {
  const root = storeRoot();
  await post(outcome(A1, L2, "not-a-fit", "listing-unavailable"), DANA, root, fakeSeam([L1, L2]));
  const gone = await keysOf(fakeSeam([L1]), root);
  assert.ok(!gone.has(`${A1.rid}|${ourListingKey(L2)}`));
  assert.ok(gone.has(`${A1.rid}|${ourListingKey(L1)}`), "the other listing is untouched");
});

test("rule 1: Automatch only reads, so it doesn't remember a listing that left: the same listing back unchanged stays suppressed (a changed fingerprint lifts it)", async () => {
  const root = storeRoot();
  await post(outcome(A1, L2, "not-a-fit", "listing-unavailable"), DANA, root, fakeSeam([L1, L2]));
  await keysOf(fakeSeam([L1]), root);
  const back = await keysOf(fakeSeam([L1, L2]), root);
  assert.ok(!back.has(`${A1.rid}|${ourListingKey(L2)}`), "back with the same id, price, beds and type: still suppressed");
  assert.ok((await keysOf(fakeSeam([L1, { ...L2, id: "22" }]), root)).has(`${A1.rid}|${ourListingKey(L2)}`), "re-listed under a new CRM id: matches again");
});

/* ---------------- Rule 2: wrong-area on a nearby pair ---------------- */

test("rule 2: a not-a-fit with wrong-area lowers the nearby pair's area score, for that area pair only; a same-area pair doesn't change", async () => {
  const root = storeRoot();
  const seam = fakeSeam([L1, L3, L4]);
  const nearbyBefore = await scoreOf(seam, root, A1, L3);
  const sameBefore = await scoreOf(seam, root, A1, L1);
  assert.ok(nearbyBefore !== undefined && sameBefore !== undefined);
  assert.equal(sameBefore - nearbyBefore, 15, "before: a nearby pair is 15 area points below a same-area one");

  const r = await post(outcome(A1, L3, "not-a-fit", "wrong-area"), DANA, root, seam);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const nearbyAfter = await scoreOf(seam, root, A1, L3);
  assert.equal(nearbyAfter, nearbyBefore - (15 - NEARBY_WRONG_AREA_POINTS), "the nearby pair's score drops (15 area points become 5)");
  assert.equal(await scoreOf(seam, root, A1, L1), sameBefore, "a same-area pair is not lowered");
});

test("rule 2: one report applies to every later nearby pair of those two areas, either direction, and not to other areas", async () => {
  const root = storeRoot();
  const seam = fakeSeam([L1, L3, L4]);
  const l4Before = await scoreOf(seam, root, A1, L4);
  const a3L1Before = await scoreOf(seam, root, A3, L1);
  const a3L3Before = await scoreOf(seam, root, A3, L3);
  assert.ok(l4Before !== undefined && a3L1Before !== undefined && a3L3Before !== undefined);

  await post(outcome(A1, L3, "not-a-fit", "wrong-area"), DANA, root, seam);

  assert.equal(await scoreOf(seam, root, A1, L4), l4Before - 10, "another Glencoe listing, same asks' area: also lowered");
  assert.equal(await scoreOf(seam, root, A3, L1), a3L1Before - 10, "the other way round (a Glencoe ask, a Westmoorings listing): lowered");
  assert.equal(await scoreOf(seam, root, A3, L3), a3L3Before, "a Glencoe ask on a Glencoe listing is the same area: not lowered");
});

test("rule 2: a lowered pair is rescored, its band can change, and its reason says why; a pair of another area is untouched", async () => {
  const root = storeRoot();
  const seam = fakeSeam([L1, L3, L4]);
  const { result } = await run(seam, root);
  const nearby = result.pairs.find((p) => p.ask.postId === A1.rid && p.listingKey === ourListingKey(L3));
  assert.ok(nearby && nearby.score >= 75, "a strong nearby pair to start");
  await post(outcome(A1, L3, "not-a-fit", "wrong-area"), DANA, root, seam);
  const lowered = (await run(seam, root)).result.pairs.find((p) => p.ask.postId === A1.rid && p.listingKey === ourListingKey(L3));
  assert.equal(lowered?.score, nearby.score - 10);
  assert.match(lowered?.reason ?? "", /lowered after an agent marked this area wrong/);
});

test("rule 2 needs the outcome not-a-fit: a wrong-area reason on another outcome changes nothing", async () => {
  const root = storeRoot();
  const seam = fakeSeam([L1, L3]);
  const before = await scoreOf(seam, root, A1, L3);
  await post(outcome(A1, L3, "contacted", "wrong-area"), DANA, root, seam);
  assert.equal(await scoreOf(seam, root, A1, L3), before);
});

/* ---------------- Rule 3: client-not-interested ---------------- */

test("rule 3: client-not-interested suppresses only that ask and listing; the listing still matches other asks, and the ask still matches other listings", async () => {
  const root = storeRoot();
  const seam = fakeSeam([L1, L2]);
  const before = await keysOf(seam, root);
  assert.ok(before.has(`${A1.rid}|${ourListingKey(L1)}`) && before.has(`${A2.rid}|${ourListingKey(L1)}`));

  await post(outcome(A1, L1, "not-a-fit", "client-not-interested"), DANA, root, seam);
  const after = await keysOf(seam, root);
  assert.ok(!after.has(`${A1.rid}|${ourListingKey(L1)}`), "that ask and listing: gone");
  assert.ok(after.has(`${A2.rid}|${ourListingKey(L1)}`), "the same listing for another ask: still matches");
  assert.ok(after.has(`${A1.rid}|${ourListingKey(L2)}`), "the same ask for another listing: still matches");
});

/* ---------------- Other reasons are kept and change nothing ---------------- */

test("the other reasons are stored and change no matching: the pairs are the same as with no feedback", async () => {
  const root = storeRoot();
  const seam = fakeSeam([L1, L2, L3]);
  const before = await keysOf(seam, root);
  const scoreBefore = await scoreOf(seam, root, A1, L3);
  for (const reason of ["over-budget", "wrong-type-or-size", "client-unreachable", "already-with-another-agent", "other"] as const) {
    await post(outcome(A1, L3, "not-a-fit", reason, "Invented note"), DANA, root, seam);
  }
  assert.deepEqual(await keysOf(seam, root), before);
  assert.equal(await scoreOf(seam, root, A1, L3), scoreBefore);
  assert.equal(new PeriskopeStore(root).matchStatuses().length, 1, "only the last reason is held for the pair");
});

/* ---------------- The pure rule functions ---------------- */

/** Pairs straight from the matcher (no Automatch run), for the pure rule tests. */
async function pairsFor(listings: Listing[], asks: { id: string; area: string; listingType: "rent" }[]): Promise<AutomatchPair[]> {
  const askRows = asks.map((a) => ({ id: a.id, area: a.area, beds: 2, budget: 9000, currency: "TTD" as const, type: "apartment", listingType: a.listingType, lastSeenAt: new Date(NOW.getTime() - 2 * DAY).toISOString() }));
  return automatchPairs(askRows, listings, AREAS, NOW);
}

const row = (over: Partial<StatusRow> & Pick<StatusRow, "requestId" | "listingKey" | "status">): StatusRow => ({ by: DANA, at: NOW.toISOString(), ...over });

test("the pure rules: a reason on a row for one pair never touches a pair it doesn't name", async () => {
  const pairs = await pairsFor([L1, L3], [{ id: "x1", area: "Westmoorings", listingType: "rent" }]);
  const postIdOf = () => "rid-x1";
  const before = learnFromFeedback(pairs, [], postIdOf);
  assert.equal(before.length, 2);
  const other = learnFromFeedback(pairs, [row({ requestId: "someone-else", listingKey: ourListingKey(L1), status: "not-a-fit", reason: "client-not-interested" })], postIdOf);
  assert.equal(other.length, 2, "another request's client-not-interested drops nothing here");
  const sameListing = learnFromFeedback(pairs, [row({ requestId: "rid-x1", listingKey: ourListingKey(L1), status: "not-a-fit", reason: "client-not-interested" })], postIdOf);
  assert.deepEqual(sameListing.map((p) => p.listing.id), ["3"]);
});

test("the pure rules: a wrong-area report needs the pair's areas on it; without them nothing is lowered", async () => {
  const pairs = await pairsFor([L3], [{ id: "x1", area: "Westmoorings", listingType: "rent" }]);
  const noContext = row({ requestId: "r", listingKey: ourListingKey(L3), status: "not-a-fit", reason: "wrong-area" });
  assert.equal(learnFromFeedback(pairs, [noContext], () => null)[0].score, pairs[0].score);
  const withContext = { ...noContext, context: { title: L3.title, askArea: "Westmoorings", listingArea: "Glencoe", fingerprint: listingFingerprint(L3) } };
  assert.equal(learnFromFeedback(pairs, [withContext], () => null)[0].score, pairs[0].score - 10);
});

test("the pure rules: an unavailable report with no fingerprint is suppressed while the listing is present", async () => {
  const pairs = await pairsFor([L1], [{ id: "x1", area: "Westmoorings", listingType: "rent" }]);
  const noFp = row({ requestId: "r", listingKey: ourListingKey(L1), status: "closed", reason: "listing-unavailable" });
  assert.equal(learnFromFeedback(pairs, [noFp], () => null).length, 0);
});

test("the learned pairs stay in order: best first, as Automatch lists them", async () => {
  const pairs = await pairsFor([L1, L3, L4, L2], [{ id: "x1", area: "Westmoorings", listingType: "rent" }]);
  const rows = [row({ requestId: "r", listingKey: ourListingKey(L3), status: "not-a-fit", reason: "wrong-area", context: { title: L3.title, askArea: "Westmoorings", listingArea: "Glencoe", fingerprint: listingFingerprint(L3) } })];
  const learned = learnFromFeedback(pairs, rows, () => null);
  const scores = learned.map((p) => p.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

/* ---------------- Teach Bops: what agents told us ---------------- */

test("the summary counts reasons (most first, unused ones left out), lists the newest lines, and keeps phone numbers out of notes", () => {
  const rows: StatusRow[] = [
    row({ requestId: "r1", listingKey: "url:https://example.com/a", status: "not-a-fit", reason: "wrong-area", at: "2026-11-14T10:00:00.000Z", context: { title: "Test flat, Glencoe", askArea: "Westmoorings", listingArea: "Glencoe", fingerprint: "3|9000|2|rent" } }),
    row({ requestId: "r2", listingKey: "title:Test flat, Maraval|1on1 Realtors", status: "closed", reason: "wrong-area", at: "2026-11-15T09:00:00.000Z", by: OWNER }),
    row({ requestId: "r3", listingKey: "url:https://example.com/c", status: "contacted", note: "Call +1 868 555 0199 after 5", at: "2026-11-15T08:00:00.000Z" }),
    row({ requestId: "r4", listingKey: "url:https://example.com/d", status: "not-a-fit", reason: "over-budget", at: "2026-11-13T08:00:00.000Z" }),
    row({ requestId: "r5", listingKey: "url:https://example.com/e", status: "contacted", at: "2026-11-15T11:00:00.000Z" }),
  ];
  const s = agentFeedbackSummary(rows);
  assert.equal(s.total, 4, "a plain outcome with no reason or note is not feedback");
  assert.deepEqual(s.reasons, [
    { reason: "wrong-area", label: "Wrong area", count: 2 },
    { reason: "over-budget", label: "Over budget", count: 1 },
  ]);
  assert.deepEqual(
    s.recent.map((l) => [l.outcome, l.reason, l.title, l.who]),
    [
      ["Closed", "Wrong area", "Test flat, Maraval", OWNER],
      ["Contacted", null, "a listing", DANA],
      ["Not a fit", "Wrong area", "Test flat, Glencoe", DANA],
      ["Not a fit", "Over budget", "a listing", DANA],
    ],
  );
  assert.equal(s.recent[1].note, "Call [number] after 5", "no phone number in the summary");
  assert.doesNotMatch(JSON.stringify(s), /555|\+1868/);
});

test("the summary is empty with no feedback, and the recent lines stop at the limit", () => {
  assert.deepEqual(agentFeedbackSummary([]), { total: 0, reasons: [], recent: [] });
  const many = Array.from({ length: 12 }, (_, i) => row({ requestId: `r${i}`, listingKey: `url:https://example.com/${i}`, status: "not-a-fit", reason: "other", at: `2026-11-${String(10 + i).padStart(2, "0")}T10:00:00.000Z` }));
  const s = agentFeedbackSummary(many);
  assert.equal(s.total, 12);
  assert.equal(s.recent.length, 8);
  assert.equal(s.recent[0].at, "2026-11-21T10:00:00.000Z", "newest first");
});
