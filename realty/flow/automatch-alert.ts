import { bandOf } from "./automatch.ts";
import { digestRows, escapeHtml, publicBaseUrl, DEFAULT_PUBLIC_URL } from "./admin-digest.ts";
import { dayKeyAst, longDateAst, shortDateTimeAst, timeAst12 } from "./ast-time.ts";
import { firstNameOf, leadCardId, leadMessage, listingPriceText, publicListingUrl, waUrlFor, type LeadInput } from "./automatch-leads.ts";
import type { Env } from "./env.ts";
import { isUsd, shortMoney, ttdValue } from "./fx.ts";
import { phoneLabel, telHref } from "./listing-contact.ts";
import { shortListingTitle } from "./listing-title.ts";
import type { StatusRow } from "./match-status.ts";

/**
 * 1on1 Auto-Match Alert: one email per strong Automatch match (75 and above), addressed to the agent who holds the listing
 * (unassigned listings go to the office). The default audience is every agent who holds a strong match; AUTOMATCH_ALERT_ALLOWLIST
 * may narrow that to a list of emails, and is empty by default. This module is the builder and the dispatch planner only: it
 * returns the from line, the CC list, the subject, a plain-text body and a simple HTML body. It never sends. There is no mail
 * transport here. Live sending is off unless AUTOMATCH_ALERT_ENABLED is "1" or "true", and even then this build has no transport.
 *
 * User-facing name: "1on1 Auto-Match Alert". The word "Bops" must never appear in the from name, the subject, the body or
 * the footer (it may appear in internal module names only). The default sender is "1on1 Auto-Match Alert". The body never
 * names Miles. Each alert is CC'd to AUTOMATCH_ALERT_CC (default Chrystalle and Wendy) when ALERT_CC_STAFF is on
 * (the default) and BCC'd to AUTOMATCH_ALERT_BCC (default Miles). When ALERT_CC_STAFF is off, there is no CC: the
 * agent is the only To recipient, admin@ is added to BCC, and Miles stays on BCC. Wendy is not copied. The BCC list
 * is for the transport only: it must not appear in the From, To, Cc, Subject, or body that agents see.
 *
 * Per alert, in order: an opening line (the posted day and time in AST, "Based on a message received on WhatsApp on Tuesday 10
 * Nov at 5:30 PM AST …"), the older-lead heads-up when it applies, a Contact block (the sender's name, the tap-to-call number,
 * the "Message on WhatsApp" link, when it was received, and the contact's own WhatsApp message quoted exactly), the match (listing,
 * price, a plain-words fit line, a generic caveat when the message names an extra need, and a link to the public listing), an
 * optional suggested reply with the public link and the tap-to-call number, and a footer that says how to reply (see alertFooter).
 * The group name is never in the input or the body, and the body never links to the Desk or to bop.1on1realtors.com: only a
 * public 1on1realtors.com listing is linked.
 *
 * Portable: no node:*, no next, no bare process.
 */

/** The user-facing product name, and the default From display name. */
export const ALERT_NAME = "1on1 Auto-Match Alert";

/** The live-send switch. On only when the value is "1" or "true" (any case). Deploy with this false. */
export const ALERT_ENABLED_FLAG = "AUTOMATCH_ALERT_ENABLED";

/** When "1" or "true", unsent and previously suppressed matches are emailed (an explicit backlog send). Off by default. */
export const ALERT_SEND_EXISTING_FLAG = "AUTOMATCH_ALERT_SEND_EXISTING";

/** Optional allowlist of agent emails; empty or unset means every agent with a strong match. */
export const ALERT_ALLOWLIST_FLAG = "AUTOMATCH_ALERT_ALLOWLIST";

/** Comma-separated CC list. Unset uses ALERT_CC_DEFAULT (Chrystalle and Wendy). */
export const ALERT_CC_FLAG = "AUTOMATCH_ALERT_CC";

export const ALERT_CC_DEFAULT = "admin@1on1realtors.com,wendy@1on1realtors.com";

/** Staff CC switch for instant alerts. On by default. When "0", "false" or "off", CC is empty and admin@ is BCC'd with Miles. Wendy is not copied. */
export const ALERT_CC_STAFF_FLAG = "ALERT_CC_STAFF";

/** Hidden staff copy added to BCC when ALERT_CC_STAFF is off (Wendy is not included). */
export const ALERT_STAFF_BCC_DEFAULT = "admin@1on1realtors.com";

/** Comma-separated BCC list. Unset uses ALERT_BCC_DEFAULT (Miles). Not shown in the agent-facing headers or body. */
export const ALERT_BCC_FLAG = "AUTOMATCH_ALERT_BCC";

export const ALERT_BCC_DEFAULT = "miles@simplyintense.com";

/** Optional From display name; unset, the default is ALERT_NAME. */
export const ALERT_FROM_NAME_FLAG = "AUTOMATCH_ALERT_FROM_NAME";

/** Optional From email address for the preview's From line (alias of AUTOMATCH_ALERT_FROM_ADDRESS). */
export const ALERT_FROM_EMAIL_FLAG = "AUTOMATCH_ALERT_FROM_EMAIL";

