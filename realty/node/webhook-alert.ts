import type { Env } from "../flow/env.ts";
import { escapeHtml } from "../flow/admin-digest.ts";
import { alertFromHeader } from "../flow/automatch-alert.ts";
import { resendApiKey, sendResendEmail, type SendFetch } from "./automatch-alert-resend.ts";
import { astStamp } from "./webhook-health-log.ts";
import type { GapReport } from "./webhook-gap.ts";

/**
 * The webhook alert email: DOWN, recovery, and one reconnect attempt. It goes to Miles only (no CC, no BCC), over the
 * existing Resend path and the alerts address. The body is counts, chat names and time ranges: no message text, no
 * phone numbers, no message or chat ids, and no API keys. Idempotency-Key is per incident, so a retry can't double-send.
 */

export const OWNER_ALERT_TO = "miles@simplyintense.com";

export type AlertKind = "down" | "up" | "reconnect";

export type AlertInput = {
  kind: AlertKind;
  /** Lag in ms (API newest text message minus the last delivery), or null when there is no delivery yet. */
  lagMs: number | null;
  lastAcceptedAt: string | null;
  incidentSince: string | null;
  /** What this poll's reconnect attempt did, as a short phrase ("resumed", "failed: list_500"), or null when none ran. */
  reconnect: string | null;
  gap: GapReport | null;
};

const when = (iso: string | null) => (iso ? (astStamp(iso) ?? "unknown time") : "never");

/** The subject and the body (text and html). Pure: no network, no secrets. */
export function buildWebhookAlert(a: AlertInput): { subject: string; text: string; html: string } {
  const lines: string[] = [];
  let subject: string;
  if (a.kind === "down") {
    subject = "Bops: Periskope webhook is DOWN";
    lines.push(
      a.lagMs === null
        ? "The Periskope webhook has not delivered a message yet, and the API has older messages."
        : `The API has a message the webhook has not delivered: about ${Math.round(a.lagMs / 60_000)} minutes behind.`,
    );
    lines.push(`Last delivery: ${when(a.lastAcceptedAt)}`);
    lines.push(`Down since: ${when(a.incidentSince)}`);
    lines.push(a.reconnect ? `Auto-resubscribe: ${a.reconnect}` : "Auto-resubscribe: not attempted this time (hourly limit, or PERISKOPE_AUTO_RESUBSCRIBE is off).");
  } else if (a.kind === "up") {
    subject = "Bops: Periskope webhook is delivering again";
    lines.push(`Delivering again. Last delivery: ${when(a.lastAcceptedAt)}`);
    lines.push(`Down since: ${when(a.incidentSince)}`);
  } else {
    subject = "Bops: Periskope webhook auto-resubscribe attempt";
    lines.push(`Auto-resubscribe attempt: ${a.reconnect ?? "no result"}`);
    lines.push("The webhook is still DOWN.");
  }
  if (a.gap) {
    lines.push(
      a.gap.missing === 0
        ? `Gap check (last 24 hours, ${when(a.gap.windowFrom)} to ${when(a.gap.windowTo)}): nothing missing.`
        : `Gap check (last 24 hours): ${a.gap.missing} text message(s) from the API are not in the store.`,
    );
    for (const c of a.gap.chats) {
      lines.push(`- ${c.chatName}: ${c.missing} missing, ${when(c.earliest)} to ${when(c.latest)}`);
    }
  }
  lines.push("", "Miles only. No message text, phone numbers or ids are in this email. The journal is webhook-health.jsonl on the Bops volume.");
  return {
    subject,
    text: lines.join("\n"),
    html: lines.map((l) => (l ? `<p>${escapeHtml(l)}</p>` : "")).join(""),
  };
}

export type AlertSend = { ok: true } | { ok: false; code: string } | { skipped: string };

/** Sends one alert to OWNER_ALERT_TO. Skipped (not an error) when no Resend key is set. Failures return a code only. */
export async function sendWebhookAlert(o: { env: Env; fetch: SendFetch; input: AlertInput; incidentKey: string }): Promise<AlertSend> {
  const apiKey = resendApiKey(o.env);
  if (!apiKey) return { skipped: "no RESEND_API_KEY" };
  const m = buildWebhookAlert(o.input);
  const r = await sendResendEmail(
    {
      from: alertFromHeader(o.env),
      to: [OWNER_ALERT_TO],
      // Reply-To is Miles too: a reply to a DOWN alert must not go to the office.
      replyTo: OWNER_ALERT_TO,
      subject: m.subject,
      text: m.text,
      html: m.html,
      idempotencyKey: `webhook-health-${o.input.kind}-${o.incidentKey}`.replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 256),
    },
    { apiKey, fetch: o.fetch },
  );
  return r.ok ? { ok: true } : { ok: false, code: r.status ? `http_${r.status}` : "network" };
}
