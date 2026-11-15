import { digestRows, escapeHtml, publicBaseUrl, DEFAULT_PUBLIC_URL } from "./admin-digest.ts";
import { mentionedOnWhatsApp } from "./ast-time.ts";
import { askLine, firstNameOf, leadCardId, leadMessage, listingPriceText, waUrlFor, type LeadInput } from "./automatch-leads.ts";
import type { Env } from "./env.ts";
import { isUsd } from "./fx.ts";
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
 * names Miles. Each alert is CC'd to AUTOMATCH_ALERT_CC (default Crystal and Wendy) and BCC'd to AUTOMATCH_ALERT_BCC
 * (default Miles). The BCC list is for the transport only: it must not appear in the From, To, Cc, Subject, or body
 * that agents see.
 *
 * Per alert: a soft mention of when a contact brought the property up on WhatsApp (relative day and the time in AST — never
 * the group name or the original message text), the listing, the suggested message, the contact's tap-to-call number next
 * to the wa.me link (omitted when there is no usable number), the "hot or live match" line, and a line asking the recipient
 * to reply so admin can record how it went. The body never links to the Desk or to bop.1on1realtors.com.
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

/** Comma-separated CC list. Unset uses ALERT_CC_DEFAULT (Crystal and Wendy). */
export const ALERT_CC_FLAG = "AUTOMATCH_ALERT_CC";

export const ALERT_CC_DEFAULT = "admin@1on1realtors.com,wendy@1on1realtors.com";

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

export const WA_LABEL = "WhatsApp, with the message filled in (opens in your own browser):";
export const NO_WA = "No usable WhatsApp number on this ask, so there's no link.";
export const REPLY_LINE = "Reply to this email to let admin know how it went.";
const NO_PRICE = "no price listed";
const NO_LINK = "no link on file";
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
  mentioned: string;
  message: string;
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

function listOrDefault(env: Env, flag: string, fallback: string): string[] {
  return Object.prototype.hasOwnProperty.call(env, flag) && (env[flag] ?? "").trim() !== ""
    ? parseAddressList(env[flag])
    : parseAddressList(fallback);
}

/** CC addresses: AUTOMATCH_ALERT_CC, or the default (Crystal and Wendy) when unset. */
export function alertCc(env: Env = {}): string[] {
  return listOrDefault(env, ALERT_CC_FLAG, ALERT_CC_DEFAULT);
}

