import { automatchRun, type AutomatchOpts, type AutomatchRow } from "./automatch.ts";
import { periskopeRoot } from "./periskope-root.ts";
import { PeriskopeStore } from "./periskope-store.ts";
import {
  ALERT_NAME,
  SEND_OFF,
  alertEnabled,
  alertKey,
  alertOptsFromEnv,
  alertSendExisting,
  alertSendState,
  buildAutoMatchAlerts,
  flipReport,
  planAlertDispatch,
  type AlertInput,
  type AlertSentRow,
  type AutoMatchAlert,
} from "../flow/automatch-alert.ts";
import { runtimeEnv } from "../flow/env.ts";
import type { SeamAgent } from "../flow/crm-seam.ts";

/**
 * Auto-Match Alert loader and live dispatcher (realty/flow/automatch-alert.ts builds each email). Reads the same Automatch
 * as the desk, attaches each holding agent's email, plans what to send or suppress, and records sent keys so a match is
 * emailed at most once. It never sends in this build (no mail transport). While the flag is off, current strong matches are
 * recorded as suppressed so flipping AUTOMATCH_ALERT_ENABLED on later does not bulk-email the backlog.
 */

export type AlertLoad = {
  alerts: AutoMatchAlert[];
  plan: ReturnType<typeof planAlertDispatch>;
  flip: ReturnType<typeof flipReport>;
  enabled: boolean;
  sendExisting: boolean;
  sending: false;
  message: string;
};

function asInput(row: AutomatchRow, agents: readonly SeamAgent[]): AlertInput {
  const email = row.listing.agentId != null ? (agents.find((a) => a.id === row.listing.agentId)?.email ?? null) : null;
  return { ...row, agentEmail: email };
}

export async function loadAutoMatchAlerts(o: AutomatchOpts & { test?: boolean } = {}): Promise<AlertLoad> {
  const env = o.env ?? runtimeEnv();
  const root = o.root ?? periskopeRoot(env);
  const now = o.now ?? new Date();
  const { result, agents } = await automatchRun({ ...o, env, root, now });
  const store = new PeriskopeStore(root);
  const opts = alertOptsFromEnv(env, now, { statuses: store.matchStatuses(), test: o.test });
  const alerts = buildAutoMatchAlerts(result.pairs.map((p) => asInput(p, agents)), opts);
  const sent = store.automatchAlertSentRows();
  const enabled = alertEnabled(env);
  const sendExisting = alertSendExisting(env);
  const plan = planAlertDispatch(alerts, sent, { enabled, sendExisting });
  const state = alertSendState(env);
  return { alerts, plan, flip: flipReport(alerts, sent), enabled, sendExisting, sending: false, message: state.message };
}

/**
 * Record suppressions for the current strong set when sending is off (or on a first enabled tick with an empty store).
 * Never marks a match as sent, because this build has no transport. Never throws to the caller: the poll and the intake
 * wrap this too. Returns counts only, no addresses or phone numbers.
 */
export async function syncAutoMatchAlerts(o: AutomatchOpts = {}): Promise<{ suppressed: number; wouldSend: number; skipped: number; enabled: boolean }> {
  const env = o.env ?? runtimeEnv();
  const root = o.root ?? periskopeRoot(env);
  const now = o.now ?? new Date();
  const loaded = await loadAutoMatchAlerts({ ...o, env, root, now });
  const store = new PeriskopeStore(root);
  const at = now.toISOString();
  const suppress: AlertSentRow[] = loaded.plan.suppress.map((a) => ({ requestId: a.requestId, listingKey: a.listingKey, at, kind: "suppressed" }));
  const added = store.recordAutomatchAlertSent(suppress);
  return { suppressed: added, wouldSend: loaded.plan.send.length, skipped: loaded.plan.skip.length, enabled: loaded.enabled };
}

/** A safe wrapper for the poller and the intake: never throws, never sends, no PII in the log. */
export async function syncAutoMatchAlertsSafely(o: AutomatchOpts = {}): Promise<void> {
  try {
    const r = await syncAutoMatchAlerts(o);
    console.log(JSON.stringify({ automatchAlert: "ok", suppressed: r.suppressed, wouldSend: r.wouldSend, skipped: r.skipped, enabled: r.enabled }));
  } catch (e) {
    console.error(JSON.stringify({ automatchAlert: "error", error: (e as Error).message ?? String(e) }));
  }
}

/**
 * Owners' preview (app/api/realty/automatch-alert and the Auto-Match Alert page). Owners only. Renders only; never sends.
 * GET text/html of the first alert, or ?format=txt, or ?format=json for the plan counts (no phone numbers in json).
 */
export async function automatchAlertRoute(request: Request, o: AutomatchOpts = {}): Promise<Response> {
  const env = o.env ?? runtimeEnv();
  const loaded = await loadAutoMatchAlerts({ ...o, env });
  const format = new URL(request.url).searchParams.get("format");
  if (format === "json") {
    return Response.json(
      {
        name: ALERT_NAME,
        enabled: loaded.enabled,
        sending: false,
        message: loaded.message,
        alerts: loaded.alerts.length,
        wouldSend: loaded.plan.send.length,
        wouldSuppress: loaded.plan.suppress.length,
        skipped: loaded.plan.skip.length,
        flip: loaded.flip,
        subjects: loaded.alerts.map((a) => ({ to: a.to, cc: a.cc, from: a.from, subject: a.subject })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const body = loaded.alerts.map((a) => (format === "txt" ? `To: ${a.to}\nCc: ${a.cc.join(", ")}\nFrom: ${a.from}\nSubject: ${a.subject}\n\n${a.text}` : a.html)).join(format === "txt" ? "\n\n-----\n\n" : "\n");
  const empty = format === "txt" ? "No new strong matches to preview.\n" : `<!doctype html><html><body><p>No new strong matches to preview.</p></body></html>`;
  return new Response(body || empty, {
    headers: { "content-type": format === "txt" ? "text/plain; charset=utf-8" : "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export { SEND_OFF, alertKey };
