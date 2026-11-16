import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ALERT_ALLOWLIST_FLAG,
  ALERT_AS_MILES_FLAG,
  ALERT_BCC_DEFAULT,
  ALERT_BCC_FLAG,
  ALERT_CC_DEFAULT,
  ALERT_CC_FLAG,
  ALERT_ENABLED_FLAG,
  ALERT_FROM_ADDRESS_DEFAULT,
  ALERT_FROM_EMAIL_FLAG,
  ALERT_FROM_NAME_FLAG,
  ALERT_NAME,
  ALERT_REPLY_TO_DEFAULT,
  TEST_ALERT_TO,
  ALERT_SEND_EXISTING_FLAG,
  AGED_LEAD_DAYS,
  BASELINE_CONFIRM,
  HOT_MATCH_LINE,
  REPLY_LINE,
  agedLeadLine,
  isAgedLead,
  oneShotAgentStatus,
  planBaselineSend,
  planOneShotSend,
  requestAgeDays,
  MILES_FROM_NAME,
  OFFICE_TO,
  SEND_OFF,
  alertAllowlist,
  alertAttribution,
  alertBcc,
  alertCc,
  alertFromAddress,
  alertFromHeader,
  alertIdempotencyKey,
  alertKey,
  alertReplyTo,
  buildTestAutoMatchAlert,
  alertPriceText,
  alertSendState,
  alertSubject,
  alertTextFromHtml,
  escapeHtml,
  buildAutoMatchAlert,
  buildAutoMatchAlerts,
  flipReport,
  parseAddressList,
  parseAlertArgs,
  planAlertDispatch,
} from "../flow/automatch-alert.ts";
import { mentionedOnWhatsApp, relativeDayAst, timeAst12 } from "../flow/ast-time.ts";
import { leadMessage, type LeadInput } from "../flow/automatch-leads.ts";
import type { StatusRow } from "../flow/match-status.ts";

/**
 * 1on1 Auto-Match Alert: the subject, the from name, the soft WhatsApp mention, the tap-to-call number, the hot-match
 * line, and that "Bops", the group name and the original message text never appear. Invented people and 555 numbers only.
 */

const NOW = new Date("2026-11-15T20:00:00.000Z"); // 4:00 PM AST on Sun 15 Nov
const BASE = "https://bop.example";
const RID_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const RID_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const URL_A = "https://1on1realtors.com/property/third-urban";
const KEY_A = `url:${URL_A}`;
const URL_B = "https://1on1realtors.com/property/glencoe-flat";
const KEY_B = `url:${URL_B}`;

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
    lastSeenAt: "2026-11-15T18:15:00.000Z",
    postedAt: "2026-11-15T18:15:00.000Z", // 2:15 PM AST today
    senderName: "Dana Tester",
    firm: "Test Realty Co",
    senderPhone: "+18685550100",
    ...ask,
  },
  listing: {
    title: "THIRD URBAN",
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
  ...over,
});

const BASE_OPTS = { statuses: [] as StatusRow[], baseUrl: BASE, now: NOW };

const wordsOf = (s: string): string => s.replace(/\s+/g, " ").trim();

test("the default From display name is 1on1 Auto-Match Alert, not 1on1 Bops, and Miles is one switch", () => {
  assert.equal(ALERT_NAME, "1on1 Auto-Match Alert");
  assert.deepEqual(alertAttribution({}), { fromName: ALERT_NAME, asMiles: false });
  assert.deepEqual(alertAttribution({ [ALERT_AS_MILES_FLAG]: "1" }), { fromName: MILES_FROM_NAME, asMiles: true });
  assert.equal(alertAttribution({ [ALERT_FROM_NAME_FLAG]: "Custom Desk" }).fromName, "Custom Desk");
  const a = buildAutoMatchAlert(ROW(), { ...BASE_OPTS, fromName: ALERT_NAME, fromEmail: "alerts@1on1realtors.com" });
  assert.equal(a.fromName, "1on1 Auto-Match Alert");
  assert.equal(a.from, "1on1 Auto-Match Alert <alerts@1on1realtors.com>");
  assert.doesNotMatch(a.from, /Bops/i);
});


