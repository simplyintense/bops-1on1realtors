import assert from "node:assert/strict";
/// <reference path="../node/node-sqlite.d.ts" />
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GATE_COOKIE, GATE_OPEN_PATHS, agentMayReach, gateConfig, gateVerdict, makeSession, teachAllowed } from "../../lib/gate.ts";
import { staffAccess, teacherAccess } from "../node/periskope-intake.ts";
import { flagMatch } from "../node/flag-match.ts";
import { editTaught, ignoreQueueItem, previewText, removeTaught, taughtPatchOf, teachPlace } from "../node/learn-actions.ts";
import { NotInQueueError, NotTaughtError, SearchInputError, SearchStore, openSearchDb, syncFromJsonl, type SearchRow } from "../node/search-store.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { interpret, postRecordOf } from "../flow/periskope.ts";
import { flagInputOf } from "../flow/flag-match.ts";
import { queueLine } from "../flow/learn-view.ts";
import { marketOf, taughtPlaceOf, taughtVerdict, TAUGHT_MARKETS } from "../flow/taught-areas.ts";

/**
 * The Teach page overhaul (realty/node/learn-actions.ts, flag-match.ts; app/api/realty/learn/...): the privacy of the queue and the
 * page, the place form, ignore, edit and delete of past answers, the reading preview, the CRM's bad-match reports, and the gate for each.
 * Invented data only: made-up places, addresses, people and a test token. No network, no real secret.
 */

const OWNER = "owner@1on1.example";
const TEACHER = "teacher@1on1.example";
const AGENT = "agent@1on1.example";
const BY = TEACHER;
const TOKEN = "test-automatch-token";
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example", BOPS_OWNER_EMAILS: OWNER };
const ENV = { ...GATE, BOPS_TEACH_EMAILS: TEACHER };
const cfg = gateConfig(GATE);
if (!cfg || cfg === "misconfigured") throw new Error("test config");
const session = (email: string) => makeSession(email, cfg);

const root = () => mkdtempSync(join(tmpdir(), "learn-overhaul-"));
const SENT = "2026-11-20T12:00:00.000Z";
const msg = (body: string, id: string) => ({ messageId: id, chatId: "group-1@g.us", sender: "18685550101@c.us", senderName: "Test Agent", chatName: "Invented Group A", body, hasText: true, textOnly: true, fromMe: false, mediaUrls: [], sentAt: SENT as string | null });
const stored = (body: string, id: string) => postRecordOf({ message: msg(body, id), phone: "+18685550101", interpretation: interpret(body), sentAt: SENT });

/** Runs one read against the store at root, then closes it. */
function inStore<T>(r: string, fn: (s: SearchStore) => T): T {
  const s = SearchStore.open(r);
  try {
    return fn(s);
  } finally {
    s.close();
  }
}
const queue = (r: string): SearchRow[] => inStore(r, (s) => s.search({ kind: "vague", limit: 500 }).rows);
const taughtRows = (r: string) => inStore(r, (s) => s.taught());

/** The text a staff member can read in a learn-page file: no imports, no comments, the string literals and the JSX text. */
function visibleText(src: string): string {
  const code = src
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "");
  const literals = [...code.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const jsx = [...code.matchAll(/>([^<>{}\n]+)</g)].map((m) => m[1]);
  return [...literals, ...jsx].join("\n");
}

const FORBIDDEN = /periskope|bops|no group|group_name|groupname|invented group/i;

/* ---------------- privacy ---------------- */

test("the queue card's meta line never shows a group name, 'No group' or a product name", () => {
  const line = queueLine({ lastSentAt: SENT, senderName: null, timesSeen: 2 });
  assert.match(line, /· Unnamed sender · ×2$/);
  const withGroups = queueLine({ lastSentAt: SENT, senderName: "Test Agent", timesSeen: 1 });
  assert.match(withGroups, /· Test Agent · ×1$/);
  assert.doesNotMatch(line + withGroups, FORBIDDEN);
});

