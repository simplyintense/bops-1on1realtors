import { automatchRun, type AutomatchOpts, type AutomatchRow } from "./automatch.ts";
import { periskopeRoot } from "./periskope-root.ts";
import { PeriskopeStore } from "./periskope-store.ts";
import {
  ALERT_NAME,
  BASELINE_CONFIRM,
  SEND_OFF,
  TEST_ALERT_TO,
  alertEnabled,
  alertFromAddress,
  alertFromHeader,
  alertKey,
  alertIdempotencyKey,
  alertOptsFromEnv,
  alertReplyTo,
  alertSendExisting,
  alertSendState,
  alertAttribution,
  buildAutoMatchAlert,
  buildAutoMatchAlerts,
  buildTestAutoMatchAlert,
  flipReport,
  planAlertDispatch,
  oneShotAgentStatus,
  planOneShotSend,
  type AlertInput,
  type AlertSentRow,
  type AutoMatchAlert,
} from "../flow/automatch-alert.ts";
import { FIRST_REVIEW_SEEDS, resolveReviewSeeds, reviewKeysOf } from "../flow/automatch-alert-review.ts";
import { shortListingTitle } from "../flow/listing-title.ts";
import { runtimeEnv, type Env } from "../flow/env.ts";
import type { SeamAgent } from "../flow/crm-seam.ts";
import { hasResendKey, resendApiKey, resendInputOf, sendResendEmail, type SendFetch } from "./automatch-alert-resend.ts";

/**
 * Auto-Match Alert loader and live dispatcher (realty/flow/automatch-alert.ts builds each email;
 * realty/node/automatch-alert-resend.ts talks to Resend). Reads the same Automatch as the desk, plans what to send or
 * suppress, and records sent keys so a match is emailed at most once. Live sending needs AUTOMATCH_ALERT_ENABLED and
 * RESEND_API_KEY. While the flag is off, current strong matches are recorded as suppressed so flipping the flag on later
 * does not bulk-email the backlog. A successful send (or a Resend idempotent replay) is the only thing that marks a
 * key as sent.
 */

export type AlertLoad = {
  alerts: AutoMatchAlert[];
  plan: ReturnType<typeof planAlertDispatch>;
  flip: ReturnType<typeof flipReport>;
  enabled: boolean;
  sendExisting: boolean;
  sending: boolean;
  hasTransport: boolean;
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
  const inputs = result.pairs.map((p) => asInput(p, agents));
  const alerts = buildAutoMatchAlerts(inputs, opts);
  const sent = store.automatchAlertSentRows();
  const enabled = alertEnabled(env);
  const sendExisting = alertSendExisting(env);
  const holdKeys = reviewKeysOf(resolveReviewSeeds(result.pairs, FIRST_REVIEW_SEEDS));
  const plan = planAlertDispatch(alerts, sent, { enabled, sendExisting, holdKeys });
  const state = alertSendState(env);
  const hasTransport = hasResendKey(env);
  return {
    alerts,
    plan,
    flip: flipReport(alerts, sent, holdKeys),
    enabled,
    sendExisting,
    sending: enabled && hasTransport,
    hasTransport,
    message: state.message,
  };
}

export type SyncAlertsResult = { suppressed: number; wouldSend: number; skipped: number; sent: number; failed: number; enabled: boolean };

/**
 * Record suppressions when sending is off (or on a first enabled tick with an empty store). When the flag is on and a
 * Resend key is present, deliver plan.send and mark a key sent only after a successful send. Never throws to the caller:
 * the poll and the intake wrap this too. Returns counts only, no addresses or phone numbers.
 */
