import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GATE_COOKIE, gateConfig, makeSession } from "../../lib/gate.ts";
import { MemoryAreaResolver } from "../flow/areas.ts";
import { dateAst } from "../flow/ast-time.ts";
import { buildAdminDigest, digestRows, digestSendState, DEFAULT_PUBLIC_URL, DIGEST_SEND_FLAG, escapeHtml, INTRO_BODY, INTRO_EMPTY, parseDigestArgs, publicBaseUrl, SEND_REFUSED } from "../flow/admin-digest.ts";
import { leadCardId, leadMessage, type LeadInput } from "../flow/automatch-leads.ts";
import { MATCH_STATUSES, type StatusRow } from "../flow/match-status.ts";
import type { CrmSeam, SeamAgent } from "../flow/crm-seam.ts";
import type { Listing } from "../flow/source.ts";
import { loadAdminDigest, adminDigestRoute } from "../node/admin-digest.ts";
import { staffLeads } from "../node/automatch-leads.ts";
import { dateAst as nodeDateAst } from "../node/group-posts.ts";
import { PeriskopeStore, requestIdOf } from "../node/periskope-store.ts";

/**
 * The admin match digest: the builder (grouping, the 75+ rule, the exclusions, the dedupe, the USD note, AST times, the wa.me
 * prefill, the Desk link, the wording), the send switch, the owners-only route, and that nothing calls fetch or sends mail.
 * Invented people, 555-style numbers and listings only.
 */

const NOW = new Date("2026-11-14T12:00:00.000Z");
const BASE = "https://bop.example";
const OWNER = "owner@1on1.example";
const DANA = "dana@1on1.example";
const EVE = "eve@1on1.example";
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: BASE, BOPS_OWNER_EMAILS: OWNER };
const cfg = gateConfig(GATE);
if (!cfg || cfg === "misconfigured") throw new Error("test config");

const RID_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const RID_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const URL_A = "https://1on1realtors.com/property/third-urban";
const KEY_A = `url:${URL_A}`;
const URL_B = "https://1on1realtors.com/property/glencoe-flat";
const KEY_B = `url:${URL_B}`;

/** A strong row (90) for a TTD sale ask in Maraval, held by agent 7 (Dana Holder) unless overridden. Posted 04:00 AST. */
const ROW = (over: Partial<LeadInput> = {}, ask: Partial<LeadInput["ask"]> = {}, listing: Partial<LeadInput["listing"]> = {}): LeadInput => ({
  score: 90,
  reason: "Same area (Maraval), 3 beds as asked, TT$3.7m within TT$4.3m budget, posted today",
  listingKey: KEY_A,
  ask: {
    postId: RID_A,
    area: "Maraval",
    beds: 3,
    budget: 4_300_000,
    currency: "TTD",
    type: "townhouse",
    listingType: "sale",
    lastSeenAt: "2026-11-14T10:00:00.000Z",
    postedAt: "2026-11-14T08:00:00.000Z",
    senderName: "Dana Tester",
    firm: "Test Realty Co",
    senderPhone: "+18685550199",
    ...ask,
  },
  listing: { title: "THIRD URBAN", url: URL_A, price: 3_700_000, currency: "TTD", ttdEquiv: null, agentId: 7, agentName: "Dana Holder", ...listing },
  ...over,
});

const EVE_ROW = () =>
  ROW(
    { listingKey: KEY_B, score: 82 },
    { postId: RID_B, area: "Glencoe", beds: 2, budget: null, currency: "TTD", type: null, listingType: "rent", senderName: "Eve Asker", firm: null, senderPhone: "+18685550188" },
    { title: "GLENCOE FLAT", url: URL_B, price: 9_000, agentId: 8, agentName: "Eve Other", area: "Glencoe", beds: 2 },
  );

const OFFICE_ROW = () =>
  ROW(
    { listingKey: "url:https://1on1realtors.com/property/office-unit", score: 77 },
    { postId: RID_B, senderName: null, senderPhone: "" },
    { title: "OFFICE UNIT", url: "https://1on1realtors.com/property/office-unit", agentId: null, agentName: null, price: 2_100_000 },
  );

const BASE_OPTS = { statuses: [] as StatusRow[], baseUrl: BASE };

/* ---------------- The builder ---------------- */

