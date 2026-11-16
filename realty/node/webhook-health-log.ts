import { join } from "node:path";
import { appendJsonl } from "./jsonl.ts";
import type { WebhookState } from "./webhook-status.ts";
import type { AlertKind } from "./webhook-alert.ts";

/**
 * The webhook health journal: webhook-health.jsonl on the volume (0600, in the 0700 intake root), one line per event:
 * a detection (UP or DOWN, with the lag), an alert sent / failed / skipped, a reconnect attempt, a gap check. Each line
 * has the ISO time and the same time in Port of Spain (AST). The fields are fixed here, so no message text, phone
 * number, chat id or API key can reach the file: a code or a count is all that is written.
 */

export const WEBHOOK_HEALTH_LOG = "webhook-health.jsonl";

export type HealthEvent =
  | { type: "detect"; state: WebhookState; prev: WebhookState; lagMs: number | null }
  | { type: "alert_sent"; kind: AlertKind }
  | { type: "alert_failed"; kind: AlertKind; code: string }
  | { type: "alert_skipped"; kind: AlertKind; reason: string }
  | { type: "reconnect"; ok: boolean; action: string; code?: string }
  | { type: "gap_report"; apiMessages: number; missing: number; chats: number }
  | { type: "subscription"; state: "subscribed" | "paused" | "missing" | "unknown"; prev: string | null; code?: string }
  | { type: "reconnect_deferred"; reason: string };

const AST_STAMP = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Port_of_Spain",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "2026-11-16 07:05 AST": the Port of Spain date and 24-hour time. Null for a bad ISO. */
export function astStamp(iso: string): string | null {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return null;
  const p = Object.fromEntries(AST_STAMP.formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} AST`;
}

export function appendHealthLog(root: string, now: Date, event: HealthEvent): void {
  const iso = now.toISOString();
  appendJsonl(join(root, WEBHOOK_HEALTH_LOG), JSON.stringify({ at: iso, ast: astStamp(iso), ...event }));
}