export async function syncAutoMatchAlerts(o: AutomatchOpts & { fetch?: SendFetch } = {}): Promise<SyncAlertsResult> {
  const env = o.env ?? runtimeEnv();
  const root = o.root ?? periskopeRoot(env);
  const now = o.now ?? new Date();
  const loaded = await loadAutoMatchAlerts({ ...o, env, root, now });
  const store = new PeriskopeStore(root);
  const at = now.toISOString();
  const suppress: AlertSentRow[] = loaded.plan.suppress.map((a) => ({ requestId: a.requestId, listingKey: a.listingKey, at, kind: "suppressed" }));
  const added = store.recordAutomatchAlertSent(suppress);
  let sent = 0;
  let failed = 0;
  if (loaded.enabled && loaded.plan.send.length && hasResendKey(env)) {
    const r = await deliverAlerts(loaded.plan.send, { env, now, store, fetch: o.fetch });
    sent = r.sent;
    failed = r.failed;
  }
  return { suppressed: added, wouldSend: loaded.plan.send.length, skipped: loaded.plan.skip.length, sent, failed, enabled: loaded.enabled };
}

/** A safe wrapper for the poller and the intake: never throws, no PII in the log, never prints secrets. */
export async function syncAutoMatchAlertsSafely(o: AutomatchOpts = {}): Promise<void> {
  try {
    const r = await syncAutoMatchAlerts(o);
    console.log(JSON.stringify({ automatchAlert: "ok", suppressed: r.suppressed, wouldSend: r.wouldSend, skipped: r.skipped, sent: r.sent, failed: r.failed, enabled: r.enabled }));
  } catch (e) {
    console.error(JSON.stringify({ automatchAlert: "error", error: (e as Error).message ?? String(e) }));
  }
}

/**
 * The intake (one call per WhatsApp message) asks for an Auto-Match sync after every delivery. A full run re-scores every
 * request against every listing, and on the hosted shared-CPU machine one every few seconds used up the CPU allowance:
 * Fly then throttled the machine, the health check timed out and sign-in pages answered 503 or hung (Nov 23). So the
 * intake's calls are coalesced: at most one run at a time, at most one per INTAKE_ALERT_GAP_MS, and a call that lands
 * inside the gap schedules one trailing run so nothing is missed. The poller (every 10 minutes) still calls
 * syncAutoMatchAlertsSafely directly.
 */
export const INTAKE_ALERT_GAP_MS = 3 * 60_000;
const coalesce = globalThis as unknown as { __bopsAlertCoalesce?: { running: boolean; lastAt: number; timer: ReturnType<typeof setTimeout> | null; next: AutomatchOpts | null } };
export function syncAutoMatchAlertsCoalesced(o: AutomatchOpts = {}, gapMs = INTAKE_ALERT_GAP_MS): Promise<void> {
  if (gapMs <= 0) return syncAutoMatchAlertsSafely(o);
  const c = (coalesce.__bopsAlertCoalesce ??= { running: false, lastAt: 0, timer: null, next: null });
  const { now: _ignored, ...rest } = o;
  c.next = rest;
  const fire = async () => {
    c.timer = null;
    if (c.running || !c.next) return;
    const opts = c.next;
    c.next = null;
    c.running = true;
    c.lastAt = Date.now();
    try {
      await syncAutoMatchAlertsSafely(opts);
    } finally {
      c.running = false;
      if (c.next && !c.timer) schedule();
    }
  };
  const schedule = () => {
    const wait = Math.max(0, c.lastAt + gapMs - Date.now());
    c.timer = setTimeout(() => void fire(), wait);
    (c.timer as { unref?: () => void }).unref?.();
  };
  if (!c.running && !c.timer) schedule();
  return Promise.resolve();
}

export type DeliveredAlert = {
  agent: string;
  listingTitle: string;
  ageDays: number | null;
  requestId: string;
  listingKey: string;
  ok: boolean;
  id: string | null;
};

