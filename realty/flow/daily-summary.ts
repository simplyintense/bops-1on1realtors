import { escapeHtml } from "./admin-digest.ts";
import { clockHmAst, dayKeyAst, longDateAst, shortDateTimeAst, timeAst12 } from "./ast-time.ts";
import {
  ALERT_FROM_ADDRESS_DEFAULT,
  ALERT_NAME,
  OFFICE_NAME,
  OFFICE_TO,
  TEST_ALERT_TO,
  alertFromHeader,
  alertReplyTo,
  flagOn,
  matchFitText,
  parseAddressList,
  type AlertInput,
  type AlertSentRow,
} from "./automatch-alert.ts";
import { listingPriceText, publicListingUrl } from "./automatch-leads.ts";
import type { Env } from "./env.ts";
import { phoneLabel } from "./listing-contact.ts";
import { shortListingTitle } from "./listing-title.ts";

/**
 * The daily Auto-Match summary: one email covering the previous 24 hours of alerts that were actually sent, for Wendy and
 * admin (Chrystalle), with Miles on BCC. This module is the builder and the schedule check only: it never sends. The body
 * never names Periskope, Fly, Supabase, "Bops", or a WhatsApp group, and it never links to bop.1on1realtors.com.
 *
 * Portable: no node:*, no next, no bare process.
 */

/** Live morning send. Off unless the value is "1" or "true". Deploy with this unset. */
export const SUMMARY_ENABLED_FLAG = "DAILY_SUMMARY_ENABLED";

/** Morning send time in AST, 24-hour "HH:MM". Default SUMMARY_AT_DEFAULT. */
export const SUMMARY_AT_FLAG = "DAILY_SUMMARY_AT";

export const SUMMARY_AT_DEFAULT = "07:00";

/** Comma-separated To list. Unset uses Wendy and admin. */
export const SUMMARY_TO_FLAG = "DAILY_SUMMARY_TO";

export const SUMMARY_TO_DEFAULT = "wendy@1on1realtors.com,admin@1on1realtors.com";

/** Comma-separated BCC list. Unset uses Miles. Not shown in the To/Cc/subject/body. */
export const SUMMARY_BCC_FLAG = "DAILY_SUMMARY_BCC";

export const SUMMARY_BCC_DEFAULT = "miles@simplyintense.com";

export const SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const EMPTY_LINE = "No Auto-Match alerts were sent in the last 24 hours.";

const NO_PRICE = "no price listed";

export type SummarySource = {
  requestId: string;
  listingKey: string;
  to: string;
  toName: string;
  score: number;
  fit: string;
  contactName: string;
  phoneText: string | null;
  listingTitle: string;
  listingArea: string | null;
  listingPrice: string | null;
  publicUrl: string | null;
  excerpt: string;
};

export type SummaryItem = SummarySource & { sentAt: string };

export type DailySummary = {
  to: string[];
  cc: string[];
  bcc: string[];
  from: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  alerts: number;
  agents: number;
  items: SummaryItem[];
  windowStart: string;
  windowEnd: string;
};

export type SummaryBuildOpts = {
  now: Date;
  test?: boolean;
  from?: string;
  to?: readonly string[];
  bcc?: readonly string[];
  replyTo?: string;
};

export type SummaryGroup = { agent: string; to: string; items: SummaryItem[] };

/** Unset/false until DAILY_SUMMARY_ENABLED is "1" or "true". */
export function dailySummaryEnabled(env: Env = {}): boolean {
  return flagOn(env[SUMMARY_ENABLED_FLAG]);
}

/** A 24-hour "HH:MM" send time in AST, or the 07:00 default when the value is missing or unreadable. */
export function dailySummaryAt(env: Env = {}): string {
  return parseSummaryAt(env[SUMMARY_AT_FLAG]);
}

