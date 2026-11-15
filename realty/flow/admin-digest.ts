import { bandOf } from "./automatch.ts";
import { askLine, leadCardId, leadMessage, listingPriceText, waUrlFor, type LeadInput } from "./automatch-leads.ts";
import { dateAst } from "./ast-time.ts";
import { isUsd } from "./fx.ts";
import { shortListingTitle } from "./listing-title.ts";
import type { StatusRow } from "./match-status.ts";
import type { Env } from "./env.ts";

/**
 * The admin match digest: ONE email to Crystal (the admin) with today's strong Automatch matches (75 and above), grouped by the
 * agent who holds each listing (the unassigned ones under "Office"). This module is the builder only: it returns the subject, a
 * plain-text body and a simple HTML body. It never sends. There is no mail transport anywhere in the realty code, and the
 * send switch below is read and refused, so a preview is all this can produce.
 *
 * Per match: the ask in plain words (area, budget, beds, type, sale or rent), a note when the ask was in US$, the posted time
 * (AST), the listing (short title, price, its link), the score, the suggested message (leadMessage, the same text as the desk), a
 * wa.me link with that message filled in (waUrlFor; "no usable number" says so and gives no link), and a link to the lead card on
 * the Desk (…/realty/desk#lead-…) where the outcome and reason are recorded.
 *
 * Excluded: anything below 75 or with no request id; any match that already has an outcome (any status row for its request and
 * listing); anything hidden by the agents' feedback (already gone from the rows: learnFromFeedback runs in automatchRun). One row per
 * request and listing: the best score stands. Nothing here reads the clock or the environment: the rows, the statuses and the
 * environment (for the base URL and the send switch) all come in as arguments.
 *
 * Portable: no node:*, no next, no bare process.
 */

/** Who the digest is addressed to (the admin). The address is here only, for the preview's To line. */
export const DIGEST_TO = "admin@1on1realtors.com";

/** The one switch that would enable a send. Only exactly "1" counts; it still does nothing in this build (digestSendState). */
export const DIGEST_SEND_FLAG = "ONEON1_ADMIN_DIGEST_SEND";

/** The Desk's public address when BOPS_PUBLIC_URL isn't set. */
export const DEFAULT_PUBLIC_URL = "https://bop.1on1realtors.com";

/** The refusal shown for --send, and the state a caller can show. Sending is off in this build, whatever the flag says. */
export const SEND_REFUSED = "Refused: sending the admin digest is off in this build. This command only renders a preview; nothing was sent.";

export type DigestMatch = {
  requestId: string;
  listingKey: string;
  score: number;
  /** The ask in plain words (askLine), e.g. "Looking to buy a 3-bed townhouse in Maraval, around TT$4.3m". */
  ask: string;
  /** When the ask was posted, in AST ("2026-11-14 08:00 AST"), or "" when the time is unreadable. */
  posted: string;
  /** The ask was in US$: the note is shown. */
  usd: boolean;
  /** Who asked, as the store has it (name and firm), or "Name not given". The number is only in the wa.me link. */
  from: string;
  listing: { title: string; price: string | null; url: string | null };
  /** The suggested opening message (leadMessage), with the short title. */
  message: string;
  /** https://wa.me/<digits>?text=… for Crystal's own browser, or null when there's no usable number. */
  waUrl: string | null;
  /** The lead card on the Desk, by its anchor: <base>/realty/desk#lead-…. */
  deskUrl: string;
};

export type DigestGroup = { agent: string; office: boolean; matches: DigestMatch[] };

export type AdminDigest = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Matches in the digest (after the exclusions and the dedupe). */
  matches: number;
  /** Agent groups, Office last. */
  agents: number;
  groups: DigestGroup[];
};