test("the default From is 1on1 Auto-Match Alert <alerts@1on1realtors.com> and Reply-To is admin@1on1realtors.com", () => {
  assert.equal(ALERT_FROM_ADDRESS_DEFAULT, "alerts@1on1realtors.com");
  assert.equal(ALERT_REPLY_TO_DEFAULT, "admin@1on1realtors.com");
  assert.equal(alertFromAddress({}), "alerts@1on1realtors.com");
  assert.equal(alertFromHeader({}), "1on1 Auto-Match Alert <alerts@1on1realtors.com>");
  assert.equal(alertReplyTo({}), "admin@1on1realtors.com");
  assert.equal(alertFromAddress({ AUTOMATCH_ALERT_FROM_ADDRESS: "desk@1on1realtors.com" }), "desk@1on1realtors.com");
  assert.equal(alertReplyTo({ AUTOMATCH_ALERT_REPLY_TO: "office@1on1realtors.com" }), "office@1on1realtors.com");
  const key = alertIdempotencyKey("aaaaaaaaaaaaaaaaaaaaaaaa", "url:https://1on1realtors.com/property/x");
  assert.match(key, /^automatch-alert:aaaaaaaaaaaaaaaaaaaaaaaa:/);
  assert.doesNotMatch(key, /[^A-Za-z0-9._:-]/);
});

test("the one-off test alert is To miles@simplyintense.com only, prefixed [TEST], with no CC or BCC", () => {
  const a = buildTestAutoMatchAlert(NOW, { baseUrl: BASE });
  assert.equal(a.to, TEST_ALERT_TO);
  assert.equal(TEST_ALERT_TO, "miles@simplyintense.com");
  assert.deepEqual(a.cc, []);
  assert.deepEqual(a.bcc, []);
  assert.match(a.subject, /^\[TEST\] /);
  assert.equal(a.from, "1on1 Auto-Match Alert <alerts@1on1realtors.com>");
  assert.doesNotMatch(`${a.from}\n${a.to}\n${a.cc.join(",")}\n${a.subject}\n${a.text}\n${a.html}`, /Bops/i);
});

test("Bops is absent from the rendered subject, from and body (html and text), and Miles's name stays out of the body", () => {
  const a = buildAutoMatchAlert(ROW(), { ...BASE_OPTS, fromName: ALERT_NAME, fromEmail: "alerts@1on1realtors.com" });
  for (const [label, s] of [
    ["subject", a.subject],
    ["from", a.from],
    ["text", a.text],
    ["html", a.html],
  ] as const) {
    assert.doesNotMatch(s, /Bops/i, label);
    if (label !== "from") assert.doesNotMatch(s, /Miles/i, label);
  }
  const miles = buildAutoMatchAlert(ROW(), { ...BASE_OPTS, fromName: MILES_FROM_NAME, asMiles: true });
  assert.doesNotMatch(miles.subject, /Bops|Miles/i);
  assert.doesNotMatch(miles.text, /Bops|Miles/i);
  assert.doesNotMatch(miles.html, /Bops|Miles/i);
  assert.equal(a.fromName, ALERT_NAME);
});

test("the rendered subject and bodies never mention Bops or link to bop.1on1realtors.com, even when the desk base URL is production", () => {
  const cases = [
    buildAutoMatchAlert(ROW(), { ...BASE_OPTS, fromName: ALERT_NAME, fromEmail: "alerts@1on1realtors.com" }),
    buildAutoMatchAlert(ROW(), { ...BASE_OPTS, baseUrl: "https://bop.1on1realtors.com" }),
    buildTestAutoMatchAlert(NOW, { baseUrl: "https://bop.1on1realtors.com" }),
    buildAutoMatchAlert(ROW({}, { senderPhone: "" }), { ...BASE_OPTS, baseUrl: "https://bop.1on1realtors.com" }),
  ];
  const forbidden = /Bops|bop\.1on1realtors\.com|\/realty\/desk|Record how it went on the Desk|view on the Desk|\blog in\b/i;
  for (const a of cases) {
    const rendered = `${a.from}\n${a.subject}\n${a.text}\n${a.html}`;
    assert.doesNotMatch(a.text, /bop\.1on1realtors\.com/i);
    assert.doesNotMatch(a.html, /bop\.1on1realtors\.com/i);
    assert.doesNotMatch(a.text, /Bops/i);
    assert.doesNotMatch(a.html, /Bops/i);
    assert.doesNotMatch(rendered, forbidden);
    assert.doesNotMatch(a.text, /Outcome:|Contacted · Viewing booked/);
    assert.doesNotMatch(a.html, /Outcome:|Contacted<\/a>/);
  }
});