export function parseSummaryAt(raw: string | null | undefined): string {
  const t = (raw ?? "").trim();
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return SUMMARY_AT_DEFAULT;
  const h = Number(m[1]);
  const min = Number(m[2] ?? "0");
  if (h > 23 || min > 59) return SUMMARY_AT_DEFAULT;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function listOrDefault(env: Env, flag: string, fallback: string): string[] {
  return Object.prototype.hasOwnProperty.call(env, flag) && (env[flag] ?? "").trim() !== ""
    ? parseAddressList(env[flag])
    : parseAddressList(fallback);
}

export function dailySummaryTo(env: Env = {}): string[] {
  return listOrDefault(env, SUMMARY_TO_FLAG, SUMMARY_TO_DEFAULT);
}

export function dailySummaryBcc(env: Env = {}): string[] {
  return listOrDefault(env, SUMMARY_BCC_FLAG, SUMMARY_BCC_DEFAULT);
}

/**
 * True when the morning send may go out: the flag is on, today's AST date has no recorded send, and the clock in AST is at
 * or after the configured time (default 07:00).
 */
export function dailySummaryDue(
  now: Date,
  o: { enabled: boolean; lastDay: string | null; at?: string },
): boolean {
  if (!o.enabled) return false;
  const today = dayKeyAst(now);
  const clock = clockHmAst(now);
  if (!today || !clock) return false;
  if (o.lastDay === today) return false;
  return clock >= (o.at ?? SUMMARY_AT_DEFAULT);
}

/** Sent-kind rows whose `at` falls in the 24 hours ending at `now`, oldest first. */
export function sentRowsInWindow(
  rows: readonly AlertSentRow[],
  now: Date,
  windowMs = SUMMARY_WINDOW_MS,
): AlertSentRow[] {
  const end = now.getTime();
  const start = end - windowMs;
  return rows
    .filter((r) => r.kind === "sent")
    .filter((r) => {
      const t = Date.parse(r.at);
      return Number.isFinite(t) && t >= start && t <= end;
    })
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.requestId.localeCompare(b.requestId));
}

/** A short request excerpt, whitespace collapsed. Pure. */
export function excerptOf(text: string | null | undefined, max = 240): string {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 80 ? cut.slice(0, sp) : cut).trim()}…`;
}

function visibleName(name: string | null | undefined): string {
  const t = (name ?? "").trim();
  return t || "Name not given";
}

function recipientOf(r: AlertInput, office: string): { to: string; toName: string } {
  if (r.listing.agentId == null) return { to: office, toName: OFFICE_NAME };
  const email = (r.agentEmail ?? "").trim();
  return { to: email || office, toName: r.listing.agentName ?? "Agent" };
}

/** One source row from an Automatch/alert input. Pure. */
export function summarySourceOf(r: AlertInput, office = OFFICE_TO): SummarySource | null {
  const requestId = (r.ask.postId ?? "").trim();
  if (!requestId) return null;
  const { to, toName } = recipientOf(r, office);
  return {
    requestId,
    listingKey: r.listingKey,
    to,
    toName,
    score: r.score,
    fit: matchFitText(r),
    contactName: visibleName(r.ask.senderName),
    phoneText: phoneLabel(r.ask.senderPhone),
    listingTitle: shortListingTitle(r.listing),
    listingArea: (r.listing.area ?? "").trim() || null,
    listingPrice: listingPriceText(r.listing, r.ask.listingType),
    publicUrl: publicListingUrl(r.listing.url),
    excerpt: excerptOf(r.ask.originalText),
  };
}

function fallbackItem(r: AlertSentRow): SummaryItem {
  const raw = r.listingKey.startsWith("url:") ? r.listingKey.slice(4) : "";
  const publicUrl = publicListingUrl(raw);
  return {
    requestId: r.requestId,
    listingKey: r.listingKey,
    to: "",
    toName: "Agent",
    score: 0,
    fit: "Match details were not on file when this update was prepared.",
    contactName: "Name not given",
    phoneText: null,
    listingTitle: "Listing",
    listingArea: null,
    listingPrice: null,
    publicUrl,
    excerpt: "",
    sentAt: r.at,
  };
}

/** Join sent rows in the window with current match data. Missing pairs still appear, with what is known. */
export function enrichSummaryItems(
  sent: readonly AlertSentRow[],
  sources: readonly SummarySource[],
  now: Date,
  windowMs = SUMMARY_WINDOW_MS,
): SummaryItem[] {
  const byKey = new Map(sources.map((s) => [`${s.requestId}|${s.listingKey}`, s]));
  return sentRowsInWindow(sent, now, windowMs).map((r) => {
    const src = byKey.get(`${r.requestId}|${r.listingKey}`);
    return src ? { ...src, sentAt: r.at } : fallbackItem(r);
  });
}

function agentKey(item: SummaryItem): string {
  return `${item.toName}\0${item.to}`;
}

/** Groups by agent, Office last, name then email; items stay in send order. */
export function groupSummaryItems(items: readonly SummaryItem[]): SummaryGroup[] {
  const order: string[] = [];
  const map = new Map<string, SummaryGroup>();
  for (const item of items) {
    const k = agentKey(item);
    let g = map.get(k);
    if (!g) {
      g = { agent: item.toName, to: item.to, items: [] };
      map.set(k, g);
      order.push(k);
    }
    g.items.push(item);
  }
  return order
    .map((k) => map.get(k)!)
    .sort((a, b) => {
      const ao = a.agent === OFFICE_NAME ? 1 : 0;
      const bo = b.agent === OFFICE_NAME ? 1 : 0;
      return ao - bo || a.agent.localeCompare(b.agent) || a.to.localeCompare(b.to);
    });
}

export function countWord(n: number, noun = "alert"): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function windowLabel(now: Date): { startIso: string; endIso: string; ending: string } {
  const start = new Date(now.getTime() - SUMMARY_WINDOW_MS);
  const ending = `${longDateAst(now.toISOString())} at ${timeAst12(now.toISOString())}`;
  return { startIso: start.toISOString(), endIso: now.toISOString(), ending };
}

function introLine(now: Date): string {
  const ending = `${longDateAst(now.toISOString())} at ${timeAst12(now.toISOString())}`;
  return `Here's what Auto-Match sent in the last 24 hours, ending ${ending}.`;
}