test("one email to Crystal: a count in the subject, a plain body and an HTML body, with the matches counted", () => {
  const d = buildAdminDigest([ROW(), EVE_ROW(), OFFICE_ROW()], BASE_OPTS);
  assert.equal(d.to, "admin@1on1realtors.com");
  assert.equal(d.subject, "Today's listing matches (3)");
  assert.equal(d.matches, 3);
  assert.equal(d.agents, 3);
  assert.ok(d.text.startsWith("Hi Crystal,\n"), d.text.slice(0, 40));
  assert.match(d.text, /\nThanks,\nMiles\n/);
  assert.ok(d.html.startsWith("<!doctype html>"));
  assert.match(d.html, /<p>Hi Crystal,<\/p>/);
});

test("grouped by the holding agent, with the unassigned listings under Office, last", () => {
  const dana2 = ROW({ score: 80 }, { postId: "cccccccccccccccccccccccc" }, { title: "SECOND FLAT" });
  const d = buildAdminDigest([ROW(), EVE_ROW(), OFFICE_ROW(), dana2], BASE_OPTS);
  assert.deepEqual(
    d.groups.map((g) => [g.agent, g.matches.length]),
    [
      ["Dana Holder", 2],
      ["Eve Other", 1],
      ["Office (unassigned listings)", 1],
    ],
  );
  assert.equal(d.groups[2].office, true);
  assert.match(d.text, /---- Dana Holder: 2 matches ----/);
  assert.match(d.text, /---- Office \(unassigned listings\): 1 match ----/);
});

test("75 and above only: 74, 50 and below are left out; 75 is in", () => {
  const rows = [ROW({ score: 75 }), ROW({ score: 74 }, { postId: "dddddddddddddddddddddddd" }), ROW({ score: 50 }, { postId: "eeeeeeeeeeeeeeeeeeeeeeee" }), ROW({ score: 30 }, { postId: "ffffffffffffffffffffffff" })];
  const d = buildAdminDigest(rows, BASE_OPTS);
  assert.equal(d.matches, 1);
  assert.equal(d.groups[0].matches[0].score, 75);
});

test("a match with any outcome is left out, whatever the status; another listing for the same request still counts", () => {
  for (const status of MATCH_STATUSES) {
    const statuses: StatusRow[] = [{ requestId: RID_A, listingKey: KEY_A, status, by: DANA, at: NOW.toISOString() }];
    const d = buildAdminDigest([ROW(), ROW({ listingKey: KEY_B }, {}, { url: URL_B, title: "GLENCOE FLAT" })], { statuses, baseUrl: BASE });
    assert.equal(d.matches, 1, status);
    assert.equal(d.groups[0].matches[0].listing.url, URL_B, status);
  }
});

test("one row per request and listing: the best score stands", () => {
  const d = buildAdminDigest([ROW({ score: 80 }), ROW({ score: 92 })], BASE_OPTS);
  assert.equal(d.matches, 1);
  assert.equal(d.groups[0].matches[0].score, 92);
  assert.equal(digestRows([ROW({ score: 80 }), ROW({ score: 92 })], []).length, 1);
});

test("a row with no request id makes no match", () => {
  const d = buildAdminDigest([ROW({}, { postId: null })], BASE_OPTS);
  assert.equal(d.matches, 0);
  assert.equal(d.subject, "Today's listing matches (0)");
  assert.ok(d.text.includes(INTRO_EMPTY), "says there's nothing to forward");
});

