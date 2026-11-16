import type { Env } from "../flow/env.ts";
import { appendHealthLog } from "./webhook-health-log.ts";
import { sendWebhookAlert, type AlertInput, type AlertKind, type AlertSend } from "./webhook-alert.ts";
import { readGapReport } from "./webhook-gap.ts";
import { autoResubscribeOn, readSubscription, RECONNECT_EVERY_MS, resubscribeWebhook, webhookHookUrl, type ResubscribeResult } from "./webhook-resubscribe.ts";
import { readWebhookStatus, writeWebhookStatus, type WebhookHealth, type WebhookState } from "./webhook-status.ts";

/**
 * The silence detector and the webhook's health state, run from the 10-minute poller (periskope-poll.ts) where the webhook
 * is configured. The rule is pure (evaluateWebhookHealth). The orchestration (checkWebhookHealth) turns it into a state,
 * runs at most one reconnect an hour while DOWN, sends one alert per transition, and journals every step.
 *
 * DOWN when the API's newest text message (from the poll's read-only GET) is more than the threshold ahead of the last
 * accepted webhook delivery. With no delivery yet, DOWN when that message is older than the threshold. No API messages
 * at all means UP (nothing to miss).
 */

/** 30 minutes. Pass another value in tests (or through PollOptions.silenceMs) rather than changing this. */
export const WEBHOOK_SILENCE_MS = 30 * 60_000;

/**
 * Pure. `latestApiAt` is the newest text message from someone else in the API's window. `lagMs` is that message's time minus
 * the last delivery (or its age when there has been no delivery). DOWN only when that lag is over the threshold.
 */
export function evaluateWebhookHealth(a: { now: Date; lastAcceptedAt: string | null; latestApiAt: string | null; thresholdMs?: number }): { state: WebhookState; lagMs: number | null } {
  const threshold = a.thresholdMs ?? WEBHOOK_SILENCE_MS;
  if (!a.latestApiAt) return { state: "UP", lagMs: null };
  const api = Date.parse(a.latestApiAt);
  if (!a.lastAcceptedAt) {
    const age = a.now.getTime() - api;
    return { state: age > threshold ? "DOWN" : "UP", lagMs: age };
  }
  const lag = api - Date.parse(a.lastAcceptedAt);
  return { state: lag > threshold ? "DOWN" : "UP", lagMs: lag };
}

export type HealthCheck = {
  root: string;
  env: Env;
  now: Date;
  apiKey: string;
  /** The newest text message the poll saw in the API (null: none in the window). */
  latestApiAt: string | null;
  silenceMs?: number;
  /** The webhook API and Resend. Tests pass a fake; production passes fetch. */
  fetch: typeof fetch;
};

export type HealthOutcome = {
  state: WebhookState;
  lagMs: number | null;
  reconnect: ResubscribeResult | null;
  alert: AlertKind | null;
};

/** The health checks read and write webhook-status.json's health block: one at a time, so neither overwrites the other. */
let healthChain: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = healthChain.then(job, job);
  healthChain = run.catch(() => undefined);
  return run;
}

const freshHealth = (at: string): WebhookHealth => ({ state: "UP", lagMs: null, checkedAt: at, downSince: null, pendingAlert: null, lastReconnectAt: null, lastReconnect: null, gap: null });

export function checkWebhookHealth(c: HealthCheck): Promise<HealthOutcome> {
  return serial(() => checkWebhookHealthNow(c));
}

/** How often the subscription watchdog GETs /v1/webhooks (on its own timer, not the 10-minute poll). */
export const SUBSCRIPTION_CHECK_MS = 2 * 60_000;

export type SubscriptionCheck = { root: string; env: Env; now: Date; apiKey: string; fetch: typeof fetch };
export type SubscriptionOutcome = { state: "subscribed" | "paused" | "missing" | "unknown"; reconnect: ResubscribeResult | null; deferred: string | null };

/**
 * The subscription watchdog: GET our row from /v1/webhooks and, when Periskope has paused it (or it is gone), resume it
 * with the same reconnect as the silence detector: at most one attempt an hour (shared lastReconnectAt), the kill
 * switch honoured, and an email to Miles on each attempt. Reads and journals only when the state changes, so a healthy
 * subscription costs one GET and writes nothing. Never throws.
 */
export function checkSubscription(c: SubscriptionCheck): Promise<SubscriptionOutcome> {
  return serial(() => checkSubscriptionNow(c));
}

