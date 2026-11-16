import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../flow/env.ts";
import { listGroupMessages, textFromOthers, type getJson } from "./periskope-backfill.ts";
import { pollGroups } from "./periskope-groups.ts";
import { PeriskopeStore } from "./periskope-store.ts";
import { appendHealthLog } from "./webhook-health-log.ts";
import { readWebhookStatus, writeWebhookStatus } from "./webhook-status.ts";

/**
 * The gap report: for each watched group, the text messages the API shows in the last 24 hours that are not in our store.
 *
 * READ-ONLY. This module never writes a post, never ingests, never calls the webhook or sends anything. The 10-minute poller
 * already ingests every new message it GETs into our store (listen-only, no WhatsApp or Periskope sends), so a gap is
 * something the poller didn't store (an opt-out, no consent, a drop). A manual historical backfill still needs Miles's yes.
 *
 * The report file (webhook-gap-report.json, 0600) holds counts, chat names and time ranges only: no ids, no text, no
 * phone numbers. The summary also lands in webhook-status.json (health.gap) for the desk and digest line.
 */

export const GAP_LOOKBACK_MS = 24 * 60 * 60_000;
/** The check runs once an hour from the poller, not every 10 minutes. */
export const GAP_EVERY_MS = 60 * 60_000;
export const GAP_REPORT_FILE = "webhook-gap-report.json";

export type GapChat = { chatName: string; missing: number; earliest: string | null; latest: string | null };

export type GapReport = {
  checkedAt: string;
  windowFrom: string;
  windowTo: string;
  /** API text messages in the window, all groups. */
  apiMessages: number;
  missing: number;
  /** Only the chats with something missing. */
  chats: GapChat[];
};

export type ApiText = { chatName: string; messageId: string; sentAt: string | null };

/**
 * Pure: which of the API's text messages the store doesn't have. The message ids are used here and dropped: the report
 * keeps counts, chat names and the time range of what is missing.
 */
export function gapReportOf(api: ApiText[], stored: ReadonlySet<string>, w: { checkedAt: string; windowFrom: string; windowTo: string }): GapReport {
  const byChat = new Map<string, GapChat>();
  let missing = 0;
  for (const m of api) {
    if (stored.has(m.messageId)) continue;
    missing += 1;
    const c = byChat.get(m.chatName) ?? { chatName: m.chatName, missing: 0, earliest: null, latest: null };
    c.missing += 1;
    if (m.sentAt && (!c.earliest || m.sentAt < c.earliest)) c.earliest = m.sentAt;
    if (m.sentAt && (!c.latest || m.sentAt > c.latest)) c.latest = m.sentAt;
    byChat.set(m.chatName, c);
  }
  return {
    checkedAt: w.checkedAt,
    windowFrom: w.windowFrom,
    windowTo: w.windowTo,
    apiMessages: api.length,
    missing,
    chats: [...byChat.values()].sort((a, b) => b.missing - a.missing || a.chatName.localeCompare(b.chatName)),
  };
}

/** The last written report, or null. Never throws. */
export function readGapReport(root: string): GapReport | null {
  try {
    const file = join(root, GAP_REPORT_FILE);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as GapReport) : null;
  } catch {
    return null;
  }
}

/**
 * Lists the watched groups (GET only) for the last 24 hours, compares with the store, writes the report, and records the
 * summary on webhook-status.json. A group whose GET fails is left out of the counts, not counted as missing.
 */
export async function runGapReport(o: { root: string; env: Env; now: Date; apiKey: string; fetcher: typeof getJson; phoneId?: string }): Promise<GapReport> {
  const from = new Date(o.now.getTime() - GAP_LOOKBACK_MS).toISOString();
  const api: ApiText[] = [];
  for (const g of pollGroups(o.root, o.env)) {
    const listed = await listGroupMessages({ apiKey: o.apiKey, chatId: g.chatId, startTime: from, phoneId: o.phoneId, fetcher: o.fetcher });
    if (!listed.ok) continue;
    for (const msg of listed.messages) {
      const p = textFromOthers(msg, g.chatName);
      if (p) api.push({ chatName: g.chatName, messageId: p.messageId, sentAt: p.sentAt });
    }
  }
  const stored = new Set(new PeriskopeStore(o.root).posts().map((p) => p.messageId));
  const report = gapReportOf(api, stored, { checkedAt: o.now.toISOString(), windowFrom: from, windowTo: o.now.toISOString() });

  mkdirSync(o.root, { recursive: true, mode: 0o700 });
  const file = join(o.root, GAP_REPORT_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);

  const status = readWebhookStatus(o.root);
  if (status.health) writeWebhookStatus(o.root, { ...status, health: { ...status.health, gap: { checkedAt: report.checkedAt, missing: report.missing, chats: report.chats.length } } });
  appendHealthLog(o.root, o.now, { type: "gap_report", apiMessages: report.apiMessages, missing: report.missing, chats: report.chats.length });
  return report;
}