/** From address used in the From header. Default ALERT_FROM_ADDRESS_DEFAULT. */
export const ALERT_FROM_ADDRESS_FLAG = "AUTOMATCH_ALERT_FROM_ADDRESS";
export const ALERT_FROM_ADDRESS_DEFAULT = "alerts@1on1realtors.com";

/** Reply-To address. Default ALERT_REPLY_TO_DEFAULT. */
export const ALERT_REPLY_TO_FLAG = "AUTOMATCH_ALERT_REPLY_TO";
export const ALERT_REPLY_TO_DEFAULT = "admin@1on1realtors.com";

/** The only recipient of a manual [TEST] send. */
export const TEST_ALERT_TO = "miles@simplyintense.com";

/** When exactly "1", the From name and the body attribution are Miles, so a later switch is one setting. */
export const ALERT_AS_MILES_FLAG = "AUTOMATCH_ALERT_AS_MILES";

/** Optional office address for unassigned listings (default OFFICE_TO). */
export const ALERT_OFFICE_EMAIL_FLAG = "AUTOMATCH_ALERT_OFFICE_EMAIL";

/** The office address used when a listing has no holding agent, or no agent email is on file. */
export const OFFICE_TO = "admin@1on1realtors.com";

export const OFFICE_NAME = "Office";

/** Miles's display name when AUTOMATCH_ALERT_AS_MILES is on. */
export const MILES_FROM_NAME = "Miles Abraham";

export const HOT_MATCH_LINE =
  "Based on this information, we believe there's a hot or live match for this property. Please reach out to the agent.";

export const SEND_OFF = "Sending Auto-Match Alert is off. This command only renders a preview; nothing was sent.";

export const WA_LABEL = "Message on WhatsApp, with the message filled in:";
export const NO_WA = "No usable WhatsApp number on this ask, so there's no link.";
/** The footer for an agent: the reply goes to the office. */
export const REPLY_LINE = "Reply to this email to let the office know how it went.";
/** The footer when the alert went to the office itself: the reply is the WhatsApp or phone link in the Contact block. */
export const OFFICE_REPLY_LINE = "Use the WhatsApp or phone link above to reach the sender.";

/** The footer line for this recipient: the office is told how to reach the sender, an agent is asked to reply to the office. */
export function alertFooter(isOffice: boolean): string {
  return isOffice ? OFFICE_REPLY_LINE : REPLY_LINE;
}

/** A request older than this many calendar days (AST) is flagged as an older lead. */
export const AGED_LEAD_DAYS = 14;

/** Confirm token required by the one-shot CLI that emails previously suppressed baseline matches. */
export const BASELINE_CONFIRM = "SEND-BASELINE";

const NO_PRICE = "no price listed";
const NO_LINK = "no link on file";
export const NO_MESSAGE_TEXT = "No message text is on file for this ask, so there is nothing to quote.";
const NOTE_USD = "this ask was in US$; the TT$ figure is the fixed-rate equivalent.";

export type AlertInput = LeadInput & {
  /** The holding agent's email, when the CRM has one. */
  agentEmail?: string | null;
};

export type AlertAttribution = { fromName: string; asMiles: boolean };

export type AutoMatchAlert = {
  to: string;
  toName: string;
  fromName: string;
  fromEmail: string | null;
  /** "Name" or "Name <email>". */
  from: string;
  /** CC addresses (Crystal and Wendy by default). Visible to the agent. */
  cc: string[];
  /** BCC addresses (Miles by default). For the transport only; never rendered in the agent-facing headers or body. */
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  requestId: string;
  listingKey: string;
  /** Readable E.164-style number, or null when none is usable. */
  phoneText: string | null;
  tel: string | null;
  waUrl: string | null;
  deskUrl: string;
  message: string;
  /** Calendar days in AST from when the request was posted, or null when the time is unreadable. */
  ageDays: number | null;
  listingTitle: string;
  score: number;
};

export type AlertBuildOpts = {
  statuses: readonly StatusRow[];
  baseUrl: string;
  now: Date;
  /** When true, the subject is prefixed with "[TEST] ". */
  test?: boolean;
  fromName?: string;
  fromEmail?: string | null;
  asMiles?: boolean;
  officeEmail?: string;
  cc?: readonly string[];
  bcc?: readonly string[];
  allowlist?: readonly string[];
  /** When true, the aged-lead heads-up is included even if the request is 14 days old or newer. */
  oneShot?: boolean;
};

/** The From display name and whether the body is attributed to Miles. */
export function alertAttribution(env: Env = {}): AlertAttribution {
  const asMiles = env[ALERT_AS_MILES_FLAG] === "1";
  const override = (env[ALERT_FROM_NAME_FLAG] ?? "").trim();
  if (override) return { fromName: override, asMiles };
  return { fromName: asMiles ? MILES_FROM_NAME : ALERT_NAME, asMiles };
}

