import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { clockHmAst, dayKeyAst } from "../flow/ast-time.ts";
import { alertTextFromHtml, type AlertInput, type AlertSentRow } from "../flow/automatch-alert.ts";
import {
  EMPTY_LINE,
  SUMMARY_AT_DEFAULT,
  SUMMARY_AT_FLAG,
  SUMMARY_BCC_DEFAULT,
  SUMMARY_ENABLED_FLAG,
  SUMMARY_SEND_OFF,
  SUMMARY_TO_DEFAULT,
  SUMMARY_WINDOW_MS,
  buildDailySummary,
  dailySummaryAt,
  dailySummaryBcc,
  dailySummaryDue,
  dailySummaryEnabled,
  dailySummaryFromEnv,
  dailySummaryTo,
  enrichSummaryItems,
  excerptOf,
  groupSummaryItems,
  parseDailySummaryArgs,
  parseSummaryAt,
  sentRowsInWindow,
  summaryIdempotencyKey,
  summarySourceOf,
  type SummaryItem,
  type SummarySource,
} from "../flow/daily-summary.ts";

/**
 * The daily Auto-Match summary: last 24 hours of sent alerts, grouped by agent, public listing link, no Bops / Periskope
 * / group names / bop links. Invented people and 555 numbers only.
 */

const NOW = new Date("2026-11-16T15:20:00.000Z"); // 11:20 AM AST on Mon 16 Nov
const SEVEN = new Date("2026-11-16T11:00:00.000Z"); // 7:00 AM AST
const BEFORE = new Date("2026-11-16T10:59:00.000Z"); // 6:59 AM AST
const URL_A = "https://1on1realtors.com/property/third-urban";
const KEY_A = `url:${URL_A}`;
const URL_B = "https://1on1realtors.com/property/glencoe-flat";
const KEY_B = `url:${URL_B}`;
const RID_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const RID_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const RID_C = "cccccccccccccccccccccccc";
const SENT_A = "2026-11-16T12:30:00.000Z"; // 8:30 AM AST
const SENT_B = "2026-11-16T13:00:00.000Z"; // 9:00 AM AST
const SENT_OLD = "2026-11-15T12:00:00.000Z"; // more than 24h before NOW

const ROW = (over: Partial<AlertInput> = {}, ask: Partial<AlertInput["ask"]> = {}, listing: Partial<AlertInput["listing"]> = {}): AlertInput => ({
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
    lastSeenAt: SENT_A,
    postedAt: SENT_A,
    senderName: "Alex Tester",
    firm: "Example Realty Co",
    senderPhone: "+18685550100",
    originalText: "Need a 3 bed townhouse in Maraval, budget 4.3m, parking please.",
    ...ask,
  },
  listing: {
    title: "Third Urban, Maraval",
    url: URL_A,
    price: 3_700_000,
    currency: "TTD",
    ttdEquiv: null,
    agentId: 7,
    agentName: "Dana Holder",
    area: "Maraval",
    beds: 3,
    type: "townhouse",
    ...listing,
  },
  agentEmail: "dana@1on1.example",
  ...over,
});

function itemOf(row: AlertInput, sentAt: string): SummaryItem {
  const src = summarySourceOf(row);
  assert.ok(src);
  return { ...src, sentAt };
}

test("clock and send-time helpers: 7:00 AM AST is due, 6:59 is not, and unreadable times fall back", () => {
  assert.equal(clockHmAst(SEVEN), "07:00");
  assert.equal(clockHmAst(BEFORE), "06:59");
  assert.equal(dayKeyAst(SEVEN), "2026-11-16");
  assert.equal(parseSummaryAt(undefined), "07:00");
  assert.equal(parseSummaryAt("7"), "07:00");
  assert.equal(parseSummaryAt("7:15"), "07:15");
  assert.equal(parseSummaryAt("25:00"), "07:00");
  assert.equal(dailySummaryAt({}), SUMMARY_AT_DEFAULT);
  assert.equal(dailySummaryAt({ [SUMMARY_AT_FLAG]: "8:30" }), "08:30");
  assert.equal(dailySummaryEnabled({}), false);
  assert.equal(dailySummaryEnabled({ [SUMMARY_ENABLED_FLAG]: "true" }), true);
  assert.equal(dailySummaryDue(BEFORE, { enabled: true, lastDay: null }), false);
  assert.equal(dailySummaryDue(SEVEN, { enabled: true, lastDay: null }), true);
  assert.equal(dailySummaryDue(SEVEN, { enabled: false, lastDay: null }), false);
  assert.equal(dailySummaryDue(SEVEN, { enabled: true, lastDay: "2026-11-16" }), false);
  assert.equal(dailySummaryDue(SEVEN, { enabled: true, lastDay: "2026-11-15" }), true);
  assert.equal(dailySummaryDue(SEVEN, { enabled: true, lastDay: null, at: "08:00" }), false);
});

