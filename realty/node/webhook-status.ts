import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The live-feed counter for the Periskope webhook: when a signed delivery was last accepted (stored as a message, or
 * already seen), and how many have been. Written only from the webhook's accepted path (periskope-intake.ts
 * handleWebhook), never from the poll or backfill, so the desk and the digest show what Periskope actually delivered.
 * One small file under the intake root: webhook-status.json, 0600, in a 0700 directory, replaced by rename.
 * No message text, phone number or chat id is kept here: only the group's name, the event type and the outcome.
 */

export type WebhookOutcome = "added" | "duplicate";

export type WebhookStatus = {
  lastAcceptedAt: string | null;
  lastEventType: string | null;
  lastGroupName: string | null;
  lastOutcome: WebhookOutcome | null;
  acceptedCount: number;
};

export const WEBHOOK_STATUS_FILE = "webhook-status.json";

const EMPTY: WebhookStatus = { lastAcceptedAt: null, lastEventType: null, lastGroupName: null, lastOutcome: null, acceptedCount: 0 };

/** The stored status, or the empty one when there is no file yet (or it can't be read). Never throws. */
export function readWebhookStatus(root: string): WebhookStatus {
  const file = join(root, WEBHOOK_STATUS_FILE);
  if (!existsSync(file)) return { ...EMPTY };
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<WebhookStatus>;
    const at = typeof v.lastAcceptedAt === "string" && Number.isFinite(Date.parse(v.lastAcceptedAt)) ? v.lastAcceptedAt : null;
    return {
      lastAcceptedAt: at,
      lastEventType: typeof v.lastEventType === "string" ? v.lastEventType : null,
      lastGroupName: typeof v.lastGroupName === "string" ? v.lastGroupName : null,
      lastOutcome: v.lastOutcome === "added" || v.lastOutcome === "duplicate" ? v.lastOutcome : null,
      acceptedCount: Number.isInteger(v.acceptedCount) && (v.acceptedCount as number) >= 0 ? (v.acceptedCount as number) : 0,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Counts one accepted delivery and records it as the last one. Atomic: write a tmp file (0600), then rename. */
export function recordWebhookAccepted(root: string, a: { at: string; eventType: string; groupName: string | null; outcome: WebhookOutcome }): WebhookStatus {
  const prev = readWebhookStatus(root);
  const next: WebhookStatus = {
    lastAcceptedAt: a.at,
    lastEventType: a.eventType,
    lastGroupName: a.groupName,
    lastOutcome: a.outcome,
    acceptedCount: prev.acceptedCount + 1,
  };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, WEBHOOK_STATUS_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return next;
}

const AST_CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/Port_of_Spain", hour: "numeric", minute: "2-digit", hour12: true });

/** The time in Port of Spain (AST) on a 12-hour clock, e.g. "7:58 AM"; null for a bad ISO. Built from parts, so no narrow no-break space. */
export function timeAst(iso: string): string | null {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return null;
  const parts = AST_CLOCK.formatToParts(t);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
}

/** The desk and digest line: "Live feed: last message 7:58 AM", or "Live feed: no messages yet" before any accepted delivery. */
export function webhookStatusLabel(status: WebhookStatus): string {
  const time = status.lastAcceptedAt ? timeAst(status.lastAcceptedAt) : null;
  return time ? `Live feed: last message ${time}` : "Live feed: no messages yet";
}
