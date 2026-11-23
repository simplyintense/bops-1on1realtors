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
  ALERT_CC_STAFF_FLAG,
  ALERT_STAFF_BCC_DEFAULT,
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
  OFFICE_REPLY_LINE,
  alertFooter,
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
  alertCcStaff,
  alertEnvelopeLines,
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
  extraNeedsCaveat,
  fitClauses,
  matchFitText,
  openingLine,
  buildAutoMatchAlert,
  buildAutoMatchAlerts,
  flipReport,
  parseAddressList,
  parseAlertArgs,
  planAlertDispatch,
} from "../flow/automatch-alert.ts";
import { longDateAst, mentionedOnWhatsApp, relativeDayAst, shortDateTimeAst, timeAst12 } from "../flow/ast-time.ts";
import { leadMessage, publicListingUrl, type LeadInput } from "../flow/automatch-leads.ts";
import type { StatusRow } from "../flow/match-status.ts";

/**
 * 1on1 Auto-Match Alert: the subject, the from name, the opening line, the contact block with the quoted WhatsApp message,
 * the match and its public link, the suggested reply, and that "Bops", "Periskope", the group name and any Desk or bop link never
 * appear. Invented people and 555 numbers only.
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
/** The text body with every public listing link and the wa.me link read as the HTML link word, 'here'. */
const linkAsHere = (text: string): string => text.replace(/https:\/\/(?:www\.)?1on1realtors\.com\/\S+/g, "here").replace(/https:\/\/wa\.me\/\S+/g, "here");

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
  assert.equal(alertCcStaff({}), true, "ALERT_CC_STAFF defaults on");
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