export function alertFromEmail(env: Env = {}): string | null {
  const raw = (env[ALERT_FROM_ADDRESS_FLAG] ?? env[ALERT_FROM_EMAIL_FLAG] ?? "").trim();
  return raw || ALERT_FROM_ADDRESS_DEFAULT;
}

/** The From address, default alerts@1on1realtors.com. */
export function alertFromAddress(env: Env = {}): string {
  return alertFromEmail(env) ?? ALERT_FROM_ADDRESS_DEFAULT;
}

/** "1on1 Auto-Match Alert <alerts@1on1realtors.com>". */
export function alertFromHeader(env: Env = {}): string {
  return `${alertAttribution(env).fromName} <${alertFromAddress(env)}>`;
}

export function alertReplyTo(env: Env = {}): string {
  const raw = (env[ALERT_REPLY_TO_FLAG] ?? "").trim();
  return raw || ALERT_REPLY_TO_DEFAULT;
}

/** A stable Resend Idempotency-Key for one match, so a retry cannot double-send. */
export function alertIdempotencyKey(requestId: string, listingKey: string): string {
  const raw = `automatch-alert:${requestId}:${listingKey}`;
  return raw.replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 256);
}

/** Strip API keys and bearer tokens from an error string so it can be logged. */
export function scrubMailError(s: string): string {
  return s
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bre_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/RESEND_API_KEY\s*[=:]\s*\S+/gi, "RESEND_API_KEY=[redacted]");
}

export function officeEmail(env: Env = {}): string {
  const raw = (env[ALERT_OFFICE_EMAIL_FLAG] ?? "").trim();
  return raw || OFFICE_TO;
}

/** A comma-separated list of emails, trimmed, lower-cased, duplicates dropped, empties dropped. */
export function parseAddressList(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const e = part.trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/** True when the value is "1" or "true" (any case). */
export function flagOn(value: string | undefined): boolean {
  return ["1", "true"].includes((value ?? "").trim().toLowerCase());
}

/** True when unset/empty (the default), or not an explicit off ("0", "false", "off", "no"). */
export function flagDefaultOn(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return true;
  return !["0", "false", "off", "no"].includes(v);
}

/** Staff CC on instant alerts: on unless ALERT_CC_STAFF is an explicit off. */
export function alertCcStaff(env: Env = {}): boolean {
  return flagDefaultOn(env[ALERT_CC_STAFF_FLAG]);
}

function listOrDefault(env: Env, flag: string, fallback: string): string[] {
  return Object.prototype.hasOwnProperty.call(env, flag) && (env[flag] ?? "").trim() !== ""
    ? parseAddressList(env[flag])
    : parseAddressList(fallback);
}

/** CC addresses: AUTOMATCH_ALERT_CC, or the default (Chrystalle and Wendy) when unset. Empty when ALERT_CC_STAFF is off. */
export function alertCc(env: Env = {}): string[] {
  if (!alertCcStaff(env)) return [];
  return listOrDefault(env, ALERT_CC_FLAG, ALERT_CC_DEFAULT);
}

function mergeAddresses(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const e = raw.trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

/** BCC addresses: AUTOMATCH_ALERT_BCC, or Miles when unset. When ALERT_CC_STAFF is off, admin@ is included too. Never shown in the agent-facing message. */
export function alertBcc(env: Env = {}): string[] {
  const bcc = listOrDefault(env, ALERT_BCC_FLAG, ALERT_BCC_DEFAULT);
  if (alertCcStaff(env)) return bcc;
  return mergeAddresses(parseAddressList(ALERT_STAFF_BCC_DEFAULT), bcc);
}

/** Operator-facing envelope (To / Cc / Bcc). Not part of the agent-facing email. */
export function alertEnvelopeLines(a: { to: string; cc: readonly string[]; bcc: readonly string[] }): string {
  const cc = a.cc.length ? a.cc.join(", ") : "(none)";
  const bcc = a.bcc.length ? a.bcc.join(", ") : "(none)";
  return `To: ${a.to}\nCc: ${cc}\nBcc: ${bcc}`;
}

/** Agent-email allowlist; empty means every agent with a strong match. */
export function alertAllowlist(env: Env = {}): string[] {
  return parseAddressList(env[ALERT_ALLOWLIST_FLAG]);
}

export function alertEnabled(env: Env = {}): boolean {
  return flagOn(env[ALERT_ENABLED_FLAG]);
}

export function alertSendExisting(env: Env = {}): boolean {
  return flagOn(env[ALERT_SEND_EXISTING_FLAG]);
}

/** The live switch: on only when AUTOMATCH_ALERT_ENABLED is "1" or "true". The node layer also needs a transport to actually send. */
export function alertSendState(env: Env): { flagOn: boolean; sending: false; message: string } {
  return { flagOn: alertEnabled(env), sending: false, message: SEND_OFF };
}

/** Whether this alert's To address is in the allowlist (an empty list allows everyone). */
export function allowedRecipient(to: string, allowlist: readonly string[]): boolean {
  if (!allowlist.length) return true;
  return allowlist.includes(to.trim().toLowerCase());
}

/** The command-line flags: --out, --txt, --test, --send, --send-baseline, --dry-run, --confirm, --aged. Pure: the argv comes in. */
export type AlertArgs = {
  send: boolean;
  test: boolean;
  testSend: boolean;
  counts: boolean;
  out: string | null;
  txt: string | null;
  sendBaseline: boolean;
  dryRun: boolean;
  confirm: string | null;
  /** Set when --aged is present: a number of days, or 32 when the flag has no value. */
  aged: number | null;
};

export function parseAlertArgs(argv: readonly string[]): AlertArgs {
  const value = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  const agedFlag = argv.includes("--aged");
  const agedRaw = value("aged");
  const aged = agedFlag ? (agedRaw != null && /^\d+$/.test(agedRaw) ? Number(agedRaw) : 32) : null;
  return {
    send: argv.includes("--send"),
    test: argv.includes("--test"),
    testSend: argv.includes("--test-send"),
    counts: argv.includes("--counts"),
    out: value("out"),
    txt: value("txt"),
    sendBaseline: argv.includes("--send-baseline"),
    dryRun: argv.includes("--dry-run"),
    confirm: value("confirm"),
    aged,
  };
}

/**
 * Calendar-day age of a request in AST, from the posted (or last-seen) time to `now`.
 * Null when the time is unreadable. A request posted today is 0.
 */
export function requestAgeDays(iso: string, now: Date): number | null {
  const posted = dayKeyAst(iso);
  const today = dayKeyAst(now);
  if (!posted || !today) return null;
  const [py, pm, pd] = posted.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(py, pm - 1, pd)) / 86_400_000);
}