test("the window keeps only sent-kind rows from the last 24 hours", () => {
  const rows: AlertSentRow[] = [
    { requestId: RID_A, listingKey: KEY_A, at: SENT_A, kind: "sent" },
    { requestId: RID_B, listingKey: KEY_B, at: SENT_B, kind: "suppressed" },
    { requestId: RID_C, listingKey: KEY_B, at: SENT_OLD, kind: "sent" },
    { requestId: "dddddddddddddddddddddddd", listingKey: KEY_B, at: SENT_B, kind: "sent" },
  ];
  const kept = sentRowsInWindow(rows, NOW);
  assert.deepEqual(kept.map((r) => r.requestId), [RID_A, "dddddddddddddddddddddddd"]);
  assert.equal(Date.parse(NOW.toISOString()) - Date.parse(SENT_OLD) > SUMMARY_WINDOW_MS, true);
});

test("the email lists each sent alert with agent, listing, public link, contact, time, score and excerpt, and gives totals", () => {
  const dana = itemOf(ROW(), SENT_A);
  const eveRow = ROW(
    { listingKey: KEY_B, score: 82, agentEmail: "eve@1on1.example" },
    { postId: RID_B, area: "Glencoe", beds: 2, budget: 9_000, type: "apartment", listingType: "rent", originalText: "Looking to rent a 2 bed apartment in Glencoe, around 9k." },
    { title: "GLENCOE FLAT", url: URL_B, area: "Glencoe", type: "apartment", beds: 2, price: 8_000, agentId: 8, agentName: "Eve Other" },
  );
  const eve = itemOf(eveRow, SENT_B);
  const mail = buildDailySummary([dana, eve], { now: NOW });
  assert.equal(mail.alerts, 2);
  assert.equal(mail.agents, 2);
  assert.deepEqual(mail.to, ["wendy@1on1realtors.com", "admin@1on1realtors.com"]);
  assert.deepEqual(mail.cc, []);
  assert.deepEqual(mail.bcc, ["miles@simplyintense.com"]);
  assert.match(mail.from, /1on1 Auto-Match Alert/);
  assert.match(mail.from, /alerts@1on1realtors\.com/);
  assert.equal(mail.subject, "1on1 Auto-Match daily update · Monday 16 Nov: 2 alerts sent");
  assert.match(mail.text, /2 alerts sent to 2 agents/);
  assert.match(mail.text, /Dana Holder \(dana@1on1\.example\): 1 alert/);
  assert.match(mail.text, /Eve Other \(eve@1on1\.example\): 1 alert/);
  assert.match(mail.text, /Third Urban, Maraval, 3-bed townhouse · TT\$3\.7m · here: https:\/\/1on1realtors\.com\/property\/third-urban/);
  assert.match(mail.text, /Sent: Mon 16 Nov, 8:30 AM AST/);
  assert.match(mail.text, /Contact: Alex Tester, \+1 868 555 0100/);
  assert.match(mail.text, /Score: 90\. This is a strong fit/);
  assert.match(mail.text, /Request: "Need a 3 bed townhouse in Maraval/);
  assert.match(mail.html, /<a href="https:\/\/1on1realtors\.com\/property\/third-urban">here<\/a>/);
  assert.match(mail.html, /<a href="https:\/\/1on1realtors\.com\/property\/glencoe-flat">here<\/a>/);
  assert.doesNotMatch(mail.text, /miles@simplyintense\.com/);
  assert.doesNotMatch(mail.html, /miles@simplyintense\.com/);
  const visible = [mail.from, mail.to.join(","), mail.subject, mail.text, mail.html].join("\n");
  assert.doesNotMatch(visible, /\bBops\b|\bPeriskope\b|\bSupabase\b|\bFly\b|bop\.1on1realtors\.com/i);
  assert.doesNotMatch(visible, /AREA Registered Agents|Top Notch|Anything Real Estate|R\. E\. SEARCHES|Realty Co Broke/i);
  const fromHtml = alertTextFromHtml(mail.html).replace(/[“”]/g, '"');
  for (const phrase of ["Dana Holder", "Eve Other", "Third Urban", "Alex Tester", "8:30 AM AST", "2 alerts sent to 2 agents"]) {
    assert.match(fromHtml, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(mail.text, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("when nothing was sent, the email says so in one line and still addresses Wendy and admin", () => {
  const mail = buildDailySummary([], { now: NOW });
  assert.equal(mail.alerts, 0);
  assert.equal(mail.agents, 0);
  assert.equal(mail.subject, "1on1 Auto-Match daily update · Monday 16 Nov: no alerts sent");
  assert.equal(mail.text, `${EMPTY_LINE}\n`);
  assert.match(mail.html, /No Auto-Match alerts were sent in the last 24 hours/);
  assert.doesNotMatch(mail.text, /Here's what Auto-Match sent/);
  assert.deepEqual(mail.to, parseAddressListSafe());
  assert.deepEqual(mail.bcc, ["miles@simplyintense.com"]);
});

function parseAddressListSafe() {
  return SUMMARY_TO_DEFAULT.split(",").map((s) => s.trim().toLowerCase());
}

test("a missing match still appears, a suppressed or old row does not, and Office sorts last", () => {
  const sources: SummarySource[] = [
    summarySourceOf(ROW())!,
    summarySourceOf(ROW({ listingKey: "crm:9", score: 80, agentEmail: null }, { postId: RID_B }, { agentId: null, agentName: null, title: "Office House, Cascade", url: "https://1on1realtors.com/property/office-house", area: "Cascade" }))!,
  ];
  const sent: AlertSentRow[] = [
    { requestId: RID_A, listingKey: KEY_A, at: SENT_A, kind: "sent" },
    { requestId: RID_B, listingKey: "crm:9", at: SENT_B, kind: "sent" },
    { requestId: RID_C, listingKey: `url:${URL_B}`, at: SENT_B, kind: "sent" },
    { requestId: RID_A, listingKey: KEY_A, at: SENT_OLD, kind: "sent" },
    { requestId: "eeeeeeeeeeeeeeeeeeeeeeee", listingKey: KEY_B, at: SENT_B, kind: "suppressed" },
  ];
  const items = enrichSummaryItems(sent, sources, NOW);
  assert.equal(items.length, 3);
  const missing = items.find((i) => i.requestId === RID_C);
  assert.ok(missing);
  assert.equal(missing.listingTitle, "Listing");
  assert.equal(missing.publicUrl, URL_B);
  assert.match(missing.fit, /not on file/);
  const groups = groupSummaryItems(items);
  assert.equal(groups.at(-1)?.agent, "Office");
  const mail = buildDailySummary(items, { now: NOW });
  assert.match(mail.text, /Office \(admin@1on1realtors\.com\)/);
  assert.match(mail.text, /here: https:\/\/1on1realtors\.com\/property\/glencoe-flat/);
  assert.doesNotMatch(mail.text, /crm:9|bbbbbbbb|cccccccc/);
});

test("a test build is addressed to Miles only, with a [TEST] subject and no BCC", () => {
  const mail = dailySummaryFromEnv([itemOf(ROW(), SENT_A)], {}, NOW, { test: true });
  assert.deepEqual(mail.to, ["miles@simplyintense.com"]);
  assert.deepEqual(mail.cc, []);
  assert.deepEqual(mail.bcc, []);
  assert.match(mail.subject, /^\[TEST\] 1on1 Auto-Match daily update/);
});

test("excerpts collapse whitespace and end on a word when trimmed", () => {
  assert.equal(excerptOf("  Need   a  place  "), "Need a place");
  assert.equal(excerptOf(""), "");
  const long = "Looking for a three bedroom place in the west " + "really ".repeat(40) + "soon please.";
  const cut = excerptOf(long, 80);
  assert.ok(cut.endsWith("…"));
  assert.ok(cut.length <= 81);
  assert.doesNotMatch(cut, / {2}/);
});

test("recipient flags and the idempotency key, and --send is parsed but refused by the CLI", () => {
  assert.equal(SUMMARY_TO_DEFAULT, "wendy@1on1realtors.com,admin@1on1realtors.com");
  assert.equal(SUMMARY_BCC_DEFAULT, "miles@simplyintense.com");
  assert.deepEqual(dailySummaryTo({}), ["wendy@1on1realtors.com", "admin@1on1realtors.com"]);
  assert.deepEqual(dailySummaryBcc({}), ["miles@simplyintense.com"]);
  assert.equal(summaryIdempotencyKey("2026-11-16"), "daily-summary:2026-11-16");
  assert.deepEqual(parseDailySummaryArgs(["--test-send", "--out", "a.html", "--txt", "a.txt"]), {
    testSend: true,
    out: "a.html",
    txt: "a.txt",
    send: false,
  });
  assert.equal(parseDailySummaryArgs(["--send"]).send, true);
  const cli = new URL("../cli/daily-summary.ts", import.meta.url).pathname;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "--send"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [SUMMARY_ENABLED_FLAG]: "true" },
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "", "no body printed");
  assert.match(r.stderr, /daily summary/i);
  assert.match(r.stderr, new RegExp(SUMMARY_SEND_OFF.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a bop listing URL is never used as the public link", () => {
  const row = ROW({}, {}, { url: "https://bop.1on1realtors.com/realty/desk#lead-1" });
  const src = summarySourceOf(row);
  assert.equal(src?.publicUrl, null);
  const mail = buildDailySummary([itemOf(row, SENT_A)], { now: NOW });
  assert.doesNotMatch(mail.text + mail.html, /bop\.1on1realtors\.com/);
  assert.doesNotMatch(mail.html, /<a href=/);
});