function totalsLine(alerts: number, agents: number): string {
  return `${countWord(alerts)} sent to ${countWord(agents, "agent")}.`;
}

function subjectOf(alerts: number, now: Date, test: boolean): string {
  const day = longDateAst(now.toISOString());
  const body = alerts ? `${day}: ${countWord(alerts)} sent` : `${day}: no alerts sent`;
  return `${test ? "[TEST] " : ""}1on1 Auto-Match daily update · ${body}`;
}

function listingLine(item: SummaryItem): string {
  const bits = [item.listingTitle];
  if (item.listingArea && !item.listingTitle.toLowerCase().includes(item.listingArea.toLowerCase())) bits.push(item.listingArea);
  bits.push(item.listingPrice ?? NO_PRICE);
  return bits.join(" · ");
}

function contactLine(item: SummaryItem): string {
  return item.phoneText ? `${item.contactName}, ${item.phoneText}` : item.contactName;
}

function scoreLine(item: SummaryItem): string {
  return item.score > 0 ? `${item.score}. ${item.fit}` : item.fit;
}

function groupHeading(g: SummaryGroup): string {
  const who = g.to ? `${g.agent} (${g.to})` : g.agent;
  return `${who}: ${countWord(g.items.length)}`;
}

function itemText(item: SummaryItem): string[] {
  const lines = [
    listingLine(item) + (item.publicUrl ? ` · here: ${item.publicUrl}` : ""),
    `Sent: ${shortDateTimeAst(item.sentAt) || "time not on file"}`,
    `Contact: ${contactLine(item)}`,
    `Score: ${scoreLine(item)}`,
  ];
  if (item.excerpt) lines.push(`Request: "${item.excerpt}"`);
  return lines;
}