export function isAgedLead(ageDays: number | null, o: { oneShot?: boolean } = {}): boolean {
  if (ageDays == null) return false;
  if (ageDays > AGED_LEAD_DAYS) return true;
  return Boolean(o.oneShot) && ageDays > 0;
}

/** The heads-up line for an older (or one-shot held) request. */
export function agedLeadLine(days: number, o: { oneShot?: boolean } = {}): string {
  if (o.oneShot && days <= 0) {
    return "Heads up: this request came in today. It was held for review, but it's still worth a quick call to see if they're still looking.";
  }
  const unit = days === 1 ? "day" : "days";
  return `Heads up: this request is from ${days} ${unit} ago, so it's an older lead, but still worth a quick call to see if they're still looking.`;
}

const postedOf = (r: LeadInput): string => r.ask.postedAt ?? r.ask.lastSeenAt;

/** The subject price: "TT$2.5M" or "TT$8,000/mo". Null when no price is listed. */
export function alertPriceText(l: LeadInput["listing"], listingType: "sale" | "rent"): string | null {
  if (!l.price) return null;
  const sym = isUsd(l.currency) ? "US$" : "TT$";
  const abs = Math.abs(l.price);
  const figure = abs >= 1_000_000 ? `${sym}${String(Math.round((l.price / 1_000_000) * 100) / 100)}M` : `${sym}${Math.round(l.price).toLocaleString("en-US")}`;
  return listingType === "rent" ? `${figure}/mo` : figure;
}

/**
 * "1on1 Auto-Match Alert: townhouse · 3 bed · Maraval · TT$3.7M". Unknown parts are left out. A [TEST] prefix is optional.
 * When the detail parts would be empty, the short listing title is used so the subject is never a bare product name.
 */
export function alertSubject(r: LeadInput, o: { test?: boolean; used?: Set<string>; aged?: boolean } = {}): string {
  const type = (r.listing.type ?? r.ask.type ?? "").trim();
  const beds = r.listing.beds ?? r.ask.beds;
  const area = (r.listing.area ?? r.ask.area ?? "").trim();
  const price = alertPriceText(r.listing, r.ask.listingType);
  const parts = [o.aged ? "older lead" : "", type, beds != null ? `${beds} bed` : "", area, price ?? ""].filter((p) => p !== "");
  if (!parts.length) parts.push(shortListingTitle(r.listing));
  let core = `${ALERT_NAME}: ${parts.join(" · ")}`;
  const used = o.used;
  if (used) {
    if (used.has(core)) core = `${ALERT_NAME}: ${[...parts, shortListingTitle(r.listing)].filter(Boolean).join(" · ")}`;
    let unique = core;
    let n = 2;
    while (used.has(unique)) {
      unique = `${core} · ${n}`;
      n += 1;
    }
    used.add(unique);
    core = unique;
  }
  return o.test ? `[TEST] ${core}` : core;
}

function fromLine(fromName: string, fromEmail: string | null): string {
  return fromEmail ? `${fromName} <${fromEmail}>` : fromName;
}

/** "Hi Dana," or "Hi," (the office, or no usable first name). */
function helloOf(toName: string): string {
  const first = firstNameOf(toName === OFFICE_NAME ? null : toName);
  return first ? `Hi ${first},` : "Hi,";
}

