import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The live-feed counter for the Periskope webhook: when a signed delivery was last accepted (stored as a message, or
 * already seen), and how many have been. Written only from the webhook's accepted path (periskope-intake.ts
 * handleWebhook), never from the poll or backfill, so the desk and the digest show what Periskope actually delivered.
 * One small file under the intake root: webhook-status.json, 0600, in a 0700 directory, replaced by rename.
 * No message text, phone number or chat id is kept here: only the group's name, the event type and the outcome.
 *
 * `health` is the poller's verdict (webhook-health.ts): UP or DOWN, the lag, the incident, the last reconnect attempt and
 * the gap summary. It is written only by the poller, and an accepted delivery keeps it as it was.
 */

export type WebhookOutcome = "added" | "duplicate";

export type WebhookState = "UP" | "DOWN";

export type WebhookHealth = {
  state: WebhookState;
  /** How far the API's newest text message is ahead of the last accepted delivery, in ms. Null when there is no delivery yet. */
  lagMs: number | null;
  checkedAt: string;
  /** When the current DOWN incident began, or null when UP. */
  downSince: string | null;
  /** An alert still to send (kept across polls while a send fails). */
  pendingAlert: "down" | "up" | null;
  lastReconnectAt: string | null;
  /** The last reconnect attempt: the action taken (e.g. "resumed", "created", "already_subscribed") or the failure code. */
  lastReconnect: { at: string; ok: boolean; action: string } | null;
  /** The last gap check: text messages in the API window that aren't in the store. Counts only. */
  gap: { checkedAt: string; missing: number; chats: number } | null;
};

export type WebhookStatus = {
  lastAcceptedAt: string | null;
  lastEventType: string | null;
  lastGroupName: string | null;
  lastOutcome: WebhookOutcome | null;
  acceptedCount: number;
  health?: WebhookHealth | null;
};

export const WEBHOOK_STATUS_FILE = "webhook-status.json";

const EMPTY: WebhookStatus = { lastAcceptedAt: null, lastEventType: null, lastGroupName: null, lastOutcome: null, acceptedCount: 0, health: null };

const validIso = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);

function readHealth(v: unknown): WebhookHealth | null {
  if (!v || typeof v !== "object") return null;
  const h = v as Partial<WebhookHealth>;
  if (h.state !== "UP" && h.state !== "DOWN") return null;
  const gap = h.gap && typeof h.gap === "object" && Number.isInteger(h.gap.missing) && Number.isInteger(h.gap.chats) && validIso(h.gap.checkedAt)
    ? { checkedAt: h.gap.checkedAt, missing: h.gap.missing, chats: h.gap.chats }
    : null;
  const last = h.lastReconnect && typeof h.lastReconnect === "object" && validIso(h.lastReconnect.at)
    ? { at: h.lastReconnect.at, ok: h.lastReconnect.ok === true, action: typeof h.lastReconnect.action === "string" ? h.lastReconnect.action : "" }
    : null;
  return {
    state: h.state,
    lagMs: typeof h.lagMs === "number" && Number.isFinite(h.lagMs) ? h.lagMs : null,
    checkedAt: validIso(h.checkedAt) ?? new Date(0).toISOString(),
    downSince: validIso(h.downSince),
    pendingAlert: h.pendingAlert === "down" || h.pendingAlert === "up" ? h.pendingAlert : null,
    lastReconnectAt: validIso(h.lastReconnectAt),
    lastReconnect: last,
    gap,
  };
}

/** The stored status, or the empty one when there is no file yet (or it can't be read). Never throws. */
export function readWebhookStatus(root: string): WebhookStatus {
  const file = join(root, WEBHOOK_STATUS_FILE);
  if (!existsSync(file)) return { ...EMPTY };
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<WebhookStatus>;
    const at = validIso(v.lastAcceptedAt);
    return {
      lastAcceptedAt: at,
      lastEventType: typeof v.lastEventType === "string" ? v.lastEventType : null,
      lastGroupName: typeof v.lastGroupName === "string" ? v.lastGroupName : null,
      lastOutcome: v.lastOutcome === "added" || v.lastOutcome === "duplicate" ? v.lastOutcome : null,
      acceptedCount: Number.isInteger(v.acceptedCount) && (v.acceptedCount as number) >= 0 ? (v.acceptedCount as number) : 0,
      health: readHealth(v.health),
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Atomic: write a tmp file (0600), then rename. */
export function writeWebhookStatus(root: string, status: WebhookStatus): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, WEBHOOK_STATUS_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Counts one accepted delivery and records it as the last one. The poller's health block is kept as it is. */
export function recordWebhookAccepted(root: string, a: { at: string; eventType: string; groupName: string | null; outcome: WebhookOutcome }): WebhookStatus {
  const prev = readWebhookStatus(root);
  const next: WebhookStatus = {
    lastAcceptedAt: a.at,
    lastEventType: a.eventType,
    lastGroupName: a.groupName,
    lastOutcome: a.outcome,
    acceptedCount: prev.acceptedCount + 1,
    health: prev.health ?? null,
  };
  writeWebhookStatus(root, next);
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
  const parts = [time ? `Live feed: last message ${time}` : "Live feed: no messages yet"];
  if (status.health?.state === "DOWN") parts.push("Webhook DOWN");
  if (status.health?.gap && status.health.gap.missing > 0) parts.push(`${status.health.gap.missing} missing in the last 24h`);
  return parts.join(" · ");
}