function renderText(groups: readonly SummaryGroup[], alerts: number, agents: number, now: Date): string {
  const lines: string[] = [];
  if (!alerts) {
    lines.push(EMPTY_LINE);
    return `${lines.join("\n")}\n`;
  }
  lines.push(introLine(now), "", totalsLine(alerts, agents), "");
  for (const g of groups) {
    lines.push(groupHeading(g));
    for (const item of g.items) {
      lines.push("");
      lines.push(...itemText(item));
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function renderHtml(groups: readonly SummaryGroup[], alerts: number, agents: number, now: Date): string {
  const e = escapeHtml;
  const parts = ["<!doctype html>", "<html><body>"];
  if (!alerts) {
    parts.push(`<p>${e(EMPTY_LINE)}</p>`);
    parts.push("</body></html>");
    return parts.join("\n");
  }
  parts.push(`<p>${e(introLine(now))}</p>`);
  parts.push(`<p>${e(totalsLine(alerts, agents))}</p>`);
  for (const g of groups) {
    parts.push(`<h3>${e(groupHeading(g))}</h3>`);
    for (const item of g.items) {
      const listing = item.publicUrl
        ? `${e(listingLine(item))} · <a href="${e(item.publicUrl)}">here</a>`
        : e(listingLine(item));
      parts.push(`<p><strong>${listing}</strong></p>`);
      const rows = [
        `<li><strong>Sent:</strong> ${e(shortDateTimeAst(item.sentAt) || "time not on file")}</li>`,
        `<li><strong>Contact:</strong> ${e(contactLine(item))}</li>`,
        `<li><strong>Score:</strong> ${e(scoreLine(item))}</li>`,
      ];
      if (item.excerpt) rows.push(`<li><strong>Request:</strong> “${e(item.excerpt)}”</li>`);
      parts.push(`<ul>${rows.join("")}</ul>`);
    }
  }
  parts.push("</body></html>");
  return parts.join("\n");
}

/** Build the daily summary email from already-enriched items. Pure. */
export function buildDailySummary(items: readonly SummaryItem[], o: SummaryBuildOpts): DailySummary {
  const groups = groupSummaryItems(items);
  const alerts = items.length;
  const agents = groups.length;
  const win = windowLabel(o.now);
  const to = [...(o.to ?? parseAddressList(SUMMARY_TO_DEFAULT))];
  const bcc = [...(o.bcc ?? parseAddressList(SUMMARY_BCC_DEFAULT))];
  const from = o.from ?? `${ALERT_NAME} <${ALERT_FROM_ADDRESS_DEFAULT}>`;
  const subject = subjectOf(alerts, o.now, o.test === true);
  const text = renderText(groups, alerts, agents, o.now);
  const html = renderHtml(groups, alerts, agents, o.now);
  return {
    to,
    cc: [],
    bcc,
    from,
    replyTo: o.replyTo ?? "admin@1on1realtors.com",
    subject,
    text,
    html,
    alerts,
    agents,
    items: [...items],
    windowStart: win.startIso,
    windowEnd: win.endIso,
  };
}

export function dailySummaryFromEnv(
  items: readonly SummaryItem[],
  env: Env,
  now: Date,
  o: { test?: boolean } = {},
): DailySummary {
  return buildDailySummary(items, {
    now,
    test: o.test,
    from: alertFromHeader(env),
    to: o.test ? [TEST_ALERT_TO] : dailySummaryTo(env),
    bcc: o.test ? [] : dailySummaryBcc(env),
    replyTo: alertReplyTo(env),
  });
}

/** A stable Resend Idempotency-Key for one AST day's live send. */
export function summaryIdempotencyKey(dayKey: string): string {
  return `daily-summary:${dayKey}`.replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 256);
}

export type DailySummaryArgs = {
  testSend: boolean;
  out: string | null;
  txt: string | null;
  send: boolean;
};

export function parseDailySummaryArgs(argv: readonly string[]): DailySummaryArgs {
  const value = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  return {
    testSend: argv.includes("--test-send"),
    out: value("out"),
    txt: value("txt"),
    send: argv.includes("--send"),
  };
}

export const SUMMARY_SEND_OFF =
  "Sending the daily summary from this command is off. Use --test-send for a copy to Miles only, or the morning scheduler when DAILY_SUMMARY_ENABLED is on.";

export type DailySummarySentRow = { dayKey: string; at: string; id: string };