test("each alert is CC'd to Crystal and Wendy, and BCC'd to Miles, who stays off the agent-facing headers and body", () => {
  assert.equal(ALERT_CC_DEFAULT, "admin@1on1realtors.com,wendy@1on1realtors.com");
  assert.equal(ALERT_BCC_DEFAULT, "miles@simplyintense.com");
  assert.deepEqual(alertCc({}), ["admin@1on1realtors.com", "wendy@1on1realtors.com"]);
  assert.deepEqual(alertBcc({}), ["miles@simplyintense.com"]);
  const a = buildAutoMatchAlert(ROW(), BASE_OPTS);
  assert.deepEqual(a.cc, ["admin@1on1realtors.com", "wendy@1on1realtors.com"]);
  assert.deepEqual(a.bcc, ["miles@simplyintense.com"]);
  const visible = [a.from, a.to, a.cc.join(", "), a.subject, a.text, a.html].join("\n");
  assert.doesNotMatch(visible, /miles@simplyintense\.com|Bcc:|BCC:/i, "the BCC address and a Bcc header stay off what the agent sees");
  assert.doesNotMatch(a.text, /admin@1on1realtors\.com|wendy@1on1realtors\.com/, "CC addresses stay in the header, not the body");
  assert.doesNotMatch(a.html, /admin@1on1realtors\.com|wendy@1on1realtors\.com|miles@simplyintense\.com/);
  const custom = buildAutoMatchAlert(ROW(), {
    ...BASE_OPTS,
    cc: alertCc({ [ALERT_CC_FLAG]: "wendy@1on1realtors.com" }),
    bcc: alertBcc({ [ALERT_BCC_FLAG]: "owner@1on1.example" }),
  });
  assert.deepEqual(custom.cc, ["wendy@1on1realtors.com"]);
  assert.deepEqual(custom.bcc, ["owner@1on1.example"]);
  assert.doesNotMatch([custom.from, custom.subject, custom.text, custom.html].join("\n"), /owner@1on1\.example/);
});

test("the subject names the type, beds, area and price, and leaves out unknown parts", () => {
  assert.equal(alertSubject(ROW()), "1on1 Auto-Match Alert: townhouse · 3 bed · Maraval · TT$3.7M");
  assert.equal(alertPriceText(ROW().listing, "sale"), "TT$3.7M");
  const rent = ROW({}, { listingType: "rent", budget: 9000 }, { price: 8000, type: "apartment", beds: 2, area: "Glencoe", title: "GLENCOE FLAT" });
  assert.equal(alertSubject(rent), "1on1 Auto-Match Alert: apartment · 2 bed · Glencoe · TT$8,000/mo");
  const missing = ROW({}, { type: null, beds: null, area: "Maraval" }, { type: null, beds: null, area: null, price: null, title: "THIRD URBAN" });
  assert.equal(alertSubject(missing), "1on1 Auto-Match Alert: Maraval");
  const titleOnly = ROW({}, { type: null, beds: null, area: "" }, { type: null, beds: null, area: null, price: null, title: "THIRD URBAN" });
  assert.match(alertSubject(titleOnly), /^1on1 Auto-Match Alert: /);
  assert.doesNotMatch(alertSubject(titleOnly), /·\s*$|·\s*·/);
  const testSub = alertSubject(ROW(), { test: true });
  assert.equal(testSub, "[TEST] 1on1 Auto-Match Alert: townhouse · 3 bed · Maraval · TT$3.7M");
});

test("a request older than 14 calendar days in AST gets an older-lead line and subject, and a newer one does not", () => {
  assert.equal(AGED_LEAD_DAYS, 14);
  assert.equal(requestAgeDays("2026-11-15T18:15:00.000Z", NOW), 0);
  assert.equal(requestAgeDays("2026-11-01T18:15:00.000Z", NOW), 14);
  assert.equal(requestAgeDays("2026-10-31T18:15:00.000Z", NOW), 15);
  assert.equal(isAgedLead(14), false);
  assert.equal(isAgedLead(15), true);
  assert.equal(
    agedLeadLine(32),
    "Heads up: this request is from 32 days ago, so it's an older lead, but still worth a quick call to see if they're still looking.",
  );
  const fresh = buildAutoMatchAlert(ROW(), BASE_OPTS);
  assert.equal(fresh.ageDays, 0);
  assert.doesNotMatch(fresh.subject, /older lead/i);
  assert.doesNotMatch(fresh.text, /Heads up: this request is from/);
  assert.doesNotMatch(fresh.html, /Heads up: this request is from/);
  const onThreshold = buildAutoMatchAlert(ROW({}, { postedAt: "2026-11-01T18:15:00.000Z", lastSeenAt: "2026-11-01T18:15:00.000Z" }), BASE_OPTS);
  assert.equal(onThreshold.ageDays, 14);
  assert.doesNotMatch(onThreshold.subject, /older lead/i);
  assert.doesNotMatch(onThreshold.text, /Heads up:/);
  const aged = buildAutoMatchAlert(ROW({}, { postedAt: "2026-10-14T18:15:00.000Z", lastSeenAt: "2026-10-14T18:15:00.000Z" }), BASE_OPTS);
  assert.equal(aged.ageDays, 32);
  assert.equal(aged.subject, "1on1 Auto-Match Alert: older lead · townhouse · 3 bed · Maraval · TT$3.7M");
  const agedLine = agedLeadLine(32);
  assert.ok(aged.text.includes(agedLine));
  assert.ok(aged.html.includes(escapeHtml(agedLine)));
  assert.match(aged.text, /A contact mentioned this property on WhatsApp on Wed 14 Oct at 2:15 PM AST/);
  assert.doesNotMatch(`${aged.from}\n${aged.subject}\n${aged.text}\n${aged.html}`, /Bops|bop\.1on1realtors\.com|\/realty\/desk/i);
  const testAged = buildTestAutoMatchAlert(NOW, { baseUrl: BASE, agedDays: 32 });
  assert.equal(testAged.to, TEST_ALERT_TO);
  assert.match(testAged.subject, /^\[TEST\] 1on1 Auto-Match Alert: older lead · /);
  assert.match(testAged.text, /from 32 days ago/);
  assert.deepEqual(testAged.cc, []);
  assert.deepEqual(testAged.bcc, []);
  assert.equal(wordsOf(aged.text), wordsOf(alertTextFromHtml(aged.html)));
});