/** The opening paragraph: the posted day and time in AST when both are readable, else the same sentence without them. */
export function openingLine(postedIso: string): string {
  const day = longDateAst(postedIso);
  const time = timeAst12(postedIso);
  const when = day && time ? ` on ${day} at ${time}` : "";
  return `Based on a message received on WhatsApp${when}, we believe this property that you are holding is a strong match. Please see the message below.`;
}

/** The sender's display name, or null when it is missing or has no letters (a phone number is not a name). */
export function visibleName(name: string | null | undefined): string | null {
  const n = (name ?? "").trim();
  return /\p{L}/u.test(n) ? n : null;
}

const NUM_WORD = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The plain-words reasons a listing fits the ask, from the parsed fields and the score's reason: the area (same, or nearby with the
 * drive or neighbour wording from the reason), the beds (the same, or one off), and the price against the budget in TT$ (a USD side
 * uses the fixed rate, or the CRM's TT$ equivalent for a USD listing). Pure.
 */
export function fitClauses(r: LeadInput): string[] {
  const a = r.ask;
  const l = r.listing;
  const out: string[] = [];
  const askArea = (a.area ?? "").trim().toLowerCase();
  const listingArea = (l.area ?? "").trim();
  if (askArea && listingArea) {
    if (listingArea.toLowerCase() === askArea) out.push(`it's in ${listingArea}, the area they asked for`);
    else if (/near|drive|neighbou?r/i.test(r.reason)) {
      const drive = r.reason.match(/~?\d+ min drive/i)?.[0];
      out.push(`it's nearby in ${listingArea}${drive ? `, ${drive} from the area they asked for` : ", next to the area they asked for"}`);
    }
  }
  if (a.beds != null && l.beds != null) {
    if (l.beds === a.beds) out.push(`it has the ${NUM_WORD(a.beds, "bedroom")} they asked for`);
    else if (Math.abs(l.beds - a.beds) === 1) out.push(`it has ${NUM_WORD(l.beds, "bedroom")}, one ${l.beds > a.beds ? "more" : "fewer"} than the ${a.beds} they asked for`);
  }
  if (a.budget != null && l.price) {
    const rent = a.listingType === "rent" ? " a month" : "";
    const budget = ttdValue(a.budget, a.currency);
    const price = isUsd(l.currency) ? (l.ttdEquiv || ttdValue(l.price, l.currency)) : l.price;
    const delta = budget - price;
    if (Math.abs(delta) < 1) out.push("it's right at their budget");
    else out.push(`it's ${shortMoney(Math.abs(delta), "TTD")}${rent} ${delta > 0 ? "under" : "over"} their budget`);
  }
  return out;
}

/** The recommendation: one sentence, "This is a strong fit: …", built from fitClauses. Pure. */
export function matchFitText(r: LeadInput): string {
  const lead = bandOf(r.score) === "strong" ? "This is a strong fit" : "This could be a fit";
  const clauses = fitClauses(r);
  return clauses.length ? `${lead}: ${clauses.join("; ")}.` : `${lead}.`;
}

/** Words that name an extra need the score does not check (pets, office, parking, furnished, pool, garden, and similar). */
const EXTRA_NEEDS = /\b(pets?|dogs?|cats?|office|study|work from home|wfh|parking|car ?park|garage|carport|furnished|unfurnished|pool|garden|yard|gym|balcony|generator|solar|backup|storage|security|gated|fenced)\b/i;

/**
 * The generic caveat when the contact's own words name an extra need, else null. It never names the extra: the message quote shows
 * what they asked for. Pure.
 */
export function extraNeedsCaveat(originalText: string | null | undefined): string | null {
  const text = (originalText ?? "").trim();
  return text && EXTRA_NEEDS.test(text) ? "Check the ask's extra needs before you call." : null;
}


const sameAddress = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function recipient(r: AlertInput, office: string): { to: string; toName: string } {
  if (r.listing.agentId == null) return { to: office, toName: OFFICE_NAME };
  const email = (r.agentEmail ?? "").trim();
  return { to: email || office, toName: r.listing.agentName ?? "Agent" };
}

/** For the one-shot: only email a holding agent, never fall back to the office. */
export function oneShotAgentStatus(r: AlertInput): "ok" | "no assigned agent" | "no agent email" {
  if (r.listing.agentId == null) return "no assigned agent";
  if (!(r.agentEmail ?? "").trim()) return "no agent email";
  return "ok";
}

export function buildAutoMatchAlert(r: AlertInput, o: AlertBuildOpts & { usedSubjects?: Set<string> }): AutoMatchAlert {
  const message = leadMessage(r);
  const requestId = r.ask.postId as string;
  const phoneText = phoneLabel(r.ask.senderPhone);
  const tel = telHref(r.ask.senderPhone);
  const waUrl = waUrlFor(r.ask.senderPhone, message);
  const deskUrl = `${o.baseUrl}/realty/desk#${leadCardId(requestId, r.listingKey)}`;
  const posted = postedOf(r);
  const ageDays = requestAgeDays(posted, o.now);
  const aged = isAgedLead(ageDays, { oneShot: o.oneShot });
  const fromName = o.fromName ?? ALERT_NAME;
  const fromEmail = o.fromEmail ?? null;
  const { to, toName } = recipient(r, o.officeEmail ?? OFFICE_TO);
  const isOffice = sameAddress(to, o.officeEmail ?? OFFICE_TO) || sameAddress(to, OFFICE_TO);
  const subject = alertSubject(r, { test: o.test, used: o.usedSubjects, aged });
  const listingTitle = shortListingTitle(r.listing);
  const cc = [...(o.cc ?? parseAddressList(ALERT_CC_DEFAULT))];
  const bcc = [...(o.bcc ?? parseAddressList(ALERT_BCC_DEFAULT))];
  const agedLine = (aged || o.oneShot) && ageDays != null ? agedLeadLine(ageDays, { oneShot: o.oneShot }) : null;
  const view: RenderView = {
    hello: helloOf(toName),
    opening: openingLine(posted),
    agedLine,
    senderName: visibleName(r.ask.senderName),
    phoneText,
    tel,
    received: shortDateTimeAst(posted),
    originalText: (r.ask.originalText ?? "").trim(),
    listing: { title: listingTitle, price: listingPriceText(r.listing, r.ask.listingType) },
    usd: isUsd(r.ask.currency),
    fit: matchFitText(r),
    caveat: extraNeedsCaveat(r.ask.originalText),
    publicUrl: publicListingUrl(r.listing.url),
    message,
    waUrl,
    footer: alertFooter(isOffice),
  };
  return {
    to,
    toName,
    fromName,
    fromEmail,
    from: fromLine(fromName, fromEmail),
    cc,
    bcc,
    subject,
    text: renderText(view),
    html: renderHtml(view),
    requestId,
    listingKey: r.listingKey,
    phoneText,
    tel,
    waUrl,
    deskUrl,
    message,
    ageDays,
    listingTitle,
    score: r.score,
  };
}

/** One alert per strong, not-yet-actioned match (the same rows as the admin digest), then the allowlist if one was given. */
export function buildAutoMatchAlerts(rows: readonly AlertInput[], o: AlertBuildOpts & { allowlist?: readonly string[] }): AutoMatchAlert[] {
  const usedSubjects = new Set<string>();
  const alerts = digestRows(rows, o.statuses).map((r) => buildAutoMatchAlert(r as AlertInput, { ...o, usedSubjects }));
  const allowlist = o.allowlist ?? [];
  return allowlist.length ? alerts.filter((a) => allowedRecipient(a.to, allowlist)) : alerts;
}

type RenderView = {
  hello: string;
  opening: string;
  agedLine: string | null;
  senderName: string | null;
  phoneText: string | null;
  tel: string | null;
  /** The posted time, e.g. "Tue 10 Nov, 5:30 PM AST", or "" when unreadable. */
  received: string;
  /** The contact's message, trimmed; "" when none is on file. */
  originalText: string;
  listing: { title: string; price: string | null };
  usd: boolean;
  fit: string;
  caveat: string | null;
  /** The public 1on1realtors.com listing link, or null. */
  publicUrl: string | null;
  /** The suggested reply (leadMessage), with the public link inside it when there is one. */
  message: string;
  waUrl: string | null;
  footer: string;
};

const quoteText = (s: string): string => `“${s}”`;

/** The suggested reply split around its public link, so the link can sit on a line of its own. Null when there is no link to split on. */
function replyParts(message: string, url: string | null): { before: string; after: string } | null {
  if (!url) return null;
  const at = message.indexOf(url);
  if (at < 0) return null;
  return {
    before: message.slice(0, at).replace(/[:\s]+$/, ":").trim(),
    after: message.slice(at + url.length).replace(/^[.\s]+/, "").trim(),
  };
}

function renderText(v: RenderView): string {
  const out: string[] = [v.hello, "", v.opening, ""];
  if (v.agedLine) out.push(v.agedLine, "");
  out.push("Contact");
  if (v.senderName) out.push(`Name: ${v.senderName}`);
  if (v.phoneText) out.push(`Phone: ${v.phoneText}`);
  if (v.waUrl) out.push(WA_LABEL, v.waUrl);
  else out.push(NO_WA);
  if (v.received) out.push(`Received: ${v.received}`);
  out.push("Their WhatsApp message:", v.originalText ? quoteText(v.originalText) : NO_MESSAGE_TEXT, "");
  out.push("The match", `${v.listing.title} · ${v.listing.price ?? NO_PRICE}`);
  if (v.usd) out.push(`Note: ${NOTE_USD}`);
  out.push(v.fit);
  if (v.caveat) out.push(v.caveat);
  if (v.publicUrl) out.push("View the property:", v.publicUrl);
  else out.push(`View the property: ${NO_LINK}.`);
  out.push("", "Suggested reply (optional)");
  const parts = replyParts(v.message, v.publicUrl);
  if (parts && v.publicUrl) out.push(parts.before, v.publicUrl, parts.after);
  else out.push(v.message);
  if (v.phoneText && v.tel) out.push(`Call: ${v.phoneText} (${v.tel})`);
  out.push("", v.footer, "");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderHtml(v: RenderView): string {
  const e = escapeHtml;
  const br = (s: string): string => e(s).split("\n").join("<br>");
  const parts = replyParts(v.message, v.publicUrl);
  const reply =
    parts && v.publicUrl
      ? `<p>${e(parts.before)} <a href="${e(v.publicUrl)}">here</a><br>${e(parts.after)}</p>`
      : `<p>${e(v.message)}</p>`;
  return [
    "<!doctype html>",
    "<html><body>",
    `<p>${e(v.hello)}</p>`,
    `<p>${e(v.opening)}</p>`,
    v.agedLine ? `<p>${e(v.agedLine)}</p>` : "",
    "<h3>Contact</h3>",
    v.senderName ? `<p>Name: ${e(v.senderName)}</p>` : "",
    v.phoneText && v.tel ? `<p>Phone: <a href="${e(v.tel)}">${e(v.phoneText)}</a></p>` : "",
    v.waUrl ? `<p>${e(WA_LABEL)} <a href="${e(v.waUrl)}">here</a></p>` : `<p>${e(NO_WA)}</p>`,
    v.received ? `<p>Received: ${e(v.received)}</p>` : "",
    "<p>Their WhatsApp message:</p>",
    `<p>${v.originalText ? br(quoteText(v.originalText)) : e(NO_MESSAGE_TEXT)}</p>`,
    "<h3>The match</h3>",
    `<p><strong>${e(v.listing.title)}</strong> · ${e(v.listing.price ?? NO_PRICE)}</p>`,
    v.usd ? `<p>${e(`Note: ${NOTE_USD}`)}</p>` : "",
    `<p>${e(v.fit)}</p>`,
    v.caveat ? `<p>${e(v.caveat)}</p>` : "",
    v.publicUrl
      ? `<p>View the property: <a href="${e(v.publicUrl)}">here</a></p>`
      : `<p>${e(`View the property: ${NO_LINK}.`)}</p>`,
    "<h3>Suggested reply (optional)</h3>",
    reply,
    v.phoneText && v.tel ? `<p>Call: <a href="${e(v.tel)}">${e(v.phoneText)}</a> (${e(v.tel)})</p>` : "",
    `<p>${e(v.footer)}</p>`,
    "</body></html>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The words of an HTML body as plain text, so a test can check they match the text body. */
export function alertTextFromHtml(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>|<\/(?:p|li|h3|ul)>/gi, "\n");
  return withBreaks
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, name: string) => {
      if (name[0] === "#") return String.fromCodePoint(name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10));
      return HTML_ENTITIES[name.toLowerCase()] ?? `&${name};`;
    })
    .replace(/\n{2,}/g, "\n");
}