test("ALERT_CC_STAFF off drops the staff CC, BCC's admin and Miles, and does not copy Wendy", () => {
  assert.equal(ALERT_CC_STAFF_FLAG, "ALERT_CC_STAFF");
  assert.equal(ALERT_STAFF_BCC_DEFAULT, "admin@1on1realtors.com");
  assert.equal(alertCcStaff({}), true);
  assert.equal(alertCcStaff({ [ALERT_CC_STAFF_FLAG]: "true" }), true);
  assert.equal(alertCcStaff({ [ALERT_CC_STAFF_FLAG]: "1" }), true);
  const offEnv = { [ALERT_CC_STAFF_FLAG]: "false" };
  for (const off of ["0", "false", "off", "no"]) {
    assert.equal(alertCcStaff({ [ALERT_CC_STAFF_FLAG]: off }), false, off);
    assert.deepEqual(alertCc({ [ALERT_CC_STAFF_FLAG]: off, [ALERT_CC_FLAG]: "wendy@1on1realtors.com" }), []);
    assert.deepEqual(alertBcc({ [ALERT_CC_STAFF_FLAG]: off }), ["admin@1on1realtors.com", "miles@simplyintense.com"]);
  }
  assert.deepEqual(alertBcc({}), ["miles@simplyintense.com"], "staff CC on: Miles only on BCC");
  const custom = alertBcc({ ...offEnv, [ALERT_BCC_FLAG]: "owner@1on1.example" });
  assert.deepEqual(custom, ["admin@1on1realtors.com", "owner@1on1.example"]);
  const already = alertBcc({ ...offEnv, [ALERT_BCC_FLAG]: "admin@1on1realtors.com,miles@simplyintense.com" });
  assert.deepEqual(already, ["admin@1on1realtors.com", "miles@simplyintense.com"]);
  const a = buildAutoMatchAlert({ ...ROW(), agentEmail: "dana@1on1.example" }, { ...BASE_OPTS, cc: alertCc(offEnv), bcc: alertBcc(offEnv) });
  assert.equal(a.to, "dana@1on1.example");
  assert.deepEqual(a.cc, []);
  assert.deepEqual(a.bcc, ["admin@1on1realtors.com", "miles@simplyintense.com"]);
  assert.doesNotMatch([a.to, ...a.cc, ...a.bcc].join(","), /wendy@1on1realtors\.com/);
  const visible = [a.from, a.to, a.cc.join(", "), a.subject, a.text, a.html].join("\n");
  assert.doesNotMatch(visible, /admin@1on1realtors\.com|miles@simplyintense\.com|Bcc:|BCC:/i, "BCC stays off what the agent sees");
  assert.equal(
    alertEnvelopeLines(a),
    "To: dana@1on1.example\nCc: (none)\nBcc: admin@1on1realtors.com, miles@simplyintense.com",
  );
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
  assert.match(aged.text, /Based on a message received on WhatsApp on Wednesday 14 Oct at 2:15 PM AST, we believe/);
  assert.doesNotMatch(`${aged.from}\n${aged.subject}\n${aged.text}\n${aged.html}`, /Bops|bop\.1on1realtors\.com|\/realty\/desk/i);
  const testAged = buildTestAutoMatchAlert(NOW, { baseUrl: BASE, agedDays: 32 });
  assert.equal(testAged.to, TEST_ALERT_TO);
  assert.match(testAged.subject, /^\[TEST\] 1on1 Auto-Match Alert: older lead · /);
  assert.match(testAged.text, /from 32 days ago/);
  assert.deepEqual(testAged.cc, []);
  assert.deepEqual(testAged.bcc, []);
  assert.equal(wordsOf(linkAsHere(aged.text)), wordsOf(alertTextFromHtml(aged.html)));
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

test("the opening says when the message was received: the long weekday, the calendar date and the AST time, and no soft mention", () => {
  assert.equal(timeAst12("2026-11-15T18:15:00.000Z"), "2:15 PM AST");
  assert.equal(longDateAst("2026-11-10T21:30:00.000Z"), "Tuesday 10 Nov");
  assert.equal(shortDateTimeAst("2026-11-10T21:30:00.000Z"), "Tue 10 Nov, 5:30 PM AST");
  assert.equal(
    mentionedOnWhatsApp("2026-11-15T18:15:00.000Z", NOW),
    "A contact mentioned this property on WhatsApp earlier today at 2:15 PM AST.",
    "the old helper stays for other callers, even though the alert no longer uses it",
  );
  const a = buildAutoMatchAlert(ROW({}, { postedAt: "2026-11-10T21:30:00.000Z", lastSeenAt: "2026-11-10T21:30:00.000Z" }), BASE_OPTS);
  const opening = "Based on a message received on WhatsApp on Tuesday 10 Nov at 5:30 PM AST, we believe this property that you are holding is a strong match. Please see the message below.";
  assert.equal(a.text.split("\n").slice(0, 3).join("\n"), `Hi Dana,\n\n${opening}`);
  assert.ok(a.html.includes(`<p>${escapeHtml(opening)}</p>`));
  assert.equal(openingLine("2026-11-10T21:30:00.000Z"), opening);
  assert.doesNotMatch(`${a.text}\n${a.html}`, /A contact mentioned|earlier today|yesterday|Here is a strong match for a listing you hold|Heads up: this request is from 0/);
  const blind = buildAutoMatchAlert(ROW({}, { postedAt: "not a time", lastSeenAt: "not a time" }), BASE_OPTS);
  assert.ok(blind.text.includes("Based on a message received on WhatsApp, we believe this property that you are holding is a strong match. Please see the message below."));
  assert.doesNotMatch(blind.text, /\bAST\b|Received:/, "no invented time");
  assert.equal(blind.ageDays, null);
  const office = buildAutoMatchAlert(ROW({}, {}, { agentId: null, agentName: null }), BASE_OPTS);
  assert.match(office.text, /^Hi,\n\nBased on a message received on WhatsApp on Sunday 15 Nov at 2:15 PM AST/);
});

test("the contact block: the name, the phone as a tel: link, the WhatsApp link, when it was received, and the exact quoted message (trimmed only)", () => {
  const a = buildAutoMatchAlert(ROW({}, { originalText: "  Need a 3 bed townhouse in Maraval,\n budget 2.5m  " }), BASE_OPTS);
  assert.ok(a.text.includes("Contact\nName: Dana Tester\nPhone: +1 868 555 0100\nMessage on WhatsApp, with the message filled in:\nhttps://wa.me/18685550100?text="));
  assert.ok(a.text.includes("\nReceived: Sun 15 Nov, 2:15 PM AST\nTheir WhatsApp message:\n“Need a 3 bed townhouse in Maraval,\n budget 2.5m”\n"));
  assert.ok(a.html.includes(`<h3>Contact</h3>`) && a.html.indexOf(`href="${a.waUrl}"`) < a.html.indexOf("<h3>The match</h3>"), "the WhatsApp link is in the Contact block, above the match");
  assert.ok(a.html.includes(`<p>Message on WhatsApp, with the message filled in: <a href="${a.waUrl}">here</a></p>`));
  assert.ok(a.html.includes("<p>Phone: <a href=\"tel:+18685550100\">+1 868 555 0100</a></p>"));
  assert.ok(a.html.includes("<p>“Need a 3 bed townhouse in Maraval,<br> budget 2.5m”</p>"));
  const noName = buildAutoMatchAlert(ROW({}, { senderName: "+1 868 555 0100", originalText: "3 bed" }), BASE_OPTS);
  assert.doesNotMatch(noName.text, /Name:/, "a phone number is not shown as a name");
  assert.doesNotMatch(noName.html, /Name:/);
  const noSender = buildAutoMatchAlert(ROW({}, { senderName: null }), BASE_OPTS);
  assert.doesNotMatch(noSender.text, /Name:/);
  assert.doesNotMatch(noSender.html, /Name:/);
  assert.ok(noSender.text.includes("Contact\nPhone: +1 868 555 0100\n"), "the Contact block still starts with the phone when there is no name");
  const noText = buildAutoMatchAlert(ROW({}, { originalText: null }), BASE_OPTS);
  assert.ok(noText.text.includes("Their WhatsApp message:\nNo message text is on file for this ask, so there is nothing to quote.\n"));
  assert.ok(noText.html.includes("No message text is on file for this ask, so there is nothing to quote."));
  assert.doesNotMatch(noText.text, /“/, "no quote is invented");
  const blankText = buildAutoMatchAlert(ROW({}, { originalText: "   " }), BASE_OPTS);
  assert.ok(blankText.text.includes("No message text is on file"));
});

test("the match block: title and price on one line, a plain fit line, a generic caveat only when the message names an extra need, and the public link", () => {
  const plain = buildAutoMatchAlert(ROW({}, { originalText: "3 bed townhouse in Maraval, budget 4.3m" }), BASE_OPTS);
  assert.ok(plain.text.includes("The match\nThird Urban, Maraval, 3-bed townhouse · TT$3.7m\nThis is a strong fit: it's in Maraval, the area they asked for; it has the 3 bedrooms they asked for; it's TT$600k under their budget.\n"));
  assert.doesNotMatch(plain.text, /extra needs/, "no caveat when the message names no extra need");
  assert.ok(plain.text.includes("View the property:\nhttps://1on1realtors.com/property/third-urban\n"));
  assert.ok(plain.html.includes(`<p>View the property: <a href="${URL_A}">here</a></p>`));
  const extras = buildAutoMatchAlert(ROW({}, { originalText: "Need 3 bed townhouse in Maraval with parking for two, pets ok" }), BASE_OPTS);
  assert.ok(extras.text.includes("Check the ask's extra needs before you call.\n"));
  assert.ok(extras.html.includes("<p>Check the ask&#39;s extra needs before you call.</p>"));
  const caveatLine = extras.text.split("\n").filter((l) => l.startsWith("Check the ask"));
  assert.deepEqual(caveatLine, ["Check the ask's extra needs before you call."], "the caveat is the generic line, naming no extra");
  const bare = buildAutoMatchAlert(ROW({}, { originalText: null }), BASE_OPTS);
  assert.doesNotMatch(bare.text, /extra needs/, "no message text, so no caveat");
  const noLink = buildAutoMatchAlert(ROW({}, {}, { url: "https://bop.1on1realtors.com/property/third-urban" }), BASE_OPTS);
  assert.ok(noLink.text.includes("View the property: no link on file."));
  assert.ok(noLink.html.includes("<p>View the property: no link on file.</p>"));
  assert.doesNotMatch(`${noLink.text}\n${noLink.html}\n${noLink.message}\n${noLink.waUrl ?? ""}`, /bop\.1on1realtors\.com/);
});

test("the public listing link is in the email twice: 'View the property' and the suggested reply; HTML shows 'here', text and the wa.me text carry the raw URL", () => {
  const a = buildAutoMatchAlert(ROW({}, { originalText: "3 bed townhouse in Maraval" }), BASE_OPTS);
  const count = (s: string, sub: string): number => s.split(sub).length - 1;
  assert.equal(count(a.text, URL_A), 2, "text: the view line and the reply line");
  assert.equal(count(a.html, `href="${URL_A}"`), 2, "html: two links");
  assert.equal(count(a.html, `>${URL_A}<`), 0, "html: the raw URL is never the visible text");
  assert.equal(count(a.html, ">here</a>"), 3, "html: here for the view link, the reply's link, and the wa.me link");
  assert.match(a.text, new RegExp(`View the property:\\n${URL_A}\\n`));
  assert.match(a.text, new RegExp(`\\n${URL_A}\\nHappy to set up a viewing\\.`), "the reply's link is on its own line in text");
  const payload = decodeURIComponent(a.waUrl?.split("?text=")[1] ?? "");
  assert.equal(payload, a.message);
  assert.ok(payload.includes(URL_A), "the wa.me text keeps the full public URL, since WhatsApp cannot link a word");
  assert.doesNotMatch(payload, /\bhere\b/, "the word 'here' is only the HTML display");
  assert.ok(a.message.includes(URL_A));
});

test("no Bops, Periskope, group name, bop host or Desk link anywhere in from, subject, text or html, even with a quoted message and the production base URL", () => {
  const forbidden = /Bops|Periskope|\bgroups?\b|bop\.1on1realtors\.com|\/realty\/desk|Outcome:|Record how it went on the Desk|view on the Desk|\blog in\b/i;
  const withText = { originalText: "Need a 3 bed townhouse in Maraval, budget 2.5m, parking please." };
  const cases = [
    buildAutoMatchAlert(ROW({}, withText), { ...BASE_OPTS, baseUrl: "https://bop.1on1realtors.com" }),
    buildAutoMatchAlert(ROW({}, { originalText: null }), { ...BASE_OPTS, baseUrl: "https://bop.1on1realtors.com" }),
    buildAutoMatchAlert(ROW({}, { ...withText, senderPhone: "" }, { agentId: null, agentName: null }), { ...BASE_OPTS, baseUrl: "https://bop.1on1realtors.com", oneShot: true }),
    buildTestAutoMatchAlert(NOW, { baseUrl: "https://bop.1on1realtors.com", agedDays: 32 }),
  ];
  for (const a of cases) {
    const rendered = `${a.from}\n${a.subject}\n${a.text}\n${a.html}`;
    assert.doesNotMatch(rendered, forbidden, a.subject);
  }
});

test("the suggested reply names no type or area the contact did not say: 'a 3 bedroom' when the type is unknown, and no area the message does not name", () => {
  const typeless = buildAutoMatchAlert(ROW({}, { type: null, area: "Maraval", originalText: "Looking for 3 bedrooms, pool a bonus" }), BASE_OPTS);
  assert.ok(typeless.message.startsWith("Hi Dana, I hear you have a client looking for a 3 bedroom around TT$4.3m. I have "), typeless.message);
  assert.doesNotMatch(typeless.message.split(". I have ")[0], /townhouse|Maraval|bed townhouse|-bed/i);
  assert.doesNotMatch(typeless.text, /a 3 bed townhouse in Maraval/);
  const unsaid = buildAutoMatchAlert(ROW({}, { area: "Maraval", type: "townhouse", originalText: "3 bed house, something near Cascade" }), BASE_OPTS);
  assert.ok(unsaid.message.startsWith("Hi Dana, I hear you have a client looking for a 3 bedroom around TT$4.3m. I have "), unsaid.message);
  const several = buildAutoMatchAlert(ROW({}, { originalText: "3 bed townhouse preferably Maraval but open to Cascade" }), BASE_OPTS);
  assert.ok(several.message.startsWith("Hi Dana, I hear you have a client looking for a 3 bed townhouse around TT$4.3m. I have "), several.message);
  assert.doesNotMatch(several.message.split(". I have ")[0], /in Maraval/);
});

test("the pure fit line: area (same or nearby), beds (same or one off), the TT$ budget gap (under, over, USD, rent), and the strong opening", () => {
  const under = "This is a strong fit: it's in Maraval, the area they asked for; it has the 3 bedrooms they asked for; it's TT$600k under their budget.";
  assert.equal(matchFitText(ROW()), under);
  assert.equal(matchFitText(ROW({}, {}, { price: 4_500_000 })), "This is a strong fit: it's in Maraval, the area they asked for; it has the 3 bedrooms they asked for; it's TT$200k over their budget.");
  assert.equal(matchFitText(ROW({}, { currency: "USD", budget: 650_000 })), "This is a strong fit: it's in Maraval, the area they asked for; it has the 3 bedrooms they asked for; it's TT$707k under their budget.", "a USD ask compares in TT$ at the fixed rate");
  assert.equal(matchFitText(ROW({}, {}, { beds: 4 })), "This is a strong fit: it's in Maraval, the area they asked for; it has 4 bedrooms, one more than the 3 they asked for; it's TT$600k under their budget.");
  assert.equal(matchFitText(ROW({}, {}, { beds: 2 })), "This is a strong fit: it's in Maraval, the area they asked for; it has 2 bedrooms, one fewer than the 3 they asked for; it's TT$600k under their budget.");
  assert.equal(matchFitText(ROW({}, {}, { beds: 5 })), "This is a strong fit: it's in Maraval, the area they asked for; it's TT$600k under their budget.", "two off is not said");
  assert.equal(matchFitText(ROW({ reason: "Nearby (Glencoe, ~9 min drive), 3 bed" }, { area: "Maraval" }, { area: "Glencoe" })), "This is a strong fit: it's nearby in Glencoe, ~9 min drive from the area they asked for; it has the 3 bedrooms they asked for; it's TT$600k under their budget.");
  assert.equal(matchFitText(ROW({ reason: "Neighbour of Maraval, 3 bed" }, { area: "Maraval" }, { area: "Cascade" })).includes("next to the area they asked for"), true);
  assert.equal(matchFitText(ROW({}, {}, { price: 4_300_000 })).includes("it's right at their budget"), true);
  assert.equal(matchFitText(ROW({}, { listingType: "rent", budget: 9000, currency: "TTD" }, { price: 8000 })).includes("it's TT$1,000 a month under their budget."), true);
  assert.equal(matchFitText(ROW({ score: 60 })).startsWith("This could be a fit: "), true);
  assert.deepEqual(fitClauses(ROW({}, { area: "", beds: null, budget: null }, { area: null, beds: null, price: null })), []);
  assert.equal(matchFitText(ROW({}, { area: "", beds: null, budget: null }, { area: null, beds: null, price: null })), "This is a strong fit.");
});

test("the extra-needs caveat is generic, only when the message names an extra, and never names it", () => {
  assert.equal(extraNeedsCaveat("3 bed townhouse in Maraval"), null);
  assert.equal(extraNeedsCaveat(null), null);
  assert.equal(extraNeedsCaveat("   "), null);
  for (const extra of ["Need a home office", "pets allowed?", "parking for two", "furnished please", "a pool", "garden", "a gym"]) {
    assert.equal(extraNeedsCaveat(`3 bed townhouse, ${extra}`), "Check the ask's extra needs before you call.", extra);
  }
});

test("publicListingUrl accepts only http(s) on 1on1realtors.com or www.1on1realtors.com, and gives null for anything else", () => {
  assert.equal(publicListingUrl("https://1on1realtors.com/property/x"), "https://1on1realtors.com/property/x");
  assert.equal(publicListingUrl("http://www.1on1realtors.com/property/x"), "http://www.1on1realtors.com/property/x");
  assert.equal(publicListingUrl("  https://1on1realtors.com/property/x  "), "https://1on1realtors.com/property/x");
  for (const bad of [null, undefined, "", "   ", "https://bop.1on1realtors.com/property/x", "https://bop.1on1realtors.com/realty/desk", "https://1on1realtors.com.evil.example/x", "https://evil.example/1on1realtors.com", "javascript:alert(1)", "ftp://1on1realtors.com/x", "https://user:pw@1on1realtors.com/x", "1on1realtors.com/property/x"]) {
    assert.equal(publicListingUrl(bad as string), null, String(bad));
  }
});

test("the subject, from, reply-to and the footer are unchanged, and the body has no other 'hot match' or 'Here is a strong match' copy", () => {
  const a = buildAutoMatchAlert(ROW({}, { originalText: "3 bed townhouse in Maraval" }), { ...BASE_OPTS, fromName: ALERT_NAME, fromEmail: "alerts@1on1realtors.com" });
  assert.equal(a.subject, "1on1 Auto-Match Alert: townhouse · 3 bed · Maraval · TT$3.7M");
  assert.equal(a.from, "1on1 Auto-Match Alert <alerts@1on1realtors.com>");
  assert.equal(a.to, OFFICE_TO, "no agent email on the default row: the office is the recipient");
  assert.ok(a.text.endsWith(`${OFFICE_REPLY_LINE}\n`));
  assert.ok(a.html.includes(`<p>${OFFICE_REPLY_LINE}</p>`));
  assert.doesNotMatch(`${a.text}\n${a.html}`, /let admin know/);
  assert.doesNotMatch(`${a.text}\n${a.html}`, /hot or live match|Here is a strong match for a listing you hold|A contact mentioned/);
  assert.equal(HOT_MATCH_LINE.length > 0, true, "the constant stays exported for other callers");
});

test("the contact's direct number is a readable E.164-style line with a tel: link, next to the wa.me link; no number omits the phone line", () => {
  const a = buildAutoMatchAlert(ROW(), BASE_OPTS);
  assert.equal(a.phoneText, "+1 868 555 0100");
  assert.equal(a.tel, "tel:+18685550100");
  assert.ok(a.waUrl?.startsWith("https://wa.me/18685550100?text="));
  assert.match(a.text, /Call: \+1 868 555 0100 \(tel:\+18685550100\)/);
  assert.match(a.text, /Message on WhatsApp, with the message filled in:\nhttps:\/\/wa\.me\/18685550100\?text=/);
  assert.match(a.html, /<a href="tel:\+18685550100">\+1 868 555 0100<\/a>/);
  assert.ok(a.html.includes(`<a href="${a.waUrl}">here</a>`));
  assert.equal(a.html.includes(`>${a.waUrl}<`), false, "the raw wa.me URL is not visible HTML text");
  assert.equal(decodeURIComponent(a.waUrl?.split("?text=")[1] ?? ""), a.message);
  assert.equal(a.message, leadMessage(ROW()));

  const none = buildAutoMatchAlert(ROW({}, { senderPhone: "" }), BASE_OPTS);
  assert.equal(none.phoneText, null);
  assert.equal(none.tel, null);
  assert.equal(none.waUrl, null);
  assert.doesNotMatch(none.text, /Call:|tel:/);
  assert.doesNotMatch(none.html, /tel:/);
  assert.match(none.text, /Contact\nName: Dana Tester\nNo usable WhatsApp number on this ask, so there's no link\.\n/, "the Contact block says there is no link");
  assert.match(none.html, /<h3>Contact<\/h3>[\s\S]*<p>No usable WhatsApp number on this ask, so there(?:'|&#39;)s no link\.<\/p>/);
  assert.doesNotMatch(none.text, /wa\.me/);
  assert.doesNotMatch(none.html, /wa\.me/);
});

test("the footer: the office is told to use the link above, a named agent is invited to reply to the office; no footer says 'let admin know'", () => {
  assert.equal(alertFooter(true), OFFICE_REPLY_LINE);
  assert.equal(alertFooter(false), REPLY_LINE);
  const agent = buildAutoMatchAlert({ ...ROW({}, { originalText: "3 bed" }), agentEmail: "dana@1on1.example" }, BASE_OPTS);
  assert.equal(agent.to, "dana@1on1.example");
  assert.ok(agent.text.endsWith("Reply to this email to let the office know how it went.\n"), "a named agent");
  assert.ok(agent.html.includes("<p>Reply to this email to let the office know how it went.</p>"));
  for (const office of [buildAutoMatchAlert(ROW({}, {}, { agentId: null, agentName: null }), BASE_OPTS)]) {
    assert.equal(office.to.toLowerCase(), OFFICE_TO);
    assert.ok(office.text.endsWith(`${OFFICE_REPLY_LINE}\n`), office.to);
    assert.ok(office.html.includes(`<p>${OFFICE_REPLY_LINE}</p>`));
    assert.doesNotMatch(`${office.text}\n${office.html}`, /let admin know|let the office know/);
  }
  const nameless = buildAutoMatchAlert(ROW({}, { originalText: "3 bed" }, { agentId: null, agentName: null }), { ...BASE_OPTS, officeEmail: "office@1on1realtors.com" });
  assert.equal(nameless.to, "office@1on1realtors.com");
  assert.ok(nameless.text.endsWith(`${OFFICE_REPLY_LINE}\n`), "the configured office address is the office too");
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

test("the text and the HTML say the same words once every public listing link and the wa.me link read as 'here', and the HTML stays style-free", () => {
  const cases: LeadInput[][] = [
    [ROW({}, { originalText: "Need a 3 bed townhouse in Maraval, budget 2.5m, parking please." })],
    [ROW({}, { senderPhone: "" })],
    [ROW({}, { currency: "USD", budget: 650_000, originalText: "Need 3 bed & pool, <3m budget" }, { currency: "USD", price: 650_000 })],
    [ROW({}, {}, { agentId: null, agentName: null, url: null, price: null })],
    [ROW({}, { postedAt: "2026-11-13T18:15:00.000Z", lastSeenAt: "2026-11-13T18:15:00.000Z", originalText: "3 bed\nmultiline ask" })],
    [ROW({}, { postedAt: "2026-10-14T18:15:00.000Z", lastSeenAt: "2026-10-14T18:15:00.000Z", originalText: null })],
    [ROW({}, { originalText: "3 bed townhouse in Maraval" }, { url: "https://bop.1on1realtors.com/property/third-urban" })],
  ];
  const allowed = new Set(["html", "body", "p", "h3", "a", "br", "strong"]);
  for (const rows of cases) {
    const a = buildAutoMatchAlert(rows[0], BASE_OPTS);
    assert.equal(wordsOf(linkAsHere(a.text)), wordsOf(alertTextFromHtml(a.html)), a.html);
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