test("every alert gets a unique subject so Gmail will not thread them together", () => {
  const used = new Set<string>();
  const a = alertSubject(ROW(), { used });
  const b = alertSubject(ROW({}, { postId: RID_B }, { title: "SECOND FLAT", area: "Cascade", price: 2_500_000, type: "house", beds: 4 }), { used });
  const c = alertSubject(ROW({ listingKey: KEY_B }, { postId: RID_B }, { title: "OTHER URBAN" }), { used });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
  const alerts = buildAutoMatchAlerts(
    [ROW(), ROW({ listingKey: KEY_B, score: 88 }, { postId: RID_B, area: "Glencoe" }, { title: "GLENCOE FLAT", url: URL_B, area: "Glencoe", price: 9_000, type: "apartment", beds: 2 })],
    { ...BASE_OPTS, now: NOW },
  );
  // Second row is a sale at 9000? I set price 9000 without listingType rent — keep them different via area/type.
  const subjects = alerts.map((x) => x.subject);
  assert.equal(new Set(subjects).size, subjects.length, subjects.join(" | "));
});

test("the soft mention uses earlier today, yesterday, or on Fri 13 Nov, and never the group name or the raw text", () => {
  assert.equal(timeAst12("2026-11-15T18:15:00.000Z"), "2:15 PM AST");
  assert.equal(relativeDayAst("2026-11-15T18:15:00.000Z", NOW), "earlier today");
  assert.equal(relativeDayAst("2026-11-14T18:15:00.000Z", NOW), "yesterday");
  assert.equal(relativeDayAst("2026-11-13T18:15:00.000Z", NOW), "on Fri 13 Nov");
  assert.equal(
    mentionedOnWhatsApp("2026-11-15T18:15:00.000Z", NOW),
    "A contact mentioned this property on WhatsApp earlier today at 2:15 PM AST.",
  );
  const a = buildAutoMatchAlert(ROW(), BASE_OPTS);
  assert.equal(a.mentioned, "A contact mentioned this property on WhatsApp earlier today at 2:15 PM AST.");
  assert.match(a.text, /A contact mentioned this property on WhatsApp earlier today at 2:15 PM AST\./);
  assert.match(a.html, /A contact mentioned this property on WhatsApp earlier today at 2:15 PM AST\./);
  const y = buildAutoMatchAlert(ROW({}, { postedAt: "2026-11-14T18:15:00.000Z", lastSeenAt: "2026-11-14T18:15:00.000Z" }), BASE_OPTS);
  assert.match(y.text, /on WhatsApp yesterday at 2:15 PM AST/);
  const older = buildAutoMatchAlert(ROW({}, { postedAt: "2026-11-13T18:15:00.000Z", lastSeenAt: "2026-11-13T18:15:00.000Z" }), BASE_OPTS);
  assert.match(older.text, /on WhatsApp on Fri 13 Nov at 2:15 PM AST/);

  const groupy = buildAutoMatchAlert(ROW(), BASE_OPTS);
  const forbidden = /Area Registered Agents|original (message|text)|group scanning|the group "|\bWhatsApp group\b/i;
  assert.doesNotMatch(groupy.subject, forbidden);
  assert.doesNotMatch(groupy.from, forbidden);
  assert.doesNotMatch(groupy.text, forbidden);
  assert.doesNotMatch(groupy.html, forbidden);
  assert.doesNotMatch(groupy.text, /Looking for a 3 bed in Maraval ASAP/i, "raw posted text is not in the body");
});