/** BCC addresses: AUTOMATCH_ALERT_BCC, or Miles when unset. Never shown in the agent-facing message. */
export function alertBcc(env: Env = {}): string[] {
  return listOrDefault(env, ALERT_BCC_FLAG, ALERT_BCC_DEFAULT);
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

/** The command-line flags: --out, --txt, --test, --send. Pure: the argv comes in. */
export function parseAlertArgs(argv: readonly string[]): { send: boolean; test: boolean; testSend: boolean; counts: boolean; out: string | null; txt: string | null } {
  const value = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  return { send: argv.includes("--send"), test: argv.includes("--test"), testSend: argv.includes("--test-send"), counts: argv.includes("--counts"), out: value("out"), txt: value("txt") };
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
export function alertSubject(r: LeadInput, o: { test?: boolean; used?: Set<string> } = {}): string {
  const type = (r.listing.type ?? r.ask.type ?? "").trim();
  const beds = r.listing.beds ?? r.ask.beds;
  const area = (r.listing.area ?? r.ask.area ?? "").trim();
  const price = alertPriceText(r.listing, r.ask.listingType);
  const parts = [type, beds != null ? `${beds} bed` : "", area, price ?? ""].filter((p) => p !== "");
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

function introOf(toName: string): { hello: string; body: string } {
  const first = firstNameOf(toName === OFFICE_NAME ? null : toName);
  const hello = first ? `Hi ${first},` : "Hi,";
  return { hello, body: "Here is a strong match for a listing you hold." };
}

function recipient(r: AlertInput, office: string): { to: string; toName: string } {
  if (r.listing.agentId == null) return { to: office, toName: OFFICE_NAME };
  const email = (r.agentEmail ?? "").trim();
  return { to: email || office, toName: r.listing.agentName ?? "Agent" };
}

export function buildAutoMatchAlert(r: AlertInput, o: AlertBuildOpts & { usedSubjects?: Set<string> }): AutoMatchAlert {
  const message = leadMessage(r);
  const requestId = r.ask.postId as string;
  const phoneText = phoneLabel(r.ask.senderPhone);
  const tel = telHref(r.ask.senderPhone);
  const waUrl = waUrlFor(r.ask.senderPhone, message);
  const deskUrl = `${o.baseUrl}/realty/desk#${leadCardId(requestId, r.listingKey)}`;
  const mentioned = mentionedOnWhatsApp(postedOf(r), o.now);
  const fromName = o.fromName ?? ALERT_NAME;
  const fromEmail = o.fromEmail ?? null;
  const { to, toName } = recipient(r, o.officeEmail ?? OFFICE_TO);
  const subject = alertSubject(r, { test: o.test, used: o.usedSubjects });
  const listing = { title: shortListingTitle(r.listing), price: listingPriceText(r.listing, r.ask.listingType), url: r.listing.url };
  const ask = askLine(r.ask);
  const usd = isUsd(r.ask.currency);
  const cc = [...(o.cc ?? parseAddressList(ALERT_CC_DEFAULT))];
  const bcc = [...(o.bcc ?? parseAddressList(ALERT_BCC_DEFAULT))];
  const view = { toName, mentioned, listing, ask, usd, score: r.score, message, phoneText, tel, waUrl };
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
    mentioned,
    message,
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
  toName: string;
  mentioned: string;
  listing: { title: string; price: string | null; url: string | null };
  ask: string;
  usd: boolean;
  score: number;
  message: string;
  phoneText: string | null;
  tel: string | null;
  waUrl: string | null;
};

function renderText(v: RenderView): string {
  const { hello, body } = introOf(v.toName);
  const out: string[] = [hello, "", body, ""];
  if (v.mentioned) out.push(v.mentioned, "");
  out.push(v.listing.title, "");
  out.push(`Price: ${v.listing.price ?? NO_PRICE}`);
  out.push(`Ask: ${v.ask}`);
  if (v.usd) out.push(`Note: ${NOTE_USD}`);
  out.push(`Listing: ${v.listing.url ?? NO_LINK}`);
  out.push(`Score: ${v.score}`);
  out.push("");
  out.push("Suggested message:");
  out.push(v.message);
  out.push("");
  if (v.phoneText && v.tel) out.push(`Call: ${v.phoneText} (${v.tel})`);
  out.push(v.waUrl ? `${WA_LABEL} ${v.waUrl}` : NO_WA);
  out.push("");
  out.push(HOT_MATCH_LINE);
  out.push("");
  out.push(REPLY_LINE);
  out.push("");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderHtml(v: RenderView): string {
  const e = escapeHtml;
  const { hello, body } = introOf(v.toName);
  const items = [
    `<li><strong>Price:</strong> ${e(v.listing.price ?? NO_PRICE)}</li>`,
    `<li><strong>Ask:</strong> ${e(v.ask)}</li>`,
    v.usd ? `<li><strong>Note:</strong> ${e(NOTE_USD)}</li>` : "",
    `<li><strong>Listing:</strong> ${v.listing.url ? `<a href="${e(v.listing.url)}">${e(v.listing.url)}</a>` : e(NO_LINK)}</li>`,
    `<li><strong>Score:</strong> ${v.score}</li>`,
  ].join("");
  const call =
    v.phoneText && v.tel
      ? `<p>Call: <a href="${e(v.tel)}">${e(v.phoneText)}</a> (${e(v.tel)})</p>`
      : "";
  const wa = v.waUrl ? `<p>${e(WA_LABEL)} <a href="${e(v.waUrl)}">${e(v.waUrl)}</a></p>` : `<p>${e(NO_WA)}</p>`;
  return [
    "<!doctype html>",
    "<html><body>",
    `<p>${e(hello)}</p>`,
    `<p>${e(body)}</p>`,
    v.mentioned ? `<p>${e(v.mentioned)}</p>` : "",
    `<p><strong>${e(v.listing.title)}</strong></p>`,
    `<ul>${items}</ul>`,
    `<p><strong>Suggested message:</strong><br>${e(v.message)}</p>`,
    call,
    wa,
    `<p>${e(HOT_MATCH_LINE)}</p>`,
    `<p>${e(REPLY_LINE)}</p>`,
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
  o: { enabled: boolean; sendExisting: boolean },
): AlertPlan {
  const byKey = new Map(sent.map((r) => [alertKey(r), r]));
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
    if (o.enabled && hasBaseline) send.push(a);
    else suppress.push(a);
  }
  return { send, suppress, skip };
}

/** What a flag flip would do right now, with sendExisting off: how many would go immediately vs only later new ones. */
export function flipReport(alerts: readonly AutoMatchAlert[], sent: readonly AlertSentRow[]): { existing: number; wouldSendImmediately: number; wouldSuppress: number; alreadyRecorded: number } {
  const off = planAlertDispatch(alerts, sent, { enabled: false, sendExisting: false });
  const on = planAlertDispatch(alerts, [...sent, ...off.suppress.map((a) => ({ requestId: a.requestId, listingKey: a.listingKey, at: "", kind: "suppressed" as const }))], { enabled: true, sendExisting: false });
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
export function buildTestAutoMatchAlert(now: Date, o: { baseUrl?: string; fromName?: string; fromEmail?: string | null } = {}): AutoMatchAlert {
  const posted = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
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