test("a USD ask carries a clear note; a TTD ask doesn't", () => {
  const usd = ROW({}, { currency: "USD", budget: 650_000 });
  const d = buildAdminDigest([usd], BASE_OPTS);
  assert.match(d.text, /Ask: Looking to buy a 3-bed townhouse in Maraval, asked in US\$ \(US\$650k ≈ TT\$/);
  assert.match(d.text, /Note: this ask was in US\$/);
  assert.match(d.html, /Note:<\/strong> this ask was in US\$/);
  assert.doesNotMatch(buildAdminDigest([ROW()], BASE_OPTS).text, /Note: this ask was in US/);
});

test("times are AST: the posted time reads in Port of Spain's clock, labelled AST", () => {
  const d = buildAdminDigest([ROW()], BASE_OPTS);
  assert.equal(d.groups[0].matches[0].posted, "2026-11-14 04:00 AST", "08:00 UTC is 04:00 in Port of Spain");
  assert.match(d.text, /Posted: 2026-11-14 04:00 AST/);
  assert.equal(dateAst("2026-07-01T00:00:00.000Z"), "2026-06-30 20:00 AST", "no daylight saving");
  assert.equal(dateAst("not a time"), "");
  assert.equal(nodeDateAst("2026-11-14T12:00:00.000Z"), "2026-11-14 08:00 AST", "the desk's export still reads the same");
  const noPost = buildAdminDigest([ROW({}, { postedAt: null })], BASE_OPTS);
  assert.equal(noPost.groups[0].matches[0].posted, "2026-11-14 06:00 AST", "without a posted time, the last seen time stands");
});

test("the wa.me link carries the same suggested message, short title and all; no usable number says so and gives no link", () => {
  const row = ROW({}, {}, { title: "WEST HILLS, PETIT VALLEY 3BR Apartment For Sale", area: "Petit Valley", beds: 3, type: "apartment" });
  const d = buildAdminDigest([row], BASE_OPTS);
  const m = d.groups[0].matches[0];
  assert.equal(m.message, leadMessage(row));
  assert.match(m.message, /^Hi Dana, I hear you have a client looking for a 3 bed townhouse in Maraval around TT\$4\.3m\. I have West Hills, Petit Valley, 3-bed apartment at TT\$3\.7m:/);
  assert.ok(m.waUrl?.startsWith("https://wa.me/18685550199?text="), "the sender's digits, prefilled");
  assert.equal(decodeURIComponent(m.waUrl?.split("?text=")[1] ?? ""), m.message, "the prefill decodes to the message");
  assert.match(d.text, /WhatsApp, with the message filled in \(opens in your own browser\): https:\/\/wa\.me\/18685550199\?text=/);

  const none = buildAdminDigest([ROW({}, { senderPhone: "" })], BASE_OPTS);
  assert.equal(none.groups[0].matches[0].waUrl, null);
  assert.match(none.text, /No usable WhatsApp number on this ask, so there's no link\./);
  assert.doesNotMatch(none.text, /wa\.me/);
  assert.doesNotMatch(none.html, /wa\.me/);
});

test("the Desk link lands on the lead card: the Desk path with the card's own id, from BOPS_PUBLIC_URL", () => {
  const id = leadCardId(RID_A, KEY_A);
  const d = buildAdminDigest([ROW()], { statuses: [], baseUrl: publicBaseUrl({ BOPS_PUBLIC_URL: "https://bop.example/" }) });
  assert.equal(d.groups[0].matches[0].deskUrl, `https://bop.example/realty/desk#${id}`);
  assert.ok(d.text.includes(`Record how it went on the Desk: https://bop.example/realty/desk#${id}`));
  assert.ok(d.html.includes(`href="https://bop.example/realty/desk#${id}"`));
  assert.equal(publicBaseUrl({}), DEFAULT_PUBLIC_URL, "the default is the production desk");
  assert.equal(publicBaseUrl({ BOPS_PUBLIC_URL: "not a url" }), DEFAULT_PUBLIC_URL);
});

test("the listing: short title, price and its link; the agent's name only in the group heading", () => {
  const d = buildAdminDigest([ROW({}, {}, { title: "WEST HILLS, PETIT VALLEY 3BR Apartment For Sale", area: "Petit Valley", beds: 3, type: "apartment" })], BASE_OPTS);
  const m = d.groups[0].matches[0];
  assert.equal(m.listing.title, "West Hills, Petit Valley, 3-bed apartment");
  assert.equal(m.listing.price, "TT$3.7m");
  assert.equal(m.listing.url, URL_A);
  assert.match(d.text, /1\. West Hills, Petit Valley, 3-bed apartment \(score 90\)/);
  assert.match(d.text, /Listing: https:\/\/1on1realtors\.com\/property\/third-urban/);
});

test("the intro and the body never mention bots, AI, Bops, Automatch, Periskope, group scanning or monitoring", () => {
  const forbidden = /\bbots?\b|\bAI\b|\bBops\b|automatch|periskope|whatsapp groups?|scann|monitor|owns? the system/i;
  for (const p of INTRO_BODY) assert.doesNotMatch(p, forbidden, p);
  const usd = ROW({ score: 88 }, { postId: "1234567890abcdef12345678", currency: "USD", budget: 650_000 });
  const d = buildAdminDigest([ROW(), EVE_ROW(), OFFICE_ROW(), usd], BASE_OPTS);
  assert.doesNotMatch(d.text, forbidden);
  assert.doesNotMatch(d.html, forbidden);
  assert.doesNotMatch(d.subject, forbidden);
  assert.match(d.text, /Here are today's strong matches/);
});

test("the HTML escapes what it shows: a listing title or a sender's name can't add markup", () => {
  assert.equal(escapeHtml(`<b>"x" & 'y'</b>`), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
  const d = buildAdminDigest([ROW({}, { senderName: "<img src=x>" }, { title: "<script>alert(1)</script>" })], BASE_OPTS);
  assert.doesNotMatch(d.html, /<script>|<img/);
  assert.match(d.html, /&lt;script&gt;/);
});

test("parse the flags: --send is seen, --out and --txt take their paths; nothing else is read", () => {
  assert.deepEqual(parseDigestArgs(["--send"]), { send: true, out: null, txt: null });
  assert.deepEqual(parseDigestArgs(["--out", "a.html", "--txt", "a.txt", "--root", "x"]), { send: false, out: "a.html", txt: "a.txt" });
  assert.deepEqual(parseDigestArgs(["--out", "--txt"]), { send: false, out: null, txt: null }, "a flag is not a path");
});

/* ---------------- The send switch: off ---------------- */

test("the send flag is read and reported, but sending is off: exactly \"1\" turns the flag on, and nothing sends", () => {
  assert.equal(DIGEST_SEND_FLAG, "ONEON1_ADMIN_DIGEST_SEND");
  assert.deepEqual(digestSendState({ [DIGEST_SEND_FLAG]: "1" }), { flagOn: true, sending: false, message: SEND_REFUSED });
  assert.equal(digestSendState({ [DIGEST_SEND_FLAG]: "true" }).flagOn, false, "only exactly 1");
  assert.equal(digestSendState({ [DIGEST_SEND_FLAG]: "0" }).flagOn, false);
  assert.equal(digestSendState({}).flagOn, false, "off by default");
  assert.equal(digestSendState({ [DIGEST_SEND_FLAG]: "1" }).sending, false, "still off with the flag on");
  assert.match(SEND_REFUSED, /off in this build/);
});

test("the CLI refuses --send with exit code 2 and writes nothing to stdout, even with the flag on", () => {
  const cli = new URL("../cli/admin-digest.ts", import.meta.url).pathname;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "--send"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [DIGEST_SEND_FLAG]: "1" },
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "", "no body printed");
  assert.match(r.stderr, /Refused: sending the admin digest is off in this build/);
});

/* ---------------- Nothing calls fetch, and no mail transport is here ---------------- */

const FILES = ["../flow/admin-digest.ts", "../flow/listing-title.ts", "../node/admin-digest.ts", "../cli/admin-digest.ts", "../../app/api/realty/admin-digest/route.ts"];

test("no fetch and no mail transport in the digest's code: the builder, the loader, the CLI and the route", () => {
  for (const f of FILES) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(/, f);
    assert.doesNotMatch(src, /nodemailer|resend|sendgrid|smtp|sendmail|mailgun|postmark|gmail|send_?message/i, f);
  }
});

/* ---------------- The loader and the owners-only route (read only) ---------------- */

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
const PLACES = [{ name: "Westmoorings", region: "North West" as const, neighbours: ["Glencoe"] }, { name: "Glencoe", region: "North West" as const, neighbours: ["Westmoorings"] }];
const AREAS = new MemoryAreaResolver(PLACES);
const DANA_AGENT: SeamAgent = { id: 7, name: "Dana Holder", email: DANA, phone: null };
const EVE_AGENT: SeamAgent = { id: 8, name: "Eve Other", email: EVE, phone: null };
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const DEMAND_ROW = {
  messageId: "msg-digest-1",
  chatId: "chat-test@g.us",
  groupName: "Test Group A",
  sentAt: ago(2 * 24 * 3_600_000),
  category: "buyer_request",
  senderPhone: "+18685550199",
  senderName: "Test Renter",
  area: "Westmoorings",
  price: 9000,
  currency: "TTD",
  beds: 2,
  type: "apartment",
  listingType: "rent",
  originalText: "Looking to rent a 2 bed apartment in Westmoorings, up to TT$9,000",
};
const REQUEST = requestIdOf("msg-digest-1");

function storeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "admin-digest-"));
  writeFileSync(join(root, "demand.jsonl"), `${JSON.stringify(DEMAND_ROW)}\n`);
  return root;
}