export async function deliverAlerts(
  alerts: AutoMatchAlert[],
  o: { env: Env; now: Date; store: PeriskopeStore; fetch?: SendFetch },
): Promise<{ sent: number; failed: number; results: DeliveredAlert[] }> {
  const apiKey = resendApiKey(o.env);
  if (!apiKey) {
    return {
      sent: 0,
      failed: alerts.length,
      results: alerts.map((a) => ({ agent: a.toName, listingTitle: a.listingTitle, ageDays: a.ageDays, requestId: a.requestId, listingKey: a.listingKey, ok: false, id: null })),
    };
  }
  const fetchImpl = o.fetch ?? fetch;
  const from = alertFromHeader(o.env);
  const replyTo = alertReplyTo(o.env);
  const at = o.now.toISOString();
  let sent = 0;
  let failed = 0;
  const results: DeliveredAlert[] = [];
  for (const a of alerts) {
    const result = await sendResendEmail(
      resendInputOf(a, { from, replyTo, idempotencyKey: alertIdempotencyKey(a.requestId, a.listingKey) }),
      { apiKey, fetch: fetchImpl },
    );
    if (result.ok) {
      o.store.markAutomatchAlertSent({ requestId: a.requestId, listingKey: a.listingKey, at, kind: "sent" });
      sent += 1;
      results.push({ agent: a.toName, listingTitle: a.listingTitle, ageDays: a.ageDays, requestId: a.requestId, listingKey: a.listingKey, ok: true, id: result.id });
    } else {
      console.error(JSON.stringify({ automatchAlert: "send-failed", retryable: result.retryable, status: result.status, error: result.error, requestId: a.requestId }));
      failed += 1;
      results.push({ agent: a.toName, listingTitle: a.listingTitle, ageDays: a.ageDays, requestId: a.requestId, listingKey: a.listingKey, ok: false, id: null });
    }
  }
  return { sent, failed, results };
}

export type OneShotSkipped = {
  reason: "no assigned agent" | "no agent email" | "unresolved";
  agent: string | null;
  listingTitle: string;
  listingUrl: string | null;
  ageDays: number | null;
  score: number | null;
};

export type BaselinePreview = {
  agent: string;
  listingTitle: string;
  ageDays: number | null;
  subject: string;
  score: number;
};
export type BaselineSendResult = {
  dryRun: boolean;
  wouldSend: number;
  sent: number;
  failed: number;
  results: Array<BaselinePreview & { id?: string | null; ok?: boolean }>;
  skipped: OneShotSkipped[];
  error?: string;
};

/**
 * One-shot send of the suppressed baseline plus the first-review matches, de-duplicated by request and listing.
 * Listings with no assigned agent (or no agent email) are skipped and reported, not emailed to the office.
 * dryRun previews only. A live send requires confirm === BASELINE_CONFIRM, marks each successful send as sent
 * so it can never go again, and returns Resend ids plus agent names only. Genuinely new matches are not sent.
 */
export async function sendBaselineAutoMatchAlerts(
  o: AutomatchOpts & { fetch?: SendFetch; dryRun?: boolean; confirm?: string } = {},
): Promise<BaselineSendResult> {
  const env = o.env ?? runtimeEnv();
  const root = o.root ?? periskopeRoot(env);
  const now = o.now ?? new Date();
  const { result, agents } = await automatchRun({ ...o, env, root, now });
  const store = new PeriskopeStore(root);
  const sentRows = store.automatchAlertSentRows();
  const opts = { ...alertOptsFromEnv(env, now, { statuses: store.matchStatuses() }), oneShot: true };
  const inputs = result.pairs.map((p) => asInput(p, agents));
  const inputByKey = new Map(inputs.map((r) => [`${r.ask.postId}|${r.listingKey}`, r]));
  const resolved = resolveReviewSeeds(result.pairs, FIRST_REVIEW_SEEDS);
  const reviewKeys = reviewKeysOf(resolved);
  const skipped: OneShotSkipped[] = [];
  for (const r of resolved) {
    if (!r.pair) {
      skipped.push({
        reason: "unresolved",
        agent: null,
        listingTitle: r.seed.listingUrl,
        listingUrl: r.seed.listingUrl,
        ageDays: null,
        score: null,
      });
    }
  }
  const usedSubjects = new Set<string>();
  const built: AutoMatchAlert[] = [];
  const seen = new Set<string>();
  const considerKeys = new Set<string>([
    ...sentRows.filter((r) => r.kind === "suppressed").map((r) => `${r.requestId}|${r.listingKey}`),
    ...reviewKeys,
  ]);
  for (const key of considerKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const row = inputByKey.get(key);
    if (!row) continue;
    const listingTitle = shortListingTitle(row.listing);
    const status = oneShotAgentStatus(row);
    if (status !== "ok") {
      skipped.push({
        reason: status,
        agent: status === "no assigned agent" ? null : (row.listing.agentName ?? "Agent"),
        listingTitle,
        listingUrl: row.listing.url ?? null,
        ageDays: null,
        score: row.score,
      });
      continue;
    }
    built.push(buildAutoMatchAlert(row, { ...opts, usedSubjects, oneShot: true }));
  }
  const toSend = planOneShotSend(built, sentRows, { reviewKeys });
  const preview: BaselinePreview[] = toSend.map((a) => ({
    agent: a.toName,
    listingTitle: a.listingTitle,
    ageDays: a.ageDays,
    subject: a.subject,
    score: a.score,
  }));
  if (o.dryRun) {
    return { dryRun: true, wouldSend: toSend.length, sent: 0, failed: 0, results: preview, skipped };
  }
  if (o.confirm !== BASELINE_CONFIRM) {
    return {
      dryRun: false,
      wouldSend: toSend.length,
      sent: 0,
      failed: 0,
      results: preview,
      skipped,
      error: `Refused: --send-baseline requires --dry-run or --confirm ${BASELINE_CONFIRM}. Nothing was sent.`,
    };
  }
  if (!hasResendKey(env)) {
    return { dryRun: false, wouldSend: toSend.length, sent: 0, failed: toSend.length, results: preview, skipped, error: "RESEND_API_KEY is not set" };
  }
  const r = await deliverAlerts(toSend, { env, now, store, fetch: o.fetch });
  return {
    dryRun: false,
    wouldSend: toSend.length,
    sent: r.sent,
    failed: r.failed,
    skipped,
    results: r.results.map((row, i) => ({ ...preview[i], ok: row.ok, id: row.id })),
  };
}