test("the contact's direct number is a readable E.164-style line with a tel: link, next to the wa.me link; no number omits the phone line", () => {
  const a = buildAutoMatchAlert(ROW(), BASE_OPTS);
  assert.equal(a.phoneText, "+1 868 555 0100");
  assert.equal(a.tel, "tel:+18685550100");
  assert.ok(a.waUrl?.startsWith("https://wa.me/18685550100?text="));
  assert.match(a.text, /Call: \+1 868 555 0100 \(tel:\+18685550100\)/);
  assert.match(a.text, /WhatsApp, with the message filled in \(opens in your own browser\): https:\/\/wa\.me\/18685550100\?text=/);
  assert.match(a.html, /<a href="tel:\+18685550100">\+1 868 555 0100<\/a>/);
  assert.ok(a.html.includes(`<a href="${a.waUrl}">${a.waUrl}</a>`));
  assert.equal(decodeURIComponent(a.waUrl?.split("?text=")[1] ?? ""), a.message);
  assert.equal(a.message, leadMessage(ROW()));

  const none = buildAutoMatchAlert(ROW({}, { senderPhone: "" }), BASE_OPTS);
  assert.equal(none.phoneText, null);
  assert.equal(none.tel, null);
  assert.equal(none.waUrl, null);
  assert.doesNotMatch(none.text, /Call:|tel:/);
  assert.doesNotMatch(none.html, /tel:/);
  assert.match(none.text, /No usable WhatsApp number on this ask, so there's no link\./);
  assert.doesNotMatch(none.text, /wa\.me/);
  assert.doesNotMatch(none.html, /wa\.me/);
});

test("the hot or live match line, the suggested message, and the reply-to-admin line are in both bodies, with no Desk or outcome links", () => {
  const a = buildAutoMatchAlert(ROW(), BASE_OPTS);
  assert.ok(a.text.includes(HOT_MATCH_LINE));
  assert.ok(a.html.includes(escapeHtml(HOT_MATCH_LINE)));
  assert.ok(a.text.includes(a.message));
  assert.ok(a.text.includes(REPLY_LINE));
  assert.ok(a.html.includes(escapeHtml(REPLY_LINE)));
  assert.equal(REPLY_LINE, "Reply to this email to let admin know how it went.");
  assert.doesNotMatch(a.text, /Outcome:|Record how it went on the Desk|view on the Desk|\blog in\b/i);
  assert.doesNotMatch(a.html, /Outcome:|Record how it went on the Desk|view on the Desk|\blog in\b/i);
  assert.doesNotMatch(a.text, /bop\.1on1realtors\.com|bop\.example|\/realty\/desk/i);
  assert.doesNotMatch(a.html, /bop\.1on1realtors\.com|bop\.example|\/realty\/desk/i);
  assert.match(a.text, /^Hi Dana,\n\nHere is a strong match for a listing you hold\.\n/);
  const miles = buildAutoMatchAlert(ROW(), { ...BASE_OPTS, asMiles: true, fromName: MILES_FROM_NAME });
  assert.match(miles.text, /Here is a strong match for a listing you hold\./);
  assert.doesNotMatch(miles.text, /I'm passing along|Miles/);
});

test("an unassigned listing, or one with no agent email, goes to the office address", () => {
  const office = buildAutoMatchAlert(ROW({}, {}, { agentId: null, agentName: null }), BASE_OPTS);
  assert.equal(office.to, OFFICE_TO);
  assert.equal(office.toName, "Office");
  assert.match(office.text, /^Hi,/);
  const noEmail = buildAutoMatchAlert({ ...ROW(), agentEmail: null }, BASE_OPTS);
  assert.equal(noEmail.to, OFFICE_TO);
  const withEmail = buildAutoMatchAlert({ ...ROW(), agentEmail: "dana@1on1.example" }, BASE_OPTS);
  assert.equal(withEmail.to, "dana@1on1.example");
  assert.equal(withEmail.toName, "Dana Holder");
});

test("only strong, not-yet-actioned matches become alerts, one per request and listing", () => {
  const rows = [
    ROW({ score: 90 }),
    ROW({ score: 74 }, { postId: "cccccccccccccccccccccccc" }),
    ROW({ score: 88, listingKey: KEY_B }, { postId: RID_B }, { title: "GLENCOE FLAT", url: URL_B, area: "Glencoe", type: "apartment", beds: 2, price: 8_000 }),
    ROW({ score: 80 }),
  ];
  const alerts = buildAutoMatchAlerts(rows, BASE_OPTS);
  assert.equal(alerts.length, 2, "74 is out; the two 90/80 rows for the same pair collapse to the best");
  assert.equal(alerts[0].requestId, RID_A);
  assert.equal(alerts[0].listingKey, KEY_A);
  const actioned = buildAutoMatchAlerts(rows, {
    ...BASE_OPTS,
    statuses: [{ requestId: RID_A, listingKey: KEY_A, status: "contacted", by: "owner@1on1.example", at: NOW.toISOString() }],
  });
  assert.equal(actioned.length, 1);
  assert.equal(actioned[0].requestId, RID_B);
});

test("the text and the HTML say the same words (whitespace collapsed), and the HTML stays style-free", () => {
  const cases: LeadInput[][] = [
    [ROW()],
    [ROW({}, { senderPhone: "" })],
    [ROW({}, { currency: "USD", budget: 650_000 }, { currency: "USD", price: 650_000 })],
    [ROW({}, {}, { agentId: null, agentName: null, url: null, price: null })],
    [ROW({}, { postedAt: "2026-11-13T18:15:00.000Z", lastSeenAt: "2026-11-13T18:15:00.000Z" })],
    [ROW({}, { postedAt: "2026-10-14T18:15:00.000Z", lastSeenAt: "2026-10-14T18:15:00.000Z" })],
  ];
  const allowed = new Set(["html", "body", "p", "h3", "ul", "li", "a", "br", "strong"]);
  for (const rows of cases) {
    const a = buildAutoMatchAlert(rows[0], BASE_OPTS);
    assert.equal(wordsOf(a.text), wordsOf(alertTextFromHtml(a.html)));
    assert.doesNotMatch(a.html, /\sstyle\s*=|class=|id=/i);
    for (const m of a.html.matchAll(/<\/?([a-z0-9]+)\b([^>]*)>/gi)) {
      assert.ok(allowed.has(m[1].toLowerCase()), m[1]);
    }
  }
});

test("sending stays off unless AUTOMATCH_ALERT_ENABLED is 1 or true; --send is parsed but the preview CLI must not send", () => {
  assert.equal(ALERT_ENABLED_FLAG, "AUTOMATCH_ALERT_ENABLED");
  assert.deepEqual(alertSendState({}), { flagOn: false, sending: false, message: SEND_OFF });
  assert.equal(alertSendState({ [ALERT_ENABLED_FLAG]: "false" }).flagOn, false);
  assert.equal(alertSendState({ [ALERT_ENABLED_FLAG]: "0" }).flagOn, false);
  assert.equal(alertSendState({ [ALERT_ENABLED_FLAG]: "true" }).flagOn, true);
  assert.equal(alertSendState({ [ALERT_ENABLED_FLAG]: "1" }).flagOn, true, "the flag is read");
  assert.equal(alertSendState({ [ALERT_ENABLED_FLAG]: "1" }).sending, false, "the flow layer never claims a send; the node layer decides");
  assert.deepEqual(parseAlertArgs(["--send", "--test", "--test-send", "--counts", "--out", "a.html", "--txt", "a.txt"]), {
    send: true,
    test: true,
    testSend: true,
    counts: true,
    out: "a.html",
    txt: "a.txt",
    sendBaseline: false,
    dryRun: false,
    confirm: null,
    aged: null,
  });
  assert.deepEqual(parseAlertArgs(["--send-baseline", "--dry-run"]), {
    send: false,
    test: false,
    testSend: false,
    counts: false,
    out: null,
    txt: null,
    sendBaseline: true,
    dryRun: true,
    confirm: null,
    aged: null,
  });
  assert.equal(parseAlertArgs(["--send-baseline", "--confirm", BASELINE_CONFIRM]).confirm, BASELINE_CONFIRM);
  assert.equal(parseAlertArgs(["--test-send", "--aged"]).aged, 32);
  assert.equal(parseAlertArgs(["--test-send", "--aged", "21"]).aged, 21);
});

test("the CLI refuses --send with exit code 2 and writes nothing to stdout, even with the flag on", () => {
  const cli = new URL("../cli/automatch-alert.ts", import.meta.url).pathname;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "--send"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", [ALERT_ENABLED_FLAG]: "true" },
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "", "no body printed");
  assert.match(r.stderr, /Sending Auto-Match Alert is off|only renders a preview|nothing was sent/i);
});


test("the default audience is every agent with a strong match; an allowlist narrows it", () => {
  assert.deepEqual(alertAllowlist({}), []);
  const dana = { ...ROW(), agentEmail: "dana@1on1.example" };
  const eve = ROW({ listingKey: KEY_B, score: 82 }, { postId: RID_B, area: "Glencoe" }, { title: "GLENCOE FLAT", url: URL_B, area: "Glencoe", type: "apartment", beds: 2, price: 8000, agentId: 8, agentName: "Eve Other" });
  const eveRow = { ...eve, agentEmail: "eve@1on1.example" };
  const all = buildAutoMatchAlerts([dana, eveRow], BASE_OPTS);
  assert.equal(all.length, 2);
  const onlyDana = buildAutoMatchAlerts([dana, eveRow], { ...BASE_OPTS, allowlist: ["dana@1on1.example"] });
  assert.equal(onlyDana.length, 1);
  assert.equal(onlyDana[0].to, "dana@1on1.example");
  assert.deepEqual(alertAllowlist({ [ALERT_ALLOWLIST_FLAG]: "dana@1on1.example, eve@1on1.example" }), ["dana@1on1.example", "eve@1on1.example"]);
});

test("dispatch is idempotent: each match is emailed at most once, and flipping the flag on does not bulk-send the backlog", () => {
  const a = buildAutoMatchAlert(ROW(), BASE_OPTS);
  const b = buildAutoMatchAlert(ROW({ listingKey: KEY_B, score: 82 }, { postId: RID_B }, { title: "GLENCOE FLAT", url: URL_B, area: "Glencoe", type: "apartment", beds: 2, price: 8000 }), BASE_OPTS);
  const empty = planAlertDispatch([a, b], [], { enabled: false, sendExisting: false });
  assert.equal(empty.send.length, 0);
  assert.equal(empty.suppress.length, 2, "while off, the current set is recorded as the baseline");
  const flip = flipReport([a, b], []);
  assert.equal(flip.existing, 2);
  assert.equal(flip.wouldSendImmediately, 0, "flipping on does not email the backlog");
  assert.equal(flip.wouldSuppress, 2);
  const seeded = empty.suppress.map((x) => ({ requestId: x.requestId, listingKey: x.listingKey, at: NOW.toISOString(), kind: "suppressed" as const }));
  const stillOff = planAlertDispatch([a, b], seeded, { enabled: true, sendExisting: false });
  assert.equal(stillOff.send.length, 0);
  assert.equal(stillOff.skip.length, 2);
  const c = buildAutoMatchAlert(ROW({ listingKey: "url:https://1on1realtors.com/property/new", score: 80 }, { postId: "cccccccccccccccccccccccc", area: "Cascade" }, { title: "NEW HILL", url: "https://1on1realtors.com/property/new", area: "Cascade", type: "house", beds: 4, price: 2_500_000 }), BASE_OPTS);
  const after = planAlertDispatch([a, b, c], seeded, { enabled: true, sendExisting: false });
  assert.equal(after.send.length, 1);
  assert.equal(after.send[0].requestId, "cccccccccccccccccccccccc");
  const again = planAlertDispatch([c], [{ requestId: c.requestId, listingKey: c.listingKey, at: NOW.toISOString(), kind: "sent" }], { enabled: true, sendExisting: false });
  assert.equal(again.send.length, 0);
  assert.equal(again.skip.length, 1);
  const backfill = planAlertDispatch([a, b, c], seeded, { enabled: true, sendExisting: true });
  assert.equal(backfill.send.length, 3, "an explicit backlog send covers suppressed and new keys");
  assert.equal(alertKey(a), `${RID_A}|${KEY_A}`);
});

test("the one-shot baseline plan emails only previously suppressed rows, and leaves new and already-sent matches alone", () => {
  const a = buildAutoMatchAlert(ROW(), BASE_OPTS);
  const b = buildAutoMatchAlert(ROW({ listingKey: KEY_B, score: 82 }, { postId: RID_B }, { title: "GLENCOE FLAT", url: URL_B, area: "Glencoe", type: "apartment", beds: 2, price: 8000 }), BASE_OPTS);
  const c = buildAutoMatchAlert(ROW({ listingKey: "url:https://1on1realtors.com/property/new", score: 80 }, { postId: "cccccccccccccccccccccccc", area: "Cascade" }, { title: "NEW HILL", url: "https://1on1realtors.com/property/new", area: "Cascade", type: "house", beds: 4, price: 2_500_000 }), BASE_OPTS);
  assert.deepEqual(planBaselineSend([a, b, c], []), []);
  const seeded = [
    { requestId: a.requestId, listingKey: a.listingKey, at: NOW.toISOString(), kind: "suppressed" as const },
    { requestId: b.requestId, listingKey: b.listingKey, at: NOW.toISOString(), kind: "sent" as const },
  ];
  const baseline = planBaselineSend([a, b, c], seeded);
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].requestId, a.requestId);
  const live = planAlertDispatch([a, b, c], seeded, { enabled: true, sendExisting: false });
  assert.equal(live.send.length, 1);
  assert.equal(live.send[0].requestId, c.requestId, "new matches still go through the ordinary plan, not the baseline");
  assert.equal(live.skip.length, 2);
});