function fakeSeam(listings: Listing[], agents: SeamAgent[]): CrmSeam {
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

const withFetchRefused = async <T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("no network in tests");
  }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = real;
  }
};

const cookieFor = async (email: string) => `${GATE_COOKIE}=${await makeSession(email, cfg)}`;
const req = async (email: string | null, query = "") =>
  new Request(`https://bops.example/api/realty/admin-digest${query}`, { headers: email ? { cookie: await cookieFor(email) } : {} });

test("the loader reads the desk's strong matches, records nothing, and matches the card the desk shows", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING()], [DANA_AGENT, EVE_AGENT]);
  const { result: digest, calls } = await withFetchRefused(() => loadAdminDigest({ root, seam, areas: AREAS, now: NOW, env: GATE }));
  assert.equal(calls, 0, "no fetch");
  assert.equal(digest.matches, 1);
  assert.equal(digest.groups[0].agent, "Dana Holder");
  assert.equal(new PeriskopeStore(root).matchSeenRows().length, 0, "no first-sight record: the stale clocks don't move");

  const cards = await staffLeads({ email: OWNER, env: GATE, root, seam, areas: AREAS, now: NOW });
  const card = cards.cards[0];
  assert.equal(digest.groups[0].matches[0].deskUrl, `${BASE}/realty/desk#${leadCardId(card.requestId, card.listingKey)}`, "the link opens that card");
  assert.equal(digest.groups[0].matches[0].listing.title, card.listing.title, "the same short title as the card");
  assert.equal(digest.groups[0].matches[0].message, card.message, "the same suggested message as the card");
});