export type TestSendResult = { ok: true; id: string } | { ok: false; error: string; status?: number | null };

/**
 * One [TEST] alert to TEST_ALERT_TO only, with no CC or BCC. Works while AUTOMATCH_ALERT_ENABLED is off. Does not
 * record a sent-key for the fake listing. Never logs the API key.
 */
export async function sendTestAutoMatchAlert(o: { env?: Env; now?: Date; fetch?: SendFetch; baseUrl?: string; agedDays?: number } = {}): Promise<TestSendResult> {
  const env = o.env ?? runtimeEnv();
  const now = o.now ?? new Date();
  const apiKey = resendApiKey(env);
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY is not set" };
  const alert = buildTestAutoMatchAlert(now, { fromName: alertAttribution(env).fromName, fromEmail: alertFromAddress(env), baseUrl: o.baseUrl, agedDays: o.agedDays });
  const result = await sendResendEmail(
    resendInputOf(alert, {
      from: alertFromHeader(env),
      replyTo: alertReplyTo(env),
      to: [TEST_ALERT_TO],
      cc: [],
      bcc: [],
      idempotencyKey: `automatch-alert-test:${now.toISOString()}`,
    }),
    { apiKey, fetch: o.fetch ?? fetch },
  );
  if (result.ok) return { ok: true, id: result.id };
  return { ok: false, error: result.error, status: result.status };
}

/**
 * Owners' preview (app/api/realty/automatch-alert and the Auto-Match Alert page). Owners only. GET renders only.
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
        sending: loaded.sending,
        hasTransport: loaded.hasTransport,
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

/** Owners' one-off test send. Always to TEST_ALERT_TO, never CC/BCC, works with the live flag off. */
export async function automatchAlertTestSendRoute(o: AutomatchOpts & { fetch?: SendFetch; now?: Date; baseUrl?: string } = {}): Promise<Response> {
  const env = o.env ?? runtimeEnv();
  const result = await sendTestAutoMatchAlert({ env, now: o.now, fetch: o.fetch, baseUrl: o.baseUrl });
  if (result.ok) return Response.json({ ok: true, id: result.id }, { headers: { "cache-control": "no-store" } });
  const status = result.error === "RESEND_API_KEY is not set" ? 503 : 502;
  return Response.json({ ok: false, error: result.error }, { status, headers: { "cache-control": "no-store" } });
}

export { BASELINE_CONFIRM, SEND_OFF, TEST_ALERT_TO, alertKey };