test("the CLI refuses --send-baseline without --dry-run or the confirm token, and writes nothing to stdout", () => {
  const cli = new URL("../cli/automatch-alert.ts", import.meta.url).pathname;
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
  const missing = run(["--send-baseline"]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /requires --dry-run or --confirm SEND-BASELINE/);
  assert.match(missing.stderr, /Nothing was sent/);
  const wrong = run(["--send-baseline", "--confirm", "yes"]);
  assert.equal(wrong.status, 2);
  assert.equal(wrong.stdout, "");
  assert.match(wrong.stderr, /Nothing was sent/);
});

test("a one-shot alert includes the aged-lead heads-up even when the request is 14 days old or newer", () => {
  const held = buildAutoMatchAlert(ROW({}, { postedAt: "2026-11-10T18:15:00.000Z", lastSeenAt: "2026-11-10T18:15:00.000Z" }), { ...BASE_OPTS, oneShot: true });
  assert.equal(held.ageDays, 5);
  assert.equal(held.score, 90);
  assert.match(held.subject, /older lead/);
  assert.ok(held.text.includes(agedLeadLine(5, { oneShot: true })));
  assert.ok(held.html.includes(escapeHtml(agedLeadLine(5, { oneShot: true }))));
  const today = buildAutoMatchAlert(ROW(), { ...BASE_OPTS, oneShot: true });
  assert.equal(today.ageDays, 0);
  assert.doesNotMatch(today.subject, /older lead/i);
  assert.ok(today.text.includes(agedLeadLine(0, { oneShot: true })));
  assert.match(today.text, /this request came in today/);
  assert.doesNotMatch(`${held.from}\n${held.subject}\n${held.text}\n${held.html}`, /Bops|bop\.1on1realtors\.com|\/realty\/desk/i);
});