test("an outcome set on the desk takes the match out of the next digest", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING()], [DANA_AGENT]);
  assert.equal((await loadAdminDigest({ root, seam, areas: AREAS, now: NOW, env: GATE })).matches, 1);
  const cards = await staffLeads({ email: DANA, env: GATE, root, seam, areas: AREAS, now: NOW });
  new PeriskopeStore(root).setMatchStatus({ requestId: REQUEST, listingKey: cards.cards[0].listingKey, status: "viewing-booked", by: DANA, at: NOW.toISOString() });
  assert.equal((await loadAdminDigest({ root, seam, areas: AREAS, now: NOW, env: GATE })).matches, 0);
});

test("owners only: signed out is 401, an agent or anyone else is 403 with no data; the owner gets the preview as HTML or text", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING()], [DANA_AGENT]);
  const o = { env: GATE, root, seam, areas: AREAS, now: NOW };

  const out = await withFetchRefused(async () => ({
    signedOut: await adminDigestRoute(await req(null), o),
    agent: await adminDigestRoute(await req(DANA), o),
    staffNotOwner: await adminDigestRoute(await req("frank@1on1.example"), o),
    outsider: await adminDigestRoute(await req("someone@elsewhere.example"), o),
    html: await adminDigestRoute(await req(OWNER), o),
    txt: await adminDigestRoute(await req(OWNER, "?format=txt"), o),
  }));
  assert.equal(out.calls, 0, "rendering a preview calls nothing outside");
  const r = out.result;
  assert.equal(r.signedOut.status, 401);
  assert.equal(r.agent.status, 403);
  assert.deepEqual(await r.agent.json(), { error: "Owners only." });
  assert.equal(r.staffNotOwner.status, 403, "a staff address that isn't an owner");
  assert.deepEqual(await r.staffNotOwner.json(), { error: "Owners only." });
  assert.equal(r.outsider.status, 401, "an address outside the staff list never gets in");
  assert.equal(r.html.status, 200);
  assert.match(r.html.headers.get("content-type") ?? "", /^text\/html/);
  const html = await r.html.text();
  assert.match(html, /<p>Hi Crystal,<\/p>/);
  assert.match(html, /Dana Holder/);
  assert.equal(r.txt.status, 200);
  assert.match(r.txt.headers.get("content-type") ?? "", /^text\/plain/);
  assert.match(await r.txt.text(), /^Hi Crystal,/);
});

test("the owners' preview only renders: a signed-out or non-owner request reads no data at all", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING()], [DANA_AGENT]);
  const before = readFileSync(join(root, "demand.jsonl"), "utf8");
  await adminDigestRoute(await req(DANA), { env: GATE, root, seam, areas: AREAS, now: NOW });
  assert.equal(readFileSync(join(root, "demand.jsonl"), "utf8"), before, "the demand store is untouched");
  assert.equal(new PeriskopeStore(root).matchSeenRows().length, 0);
});