/** The public base URL for the Desk links: BOPS_PUBLIC_URL without a trailing slash, else the default. */
export function publicBaseUrl(env: Env): string {
  const raw = (env.BOPS_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(raw) ? raw : DEFAULT_PUBLIC_URL;
}

/**
 * The send switch: whether ONEON1_ADMIN_DIGEST_SEND is exactly "1", and that sending is off. `sending` is always false in this
 * build: there's no transport to turn on, so the flag changes nothing but what this reports.
 */
export function digestSendState(env: Env): { flagOn: boolean; sending: false; message: string } {
  return { flagOn: env[DIGEST_SEND_FLAG] === "1", sending: false, message: SEND_REFUSED };
}

/** The command-line flags the digest CLI reads: --out and --txt (file paths), and --send (refused). Pure: the argv comes in. */
export function parseDigestArgs(argv: readonly string[]): { send: boolean; out: string | null; txt: string | null } {
  const value = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  return { send: argv.includes("--send"), out: value("out"), txt: value("txt") };
}

/**
 * The strong rows that go in the digest: one per request and listing (the best score stands), score 75 and above, with a request
 * id, and no outcome yet. Best first.
 */
export function digestRows(rows: readonly LeadInput[], statuses: readonly StatusRow[]): LeadInput[] {
  const actioned = new Set(statuses.map((s) => `${s.requestId}|${s.listingKey}`));
  const best = new Map<string, LeadInput>();
  for (const r of rows) {
    if (bandOf(r.score) !== "strong" || !r.ask.postId) continue;
    const key = `${r.ask.postId}|${r.listingKey}`;
    if (actioned.has(key)) continue;
    const prev = best.get(key);
    if (!prev || r.score > prev.score) best.set(key, r);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || Date.parse(postedOf(b)) - Date.parse(postedOf(a)));
}

const postedOf = (r: LeadInput): string => r.ask.postedAt ?? r.ask.lastSeenAt;

function matchOf(r: LeadInput, baseUrl: string): DigestMatch {
  const message = leadMessage(r);
  const requestId = r.ask.postId as string;
  const who = [r.ask.senderName, r.ask.firm].filter((x): x is string => !!x && x.trim() !== "").join(" · ");
  return {
    requestId,
    listingKey: r.listingKey,
    score: r.score,
    ask: askLine(r.ask),
    posted: dateAst(postedOf(r)),
    usd: isUsd(r.ask.currency),
    from: who || "Name not given",
    listing: { title: shortListingTitle(r.listing), price: listingPriceText(r.listing, r.ask.listingType), url: r.listing.url },
    message,
    waUrl: waUrlFor(r.ask.senderPhone, message),
    deskUrl: `${baseUrl}/realty/desk#${leadCardId(requestId, r.listingKey)}`,
  };
}

/** The digest's groups: by holding agent, named agents A to Z, then Office (unassigned) last. Matches keep their order. */
export function groupByAgent(matches: readonly { agentId: number | null; agentName: string | null; match: DigestMatch }[]): DigestGroup[] {
  const groups = new Map<string, DigestGroup>();
  for (const m of matches) {
    const office = m.agentId == null;
    const agent = office ? "Office (unassigned listings)" : (m.agentName ?? "Agent");
    const key = office ? "office" : `agent:${m.agentId}`;
    const g = groups.get(key) ?? { agent, office, matches: [] };
    g.matches.push(m.match);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => Number(a.office) - Number(b.office) || a.agent.localeCompare(b.agent));
}

/** The opening, written as from Miles. Kept plain: no bots, no AI, no tools' names; WhatsApp links are for forwarding. */
export const INTRO_HELLO = "Hi Crystal,";
export const INTRO_BODY = [
  "Here are today's strong matches for our listings, grouped by the agent who holds each one. For each match there is a short summary, a suggested message, a WhatsApp link with that message filled in, and a link to the Desk where you can record how it went.",
  "Please have a look and let me know if you'd rather forward these to the agents yourself, or if you'd like the agents to follow up from the Desk.",
];
export const INTRO_EMPTY = "There are no new strong matches waiting for a follow-up today, so nothing needs forwarding.";

/** The subject: "Today's listing matches (3)". */
export function digestSubject(n: number): string {
  return `Today's listing matches (${n})`;
}

/** The digest for these rows: the subject, the plain-text and HTML bodies, and the groups. Pure: nothing is sent. */
export function buildAdminDigest(rows: readonly LeadInput[], o: { statuses: readonly StatusRow[]; baseUrl: string }): AdminDigest {
  const picked = digestRows(rows, o.statuses).map((r) => ({ agentId: r.listing.agentId, agentName: r.listing.agentName ?? null, match: matchOf(r, o.baseUrl) }));
  const groups = groupByAgent(picked);
  const matches = picked.length;
  return {
    to: DIGEST_TO,
    subject: digestSubject(matches),
    text: renderText(groups, matches),
    html: renderHtml(groups, matches),
    matches,
    agents: groups.length,
    groups,
  };
}

/* ---------------- Plain text ---------------- */

/*
 * The plain text and the HTML say the same words, in the same order: digestTextFromHtml(html) and text agree once whitespace is
 * collapsed (the test checks it). So the headings carry no decoration (no dashes), and every link shows its own URL.
 */

function renderText(groups: readonly DigestGroup[], matches: number): string {
  const out: string[] = [INTRO_HELLO, ""];
  if (matches) out.push(...INTRO_BODY.flatMap((p) => [p, ""]));
  else out.push(INTRO_EMPTY, "");
  for (const g of groups) {
    out.push(`${g.agent}: ${countWord(g.matches.length)}`, "");
    g.matches.forEach((m, i) => out.push(...matchText(m, i + 1), ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** "1 match" or "2 matches". */
const countWord = (n: number): string => `${n} match${n === 1 ? "" : "es"}`;

const NO_PRICE = "no price listed";
const NO_POSTED = "time not given";
const NO_LINK = "no link on file";
const NO_WA = "No usable WhatsApp number on this ask, so there's no link.";
const WA_LABEL = "WhatsApp, with the message filled in (opens in your own browser):";
const DESK_LABEL = "Record how it went on the Desk:";
const NOTE_USD = "this ask was in US$; the TT$ figure is the fixed-rate equivalent.";

function matchText(m: DigestMatch, n: number): string[] {
  const lines = [`${n}. ${m.listing.title}`];
  lines.push(`   Price: ${m.listing.price ?? NO_PRICE}`);
  lines.push(`   Ask: ${m.ask}`);
  if (m.usd) lines.push(`   Note: ${NOTE_USD}`);
  lines.push(`   Posted: ${m.posted || NO_POSTED}`);
  lines.push(`   From: ${m.from}`);
  lines.push(`   Listing: ${m.listing.url ?? NO_LINK}`);
  lines.push(`   Score: ${m.score}`);
  lines.push("   Suggested message:");
  lines.push(`     ${m.message}`);
  lines.push(m.waUrl ? `   ${WA_LABEL} ${m.waUrl}` : `   ${NO_WA}`);
  lines.push(`   ${DESK_LABEL} ${m.deskUrl}`);
  return lines;
}

/* ---------------- HTML ---------------- */

/** Text escaped for HTML (element text and attribute values). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * The HTML body, for pasting into an email draft that rejects any style attribute: only p, h3, ul, li, a, br and strong (plus the
 * html and body wrapper), and href is the only attribute, on a. No inline CSS, no class, no id. The mail client adds the signature.
 */
function renderHtml(groups: readonly DigestGroup[], matches: number): string {
  const e = escapeHtml;
  const paras = matches ? INTRO_BODY : [INTRO_EMPTY];
  const body = groups.map((g) => `<h3>${e(g.agent)}: ${e(countWord(g.matches.length))}</h3>` + g.matches.map((m, i) => matchHtml(m, i + 1)).join("")).join("");
  return ["<!doctype html>", "<html><body>", `<p>${e(INTRO_HELLO)}</p>`, ...paras.map((p) => `<p>${e(p)}</p>`), body, "</body></html>"].join("\n");
}

function matchHtml(m: DigestMatch, n: number): string {
  const e = escapeHtml;
  const items = [
    `<li><strong>Price:</strong> ${e(m.listing.price ?? NO_PRICE)}</li>`,
    `<li><strong>Ask:</strong> ${e(m.ask)}</li>`,
    m.usd ? `<li><strong>Note:</strong> ${e(NOTE_USD)}</li>` : "",
    `<li><strong>Posted:</strong> ${e(m.posted || NO_POSTED)}</li>`,
    `<li><strong>From:</strong> ${e(m.from)}</li>`,
    `<li><strong>Listing:</strong> ${m.listing.url ? `<a href="${e(m.listing.url)}">${e(m.listing.url)}</a>` : e(NO_LINK)}</li>`,
    `<li><strong>Score:</strong> ${m.score}</li>`,
  ].join("");
  const wa = m.waUrl ? `<p>${e(WA_LABEL)} <a href="${e(m.waUrl)}">${e(m.waUrl)}</a></p>` : `<p>${e(NO_WA)}</p>`;
  return (
    `<p><strong>${n}. ${e(m.listing.title)}</strong></p>` +
    `<ul>${items}</ul>` +
    `<p><strong>Suggested message:</strong><br>${e(m.message)}</p>` +
    wa +
    `<p>${e(DESK_LABEL)} <a href="${e(m.deskUrl)}">${e(m.deskUrl)}</a></p>`
  );
}

const HTML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * The words of an HTML body as plain text: line breaks at <br>, </p>, </li>, </h3> and </ul>, the tags dropped, and the entities
 * decoded. The plain-text body and this must say the same words (the test checks them, whitespace collapsed). Pure.
 */
export function digestTextFromHtml(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>|<\/(?:p|li|h3|ul)>/gi, "\n");
  return withBreaks
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, name: string) => {
      if (name[0] === "#") return String.fromCodePoint(name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10));
      return HTML_ENTITIES[name.toLowerCase()] ?? `&${name};`;
    })
    .replace(/\n{2,}/g, "\n");
}