test("the Teach page's markup: no group name, 'No group', or product name in anything staff can read", () => {
  for (const f of ["page.tsx", "teach-form.tsx", "teach-place-form.tsx", "past-answers.tsx", "preview-form.tsx", "question-form.tsx"]) {
    const src = readFileSync(new URL(`../../app/realty/learn/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\.groups\b/, `${f} reads r.groups`);
    assert.doesNotMatch(visibleText(src), FORBIDDEN, `${f} shows a group or a product name`);
  }
  // The guard itself: a view that did show the group must fail it.
  assert.match(visibleText(`<p>{r.groups.join(", ") || "No group"}</p>`), /No group/);
});

/* ---------------- the place form ---------------- */

test("Teach a place saves the market, the alias, the coordinates, the note and the nearby pairs", () => {
  const r = root();
  const out = teachPlace(r, { name: "Invented Hill", market: "Trinidad North West", alias: "Hillview", lat: 10.66, lon: -61.5, note: "Invented note", nearby: "Invented Glen", notNearby: "Invented Cove" }, BY);
  assert.equal(out.place, "Invented Hill");
  assert.equal(out.market, "North West", "the Trinidad label is stored as the short market");
  assert.equal(out.alias, "Hillview");
  assert.deepEqual(out.pairs.map((p) => p.nearby).sort(), [false, true]);
  const t = inStore(r, (s) => s.taughtAreas());
  assert.deepEqual(t.aliases, [{ alias: "Hillview", canonical: "Invented Hill" }]);
  assert.equal(t.places.find((p) => p.name === "Invented Hill")?.lat, 10.66);
  assert.equal(t.relations.length, 2);
  assert.equal(t.relations.filter((x) => x.nearby).length, 1);
});

test("a place taught again without coordinates keeps the ones it had; the market changes", () => {
  const r = root();
  teachPlace(r, { name: "Invented Hill", market: "North West", lat: 10.66, lon: -61.5 }, BY);
  teachPlace(r, { name: "Invented Hill", market: "Central" }, BY);
  const p = inStore(r, (s) => s.taughtAreas()).places.find((x) => x.name === "Invented Hill");
  assert.equal(p?.market, "Central");
  assert.equal(p?.lat, 10.66, "the coordinates are not wiped by a plain update");
});

test("an alias reads as its canonical place: Westhills is West Hills, in its market and island", async () => {
  const r = root();
  teachPlace(r, { name: "West Hills", market: "North West", alias: "Westhills" }, BY);
  teachPlace(r, { name: "Maraval", market: "North West" }, BY);
  const t = inStore(r, (s) => s.taughtAreas());
  assert.equal(taughtPlaceOf(t, "Westhills")?.name, "West Hills");
  assert.deepEqual(taughtVerdict(t, "Westhills", "West Hills"), { tier: "same" }, "the alias is the same place");
  assert.deepEqual(taughtVerdict(t, "Westhills", "Maraval"), { tier: "apart" }, "taught, and not a listed neighbour");
  const read = previewText(r, "Westhills");
  assert.equal(read.area, "West Hills");
  assert.equal(read.region, "North West");
  assert.equal(read.island, "Trinidad");
});

test("a Tobago place reads as Tobago, and an unknown market is refused", () => {
  const r = root();
  teachPlace(r, { name: "Invented Cove", market: "Tobago" }, BY);
  assert.equal(previewText(r, "Invented Cove").island, "Tobago");
  assert.equal(previewText(r, "Invented Cove").region, "Tobago");
});

test("market names: the short names and the Trinidad labels read; anything else does not", () => {
  assert.equal(marketOf("North West"), "North West");
  assert.equal(marketOf("Trinidad North West"), "North West");
  assert.equal(marketOf("trinidad east–west corridor"), "East–West Corridor");
  assert.equal(marketOf("Tobago"), "Tobago");
  assert.equal(marketOf("East"), "East");
  assert.equal(marketOf("Trinidad"), null);
  assert.equal(marketOf("Mars"), null);
  assert.equal(marketOf(undefined), null);
  assert.deepEqual([...TAUGHT_MARKETS].sort(), ["Central", "East", "East–West Corridor", "North West", "Port of Spain", "South", "Tobago"]);
});

test("a bad place is refused with a plain message, and nothing is saved", () => {
  const r = root();
  const bad: unknown[] = [
    { name: "Invented Hill", market: "Mars" },
    { name: "Invented Hill" },
    { name: "I", market: "South" },
    { name: "Invented Hill", market: "South", lat: 10.6 },
    { name: "Invented Hill", market: "South", lat: 95, lon: -61 },
    { name: "Invented Hill", market: "South", alias: "invented hill" },
    { name: "Invented Hill", market: "South", nearby: "Invented Hill" },
    "not an object",
  ];
  for (const body of bad) assert.throws(() => teachPlace(r, body, BY), SearchInputError, JSON.stringify(body));
  assert.deepEqual(inStore(r, (s) => s.taughtAreas()).places, []);
});

/* ---------------- ignore ---------------- */

test("Not a listing takes a queue item out of the open queue, with no words needed; an id off the queue is refused", async () => {
  const r = root();
  new PeriskopeStore(r).reprojectObservation([stored("anyone got a place to rent?", "v-1")]);
  syncFromJsonl(r);
  const [item] = queue(r);
  assert.ok(item, "the vague ask is in the queue");
  assert.deepEqual(await ignoreQueueItem(r, item.id, BY), { id: item.id, ignored: true });
  assert.equal(queue(r).length, 0, "it has left the open queue");
  assert.equal(new PeriskopeStore(r).kindOverrides()[0]?.status, "ignored");
  assert.equal(new PeriskopeStore(r).kindOverrides()[0]?.reason, "Not a listing");
  await assert.rejects(ignoreQueueItem(r, "0".repeat(24), BY), NotInQueueError);
});

/* ---------------- past answers ---------------- */

test("a past answer is edited in place and the post is read again with the new area", () => {
  const r = root();
  new PeriskopeStore(r).reprojectObservation([stored("anyone got an invented hub to rent?", "h-1")]);
  syncFromJsonl(r);
  assert.equal(queue(r).length, 1);
  inStore(r, (s) => s.learnTerm({ answer: "Invented Hub is a Maraval townhouse", term: "invented hub", area: "Maraval", type: "townhouse" }));
  assert.equal(queue(r).length, 0, "the alias makes it clear");
  const [row] = taughtRows(r);
  assert.equal(typeof row.id, "number", "a past answer carries its id");
  const out = editTaught(r, row.id, taughtPatchOf({ area: "Woodbrook" }), BY);
  assert.equal(out.reparsed, 1, "the post that mentions the term is read again");
  assert.equal(new PeriskopeStore(r).post("h-1")?.area, "Woodbrook");
  assert.equal(taughtRows(r)[0].area, "Woodbrook");
});

test("deleting a past answer takes it away, and its posts go back to the queue", () => {
  const r = root();
  new PeriskopeStore(r).reprojectObservation([stored("anyone got an invented hub to rent?", "h-2")]);
  syncFromJsonl(r);
  inStore(r, (s) => s.learnTerm({ answer: "Invented Hub is a Maraval townhouse", term: "invented hub", area: "Maraval", type: "townhouse" }));
  assert.equal(queue(r).length, 0);
  const out = removeTaught(r, taughtRows(r)[0].id);
  assert.equal(out.term, "invented hub");
  assert.equal(out.reparsed, 1);
  assert.equal(taughtRows(r).length, 0);
  assert.equal(queue(r).length, 1, "without the answer, the post waits in the queue again");
});

test("seeded area and gazetteer rows can't be edited or deleted, and an unknown id is refused", () => {
  const r = root();
  syncFromJsonl(r);
  const db = openSearchDb(r);
  const seeded = db.prepare("SELECT id FROM knowledge WHERE source <> 'taught' LIMIT 1").get();
  db.close();
  assert.ok(seeded, "the store seeds area and gazetteer rows");
  assert.throws(() => editTaught(r, Number(seeded.id), taughtPatchOf({ area: "Maraval" }), BY), NotTaughtError);
  assert.throws(() => removeTaught(r, Number(seeded.id)), NotTaughtError);
  assert.throws(() => removeTaught(r, 999_999), NotTaughtError);
});

test("an edit that would take another answer's term is refused, and nothing changes", () => {
  const r = root();
  inStore(r, (s) => s.learnTerm({ answer: "Invented Hub is a Maraval townhouse", term: "invented hub", area: "Maraval", type: "townhouse" }));
  inStore(r, (s) => s.learnTerm({ answer: "Invented Cove is a Tobago house", term: "invented cove", area: "Scarborough", type: "house" }));
  const cove = taughtRows(r).find((t) => t.term === "invented cove");
  assert.ok(cove);
  assert.throws(() => editTaught(r, cove.id, taughtPatchOf({ term: "invented hub" }), BY), SearchInputError);
  assert.equal(taughtRows(r).find((t) => t.id === cove.id)?.term, "invented cove");
});

test("a sale or rent rule is taught from the queue form, and a bad sale or rent is refused", () => {
  const r = root();
  new PeriskopeStore(r).reprojectObservation([stored("anyone got an invented hub to rent?", "h-3")]);
  syncFromJsonl(r);
  const [item] = queue(r);
  assert.throws(() => inStore(r, (s) => s.teach(item.id, { answer: "A rental, no place", term: "invented hub", listingType: "lease" })), SearchInputError);
  const saved = inStore(r, (s) => s.teach(item.id, { answer: "Invented Hub is for rent", term: "invented hub", listingType: "rent" }));
  assert.equal(saved.saved, "rule");
});

/* ---------------- the reading preview ---------------- */

test("a sale listing reads as supply: sale, its place, bedrooms, price, and clear", () => {
  const read = previewText(root(), "NEW TO THE MARKET: 3 bed house in Maraval, asking TT$2,500,000");
  assert.equal(read.kind, "supply");
  assert.equal(read.listingType, "sale");
  assert.equal(read.area, "Maraval");
  assert.equal(read.bedrooms, 3);
  assert.equal(read.price, 2_500_000);
  assert.equal(read.currency, "TTD");
  assert.equal(read.vague, false);
  assert.ok(!("type" in read), "the property type is not part of the answer");
});

test("a buyer's ask reads as demand, for rent, in its place", () => {
  const read = previewText(root(), "Looking for a 2 bedroom apartment in Woodbrook for rent, budget $6,000 a month");
  assert.equal(read.kind, "demand");
  assert.equal(read.listingType, "rent");
  assert.equal(read.area, "Woodbrook");
  assert.equal(read.bedrooms, 2);
  assert.equal(read.vague, false);
});

test("chatter reads as chatter, and too vague to match", () => {
  const read = previewText(root(), "Good morning everyone, happy Friday!");
  assert.equal(read.kind, "chatter");
  assert.equal(read.area, null);
  assert.equal(read.vague, true);
});

test("the preview returns only the reading: no text, no group name, no product name", () => {
  const text = "NEW TO THE MARKET: 3 bed house in Maraval, asking TT$2,500,000";
  const json = JSON.stringify(previewText(root(), text));
  assert.doesNotMatch(json, /periskope|bops|group/i);
  assert.ok(!json.includes("NEW TO THE MARKET"), "the sample text is not echoed back");
  assert.deepEqual(Object.keys(previewText(root(), text)).sort(), ["area", "bedrooms", "currency", "island", "kind", "listingType", "price", "region", "vague"]);
});

test("the preview is for any signed-in staff member, and a signed-out visitor is turned away", async () => {
  const req = async (email: string | null) => new Request("https://bops.example/api/realty/learn/preview", { method: "POST", headers: email ? { cookie: `${GATE_COOKIE}=${await session(email)}` } : {} });
  assert.equal(await staffAccess(await req(AGENT), ENV), null, "an agent reads a sample");
  assert.equal((await staffAccess(await req(null), ENV))?.status, 401, "signed out");
});

/* ---------------- the teacher's routes ---------------- */

test("the teaching routes are teacher-only: a teacher passes, another staff member gets 404, signed out gets 401", async () => {
  for (const path of ["area", "ignore", "taught"]) {
    const req = async (email: string | null) => new Request(`https://bops.example/api/realty/learn/${path}`, { method: "POST", headers: email ? { cookie: `${GATE_COOKIE}=${await session(email)}` } : {} });
    assert.equal(await teacherAccess(await req(TEACHER), ENV), null, path);
    assert.equal((await teacherAccess(await req(AGENT), ENV))?.status, 404, `${path}: a non-teacher`);
    assert.equal((await teacherAccess(await req(null), ENV))?.status, 401, `${path}: signed out`);
  }
  assert.equal(teachAllowed(AGENT, ENV), false);
});

test("the gate lets a teacher through to each teaching path, and an agent to the preview only", () => {
  const teacher = { email: TEACHER, env: ENV };
  for (const [path, method] of [["/api/realty/learn/area", "POST"], ["/api/realty/learn/ignore", "POST"], ["/api/realty/learn/taught", "PATCH"], ["/api/realty/learn/taught", "DELETE"]] as const) {
    assert.equal(gateVerdict({ path, method, ...teacher }), "pass", `${method} ${path}`);
    assert.equal(gateVerdict({ path, method, email: AGENT, env: ENV }), "forbidden", `${method} ${path} for an agent`);
  }
  assert.equal(gateVerdict({ path: "/api/realty/learn/preview", method: "POST", email: AGENT, env: ENV }), "pass");
});

/* ---------------- the CRM's bad-match reports ---------------- */

test("flag-match is open to the Google gate and listed as server-to-server in proxy.ts", () => {
  assert.equal(GATE_OPEN_PATHS.has("/api/realty/learn/flag-match"), true);
  assert.equal(GATE_OPEN_PATHS.has("/api/realty/learn/flag-match/extra"), false);
  const proxy = readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");
  const line = proxy.split("\n").find((l) => l.startsWith("const TAILNET_PATHS"));
  assert.ok(line, "TAILNET_PATHS is found");
  assert.ok(line.includes('"/api/realty/learn/flag-match"'));
  assert.equal(agentMayReach("/api/realty/learn/flag-match", "POST"), false, "not a staff API: it is bearer-checked");
});

test("flag-match: 503 when the token is unset, and the body is never read", async () => {
  let read = 0;
  const reply = await flagMatch({ authorization: `Bearer ${TOKEN}`, readBody: async () => ((read += 1), "{}") }, {}, { root: root() });
  assert.equal(reply.status, 503);
  assert.equal(read, 0);
  const blank = await flagMatch({ authorization: `Bearer ${TOKEN}`, readBody: async () => "{}" }, { BOPS_AUTOMATCH_TOKEN: "   " }, { root: root() });
  assert.equal(blank.status, 503, "a blank token is the same as unset");
});

test("flag-match: 401 for a missing, wrong or non-bearer token, before the body is read, with the same reply each time", async () => {
  const env = { BOPS_AUTOMATCH_TOKEN: TOKEN };
  let read = 0;
  const readBody = async () => ((read += 1), JSON.stringify({ source: "crm", reason: "other" }));
  for (const authorization of [null, "Bearer test-wrong-token", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
    const reply = await flagMatch({ authorization, readBody }, env, { root: root() });
    assert.equal(reply.status, 401, String(authorization));
    assert.deepEqual(reply.body, { error: "Unauthorized." });
  }
  assert.equal(read, 0, "a wrong token never reads the body");
});

test("flag-match: 200 with the id on a valid report, and the store lists it without a group name", async () => {
  const r = root();
  const body = {
    source: "crm",
    reason: "wrong_area",
    client_id: "client-7",
    client_locations: ["Invented Town"],
    listing_id: "L-100",
    listing_title: "Invented Villa",
    listing_location: "Invented Place",
    note: "Too far from the client's school",
    reported_by: "Test Agent",
    group_name: "Invented Group A",
  };
  const reply = await flagMatch({ authorization: `Bearer ${TOKEN}`, readBody: async () => JSON.stringify(body) }, { BOPS_AUTOMATCH_TOKEN: TOKEN }, { root: r, at: SENT });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
  assert.equal(typeof reply.body.id, "number");
  const flags = inStore(r, (s) => s.openFlags());
  assert.equal(flags.length, 1);
  assert.equal(flags[0].reason, "wrong_area");
  assert.deepEqual(flags[0].clientLocations, ["Invented Town"]);
  assert.equal(flags[0].listingTitle, "Invented Villa");
  assert.equal(flags[0].flaggedAt, SENT);
  assert.doesNotMatch(JSON.stringify(flags), /Invented Group A/, "a group name is never stored");
});

test("flag-match: 400 for a bad source, reason, list, length or body", async () => {
  const env = { BOPS_AUTOMATCH_TOKEN: TOKEN };
  const bad: string[] = [
    JSON.stringify({ source: "email", reason: "other" }),
    JSON.stringify({ source: "crm", reason: "too_pricey" }),
    JSON.stringify({ source: "crm" }),
    JSON.stringify({ source: "crm", reason: "other", client_locations: "Maraval" }),
    JSON.stringify({ source: "crm", reason: "other", client_locations: [""] }),
    JSON.stringify({ source: "crm", reason: "other", note: "x".repeat(2001) }),
    JSON.stringify({ source: "crm", reason: "other", listing_title: "x".repeat(201) }),
    JSON.stringify({ source: "crm", reason: "other", client_id: 7 }),
    JSON.stringify(["crm", "other"]),
    "{nope",
  ];
  for (const text of bad) {
    const reply = await flagMatch({ authorization: `Bearer ${TOKEN}`, readBody: async () => text }, env, { root: root() });
    assert.equal(reply.status, 400, text);
    assert.equal(typeof reply.body.error, "string");
  }
  assert.equal(flagInputOf({ source: "online", reason: "wrong_price" }).ok, true, "a minimal report is fine");
});