test("the one-shot plan unions suppressed and first-review keys, de-duplicates, and skips already-sent matches", () => {
  const a = buildAutoMatchAlert(ROW(), { ...BASE_OPTS, oneShot: true });
  const b = buildAutoMatchAlert(ROW({ listingKey: KEY_B, score: 69 }, { postId: RID_B }, { title: "GLENCOE FLAT", url: URL_B, area: "Glencoe", type: "apartment", beds: 2, price: 8000 }), { ...BASE_OPTS, oneShot: true });
  const c = buildAutoMatchAlert(ROW({ listingKey: "url:https://1on1realtors.com/property/new", score: 80 }, { postId: "cccccccccccccccccccccccc", area: "Cascade" }, { title: "NEW HILL", url: "https://1on1realtors.com/property/new", area: "Cascade", type: "house", beds: 4, price: 2_500_000 }), BASE_OPTS);
  const seeded = [
    { requestId: a.requestId, listingKey: a.listingKey, at: NOW.toISOString(), kind: "suppressed" as const },
    { requestId: b.requestId, listingKey: b.listingKey, at: NOW.toISOString(), kind: "sent" as const },
  ];
  const reviewKeys = new Set([alertKey(a), alertKey(b), alertKey(c)]);
  const one = planOneShotSend([a, a, b, c], seeded, { reviewKeys });
  assert.deepEqual(one.map((x) => x.requestId).sort(), [a.requestId, c.requestId].sort(), "a is suppressed+review (once), b is already sent, c is review-only");
  const live = planAlertDispatch([a, b, c], seeded, { enabled: true, sendExisting: false, holdKeys: new Set([alertKey(c)]) });
  assert.equal(live.send.length, 0, "the first-review key is held, not live-sent");
  assert.equal(live.skip.length, 2);
  assert.equal(live.suppress.length, 1);
  assert.equal(live.suppress[0].requestId, c.requestId);
  const freshNew = buildAutoMatchAlert(ROW({ listingKey: "url:https://1on1realtors.com/property/brand-new", score: 88 }, { postId: "dddddddddddddddddddddddd", area: "Cascade" }, { title: "BRAND NEW", url: "https://1on1realtors.com/property/brand-new", area: "Cascade", type: "house", beds: 4, price: 2_800_000 }), BASE_OPTS);
  const liveNew = planAlertDispatch([a, b, c, freshNew], seeded, { enabled: true, sendExisting: false, holdKeys: new Set([alertKey(c)]) });
  assert.equal(liveNew.send.length, 1);
  assert.equal(liveNew.send[0].requestId, "dddddddddddddddddddddddd", "genuinely new matches still go out live");
});

test("the one-shot skips a listing with no assigned agent or no agent email", () => {
  const unassigned = { ...ROW({}, {}, { agentId: null, agentName: null }), agentEmail: "office-should-not-be-used@1on1.example" };
  const noEmail = { ...ROW({ listingKey: KEY_B }, { postId: RID_B }, { agentId: 8, agentName: "Eve Other", url: URL_B }), agentEmail: null };
  const ok = { ...ROW(), agentEmail: "dana@1on1.example" };
  assert.equal(oneShotAgentStatus(unassigned), "no assigned agent");
  assert.equal(oneShotAgentStatus(noEmail), "no agent email");
  assert.equal(oneShotAgentStatus(ok), "ok");
});

test("the portable Auto-Match Alert builder has no fetch and no mail transport", () => {
  const src = readFileSync(new URL("../flow/automatch-alert.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /nodemailer|sendgrid|smtp|sendmail|mailgun|postmark|gmail|send_?message|agentmail/i);
});