export type AlertSentKind = "sent" | "suppressed";

/** A persisted key so each match is emailed at most once (realty store: automatch-alert-sent.jsonl). */
export type AlertSentRow = { requestId: string; listingKey: string; at: string; kind: AlertSentKind };

export const alertKey = (r: { requestId: string; listingKey: string }): string => `${r.requestId}|${r.listingKey}`;

export type AlertPlan = {
  /** Would be emailed, then recorded as sent. */
  send: AutoMatchAlert[];
  /** Record as suppressed and do not email (the baseline when the flag is off, or the first on-tick with an empty store). */
  suppress: AutoMatchAlert[];
  /** Already recorded (sent or suppressed). */
  skip: AutoMatchAlert[];
};

/**
 * What to do with today's strong alerts, given the keys already persisted.
 * While disabled, unrecorded matches are suppressed so flipping the flag on later does not bulk-send the backlog.
 * When enabled, unrecorded matches are sent only if the store already has rows (they are new since the baseline);
 * a first enabled run with an empty store still suppresses the current set, unless sendExisting is on.
 * sendExisting (explicit) emails every match that has not already been sent, including previously suppressed ones.
 */
export function planAlertDispatch(
  alerts: readonly AutoMatchAlert[],
  sent: readonly AlertSentRow[],
  o: { enabled: boolean; sendExisting: boolean; holdKeys?: ReadonlySet<string> },
): AlertPlan {
  const byKey = new Map(sent.map((r) => [alertKey(r), r]));
  const hold = o.holdKeys ?? new Set<string>();
  const send: AutoMatchAlert[] = [];
  const suppress: AutoMatchAlert[] = [];
  const skip: AutoMatchAlert[] = [];
  const hasBaseline = sent.length > 0;
  for (const a of alerts) {
    const prev = byKey.get(alertKey(a));
    if (prev?.kind === "sent") {
      skip.push(a);
      continue;
    }
    if (o.sendExisting && o.enabled) {
      if (prev?.kind === "suppressed") send.push(a);
      else if (!prev) send.push(a);
      else skip.push(a);
      continue;
    }
    if (prev) {
      skip.push(a);
      continue;
    }
    // First-review / held keys stay suppressed so the live poller does not email them before the one-shot.
    if (hold.has(alertKey(a))) {
      suppress.push(a);
      continue;
    }
    if (o.enabled && hasBaseline) send.push(a);
    else suppress.push(a);
  }
  return { send, suppress, skip };
}