async function checkSubscriptionNow(c: SubscriptionCheck): Promise<SubscriptionOutcome> {
  const at = c.now.toISOString();
  const hookUrl = webhookHookUrl(c.env);
  const read = await readSubscription({ apiKey: c.apiKey, hookUrl, fetch: c.fetch });
  const state = read.ok ? read.state : "unknown";
  const status = readWebhookStatus(c.root);
  const health: WebhookHealth = { ...(status.health ?? freshHealth(at)) };
  const prev = health.subscription?.state ?? null;
  health.subscription = { checkedAt: at, state, ...(read.ok ? {} : { code: read.code }) };
  if (prev !== state) appendHealthLog(c.root, c.now, { type: "subscription", state, prev, ...(read.ok ? {} : { code: read.code }) });

  let reconnect: ResubscribeResult | null = null;
  let deferred: string | null = null;
  if (state === "paused" || state === "missing") {
    const due = !health.lastReconnectAt || c.now.getTime() - Date.parse(health.lastReconnectAt) >= RECONNECT_EVERY_MS;
    if (!autoResubscribeOn(c.env)) deferred = "switched off";
    else if (!due) deferred = "hourly limit";
    if (deferred) {
      if (prev !== state) appendHealthLog(c.root, c.now, { type: "reconnect_deferred", reason: deferred });
    } else {
      health.lastReconnectAt = at;
      reconnect = await resubscribeWebhook({ apiKey: c.apiKey, hookUrl, fetch: c.fetch });
      const action = reconnect.ok ? reconnect.action : `failed: ${reconnect.code}`;
      health.lastReconnect = { at, ok: reconnect.ok, action };
      appendHealthLog(c.root, c.now, reconnect.ok ? { type: "reconnect", ok: true, action: reconnect.action } : { type: "reconnect", ok: false, action: "failed", code: reconnect.code });
      if (reconnect.ok && reconnect.action !== "already_subscribed") health.subscription = { checkedAt: at, state: "subscribed" };
      const input: AlertInput = { kind: "unsubscribed", lagMs: health.lagMs, lastAcceptedAt: status.lastAcceptedAt, incidentSince: null, reconnect: action, gap: readGapReport(c.root) };
      const r = await sendWebhookAlert({ env: c.env, fetch: c.fetch, input, incidentKey: at });
      if ("skipped" in r) appendHealthLog(c.root, c.now, { type: "alert_skipped", kind: "unsubscribed", reason: r.skipped });
      else if (r.ok) appendHealthLog(c.root, c.now, { type: "alert_sent", kind: "unsubscribed" });
      else appendHealthLog(c.root, c.now, { type: "alert_failed", kind: "unsubscribed", code: r.code });
    }
  }
  if (prev !== health.subscription.state || reconnect || !status.health) {
    const latest = readWebhookStatus(c.root);
    const base = latest.health ?? health;
    writeWebhookStatus(c.root, { ...latest, health: { ...base, subscription: health.subscription, lastReconnectAt: health.lastReconnectAt, lastReconnect: health.lastReconnect } });
  }
  return { state, reconnect, deferred };
}

async function checkWebhookHealthNow(c: HealthCheck): Promise<HealthOutcome> {
  const status = readWebhookStatus(c.root);
  const prev = status.health ?? null;
  const prevState: WebhookState = prev?.state ?? "UP";
  const at = c.now.toISOString();
  const ev = evaluateWebhookHealth({ now: c.now, lastAcceptedAt: status.lastAcceptedAt, latestApiAt: c.latestApiAt, thresholdMs: c.silenceMs });
  appendHealthLog(c.root, c.now, { type: "detect", state: ev.state, prev: prevState, lagMs: ev.lagMs });

  const health: WebhookHealth = prev
    ? { ...prev, state: ev.state, lagMs: ev.lagMs, checkedAt: at }
    : { ...freshHealth(at), state: ev.state, lagMs: ev.lagMs };
  const incidentSince = prev?.downSince ?? null;
  let reconnect: ResubscribeResult | null = null;

  if (ev.state === "DOWN") {
    if (prevState === "UP") {
      health.downSince = at;
      health.pendingAlert = "down";
    }
    const due = !health.lastReconnectAt || c.now.getTime() - Date.parse(health.lastReconnectAt) >= RECONNECT_EVERY_MS;
    if (autoResubscribeOn(c.env) && due) {
      health.lastReconnectAt = at;
      reconnect = await resubscribeWebhook({ apiKey: c.apiKey, hookUrl: webhookHookUrl(c.env), fetch: c.fetch });
      const action = reconnect.ok ? reconnect.action : `failed: ${reconnect.code}`;
      health.lastReconnect = { at, ok: reconnect.ok, action };
      appendHealthLog(c.root, c.now, reconnect.ok ? { type: "reconnect", ok: true, action: reconnect.action } : { type: "reconnect", ok: false, action: "failed", code: reconnect.code });
    }
  } else if (prevState === "DOWN") {
    health.downSince = null;
    health.pendingAlert = "up";
  }

  // One email per transition. A reconnect attempt that happens on a DOWN tick is folded into that tick's DOWN email; on a
  // later tick (the DOWN email already went out) it gets its own email. A failed send stays pending and is retried next poll.
  let alert: AlertKind | null = null;
  if (health.pendingAlert) alert = health.pendingAlert;
  else if (reconnect) alert = "reconnect";

  if (alert) {
    const input: AlertInput = {
      kind: alert,
      lagMs: ev.lagMs,
      lastAcceptedAt: status.lastAcceptedAt,
      incidentSince,
      reconnect: reconnect ? (reconnect.ok ? reconnect.action : `failed: ${reconnect.code}`) : null,
      gap: readGapReport(c.root),
    };
    const incidentKey = alert === "reconnect" ? at : (incidentSince ?? at);
    const r: AlertSend = await sendWebhookAlert({ env: c.env, fetch: c.fetch, input, incidentKey });
    let done = false;
    if ("skipped" in r) {
      appendHealthLog(c.root, c.now, { type: "alert_skipped", kind: alert, reason: r.skipped });
      done = true;
    } else if (r.ok) {
      appendHealthLog(c.root, c.now, { type: "alert_sent", kind: alert });
      done = true;
    } else {
      appendHealthLog(c.root, c.now, { type: "alert_failed", kind: alert, code: r.code });
    }
    // A DOWN or recovery email is done once it went out (or there is no Resend key to send it with). A failed send stays
    // pending and is tried again on the next poll; the journal above records each try.
    if (alert !== "reconnect" && done) health.pendingAlert = null;
  }

  // Re-read before writing: a delivery can have been accepted while the reconnect was in flight.
  const latest = readWebhookStatus(c.root);
  writeWebhookStatus(c.root, { ...latest, health: { ...health, gap: latest.health?.gap ?? null, subscription: latest.health?.subscription ?? null } });
  return { state: ev.state, lagMs: ev.lagMs, reconnect, alert };
}