/**
 * The one-shot send: previously suppressed baseline matches, plus first-review matches (by key),
 * de-duplicated, excluding already-sent keys. New unrecorded matches that are not in either set
 * are left alone, so live alerts for genuinely new matches stay unchanged.
 */
export function planOneShotSend(
  alerts: readonly AutoMatchAlert[],
  sent: readonly AlertSentRow[],
  o: { reviewKeys?: ReadonlySet<string> } = {},
): AutoMatchAlert[] {
  const byKey = new Map(sent.map((r) => [alertKey(r), r]));
  const review = o.reviewKeys ?? new Set<string>();
  const out: AutoMatchAlert[] = [];
  const seen = new Set<string>();
  for (const a of alerts) {
    const key = alertKey(a);
    if (seen.has(key)) continue;
    const prev = byKey.get(key);
    if (prev?.kind === "sent") continue;
    if (prev?.kind === "suppressed" || review.has(key)) {
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

/** @deprecated Use planOneShotSend. Kept as the suppressed-only subset. */
export function planBaselineSend(alerts: readonly AutoMatchAlert[], sent: readonly AlertSentRow[]): AutoMatchAlert[] {
  return planOneShotSend(alerts, sent);
}

/** What a flag flip would do right now, with sendExisting off: how many would go immediately vs only later new ones. */
export function flipReport(alerts: readonly AutoMatchAlert[], sent: readonly AlertSentRow[], holdKeys?: ReadonlySet<string>): { existing: number; wouldSendImmediately: number; wouldSuppress: number; alreadyRecorded: number } {
  const off = planAlertDispatch(alerts, sent, { enabled: false, sendExisting: false, holdKeys });
  const on = planAlertDispatch(alerts, [...sent, ...off.suppress.map((a) => ({ requestId: a.requestId, listingKey: a.listingKey, at: "", kind: "suppressed" as const }))], { enabled: true, sendExisting: false, holdKeys });
  return { existing: alerts.length, wouldSendImmediately: on.send.length, wouldSuppress: off.suppress.length, alreadyRecorded: off.skip.length };
}

/** Build options from the environment. Pure: env and now come in. */
export function alertOptsFromEnv(env: Env, now: Date, extra: { statuses: readonly StatusRow[]; test?: boolean } ): AlertBuildOpts {
  const attr = alertAttribution(env);
  return {
    statuses: extra.statuses,
    baseUrl: publicBaseUrl(env),
    now,
    test: extra.test,
    fromName: attr.fromName,
    fromEmail: alertFromAddress(env),
    asMiles: attr.asMiles,
    officeEmail: officeEmail(env),
    cc: alertCc(env),
    bcc: alertBcc(env),
    allowlist: alertAllowlist(env),
  };
}


/**
 * A one-off test alert: fake details, subject prefixed with [TEST], To TEST_ALERT_TO only, and no CC or BCC.
 * Used by the owners' test-send action and the CLI, and it works while live sending is off.
 */
export function buildTestAutoMatchAlert(now: Date, o: { baseUrl?: string; fromName?: string; fromEmail?: string | null; agedDays?: number } = {}): AutoMatchAlert {
  const posted = new Date(now.getTime() - (o.agedDays != null ? o.agedDays * 86_400_000 : 60 * 60 * 1000)).toISOString();
  const row: AlertInput = {
    score: 90,
    reason: "Test alert: invented people and a 555 number only",
    listingKey: "url:https://1on1realtors.com/property/sample-townhouse",
    ask: {
      postId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      area: "Maraval",
      beds: 3,
      budget: 2_500_000,
      currency: "TTD",
      type: "townhouse",
      listingType: "sale",
      lastSeenAt: posted,
      postedAt: posted,
      senderName: "Alex Tester",
      firm: "Example Realty Co",
      senderPhone: "+18685550100",
      originalText: "Need a 3 bed townhouse in Maraval, budget 2.5m, parking please.",
    },
    listing: {
      title: "Sample Townhouse, Maraval",
      url: "https://1on1realtors.com/property/sample-townhouse",
      price: 2_500_000,
      currency: "TTD",
      ttdEquiv: null,
      agentId: 7,
      agentName: "Dana Holder",
      area: "Maraval",
      beds: 3,
      type: "townhouse",
    },
    agentEmail: TEST_ALERT_TO,
  };
  return buildAutoMatchAlert(row, {
    statuses: [],
    baseUrl: o.baseUrl ?? publicBaseUrl({}),
    now,
    test: true,
    fromName: o.fromName ?? ALERT_NAME,
    fromEmail: o.fromEmail ?? ALERT_FROM_ADDRESS_DEFAULT,
    officeEmail: OFFICE_TO,
    cc: [],
    bcc: [],
  });
}

export { publicBaseUrl, DEFAULT_PUBLIC_URL, escapeHtml };
