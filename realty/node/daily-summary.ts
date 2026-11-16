import { automatchRun, type AutomatchOpts, type AutomatchRow } from "./automatch.ts";
import { hasResendKey, resendApiKey, sendResendEmail, type SendFetch } from "./automatch-alert-resend.ts";
import { periskopeRoot } from "./periskope-root.ts";
import { PeriskopeStore } from "./periskope-store.ts";
import {
  TEST_ALERT_TO,
  officeEmail,
  scrubMailError,
  type AlertInput,
} from "../flow/automatch-alert.ts";
import { dayKeyAst } from "../flow/ast-time.ts";
import {
  SUMMARY_SEND_OFF,
  dailySummaryAt,
  dailySummaryDue,
  dailySummaryEnabled,
  dailySummaryFromEnv,
  enrichSummaryItems,
  summaryIdempotencyKey,
  summarySourceOf,
  type DailySummary,
  type DailySummarySentRow,
  type SummarySource,
} from "../flow/daily-summary.ts";
import { runtimeEnv, type Env } from "../flow/env.ts";
import type { SeamAgent } from "../flow/crm-seam.ts";

/**
 * Daily Auto-Match summary loader, test send, and morning dispatcher (realty/flow/daily-summary.ts builds the email).
 * Reads automatch-alert-sent.jsonl and current match data. The live morning send needs DAILY_SUMMARY_ENABLED and
 * RESEND_API_KEY, and goes out at most once per AST day. A --test-send always goes to TEST_ALERT_TO only and does not
 * record the day as sent.
 */

function asInput(row: AutomatchRow, agents: readonly SeamAgent[]): AlertInput {
  const email = row.listing.agentId != null ? (agents.find((a) => a.id === row.listing.agentId)?.email ?? null) : null;
  return { ...row, agentEmail: email };
}

function sourcesOf(pairs: readonly AutomatchRow[], agents: readonly SeamAgent[], office: string): SummarySource[] {
  const out: SummarySource[] = [];
  const seen = new Set<string>();
  for (const row of pairs) {
    const src = summarySourceOf(asInput(row, agents), office);
    if (!src) continue;
    const key = `${src.requestId}|${src.listingKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
  }
  return out;
}

export async function loadDailySummary(o: AutomatchOpts & { test?: boolean } = {}): Promise<DailySummary> {
  const env = o.env ?? runtimeEnv();
  const root = o.root ?? periskopeRoot(env);
  const now = o.now ?? new Date();
  const { result, agents } = await automatchRun({ ...o, env, root, now });
  const sent = new PeriskopeStore(root).automatchAlertSentRows();
  const sources = sourcesOf(result.pairs, agents, officeEmail(env));
  const items = enrichSummaryItems(sent, sources, now);
  return dailySummaryFromEnv(items, env, now, { test: o.test });
}

export type DailySummarySendResult =
  | { ok: true; id: string; duplicate?: boolean; summary: DailySummary; dayKey: string }
  | { ok: false; error: string; summary?: DailySummary; dayKey?: string };

async function deliverSummary(
  summary: DailySummary,
  o: { apiKey: string; fetch: SendFetch; idempotencyKey: string },
): Promise<{ ok: true; id: string; duplicate?: boolean } | { ok: false; error: string }> {
  const sent = await sendResendEmail(
    {
      from: summary.from,
      to: summary.to,
      cc: summary.cc,
      bcc: summary.bcc,
      replyTo: summary.replyTo,
      subject: summary.subject,
      text: summary.text,
      html: summary.html,
      idempotencyKey: o.idempotencyKey,
    },
    { apiKey: o.apiKey, fetch: o.fetch },
  );
  if (sent.ok) return { ok: true, id: sent.id, duplicate: sent.duplicate };
  return { ok: false, error: sent.error };
}

/**
 * One [TEST] summary to TEST_ALERT_TO only, with no CC or BCC. Works while DAILY_SUMMARY_ENABLED is off. Does not
 * record the day as sent.
 */
export async function sendTestDailySummary(
  o: AutomatchOpts & { fetch?: SendFetch; now?: Date } = {},
): Promise<DailySummarySendResult> {
  const env = o.env ?? runtimeEnv();
  const now = o.now ?? new Date();
  const summary = await loadDailySummary({ ...o, env, now, test: true });
  const key = resendApiKey(env);
  if (!key) return { ok: false, error: "RESEND_API_KEY is not set", summary, dayKey: dayKeyAst(now) };
  const delivered = await deliverSummary(summary, {
    apiKey: key,
    fetch: o.fetch ?? fetch,
    idempotencyKey: `daily-summary-test:${now.toISOString()}`.replace(/[^A-Za-z0-9._:-]+/g, "-").slice(0, 256),
  });
  if (!delivered.ok) return { ok: false, error: delivered.error, summary, dayKey: dayKeyAst(now) };
  return { ok: true, id: delivered.id, duplicate: delivered.duplicate, summary, dayKey: dayKeyAst(now) };
}

export type TickResult =
  | { action: "disabled" }
  | { action: "not-due"; dayKey: string; at: string }
  | { action: "already-sent"; dayKey: string; id: string }
  | { action: "no-transport"; dayKey: string }
  | { action: "sent"; dayKey: string; id: string; alerts: number }
  | { action: "failed"; dayKey: string; error: string };

function lastSentDay(store: PeriskopeStore, dayKey: string): DailySummarySentRow | null {
  const rows = store.dailySummarySentRows();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].dayKey === dayKey) return rows[i];
  }
  return null;
}

/**
 * One scheduler tick: send today's summary if the flag is on, the clock is at or after the morning time, and today has
 * not already been recorded. A successful send (or a Resend idempotent replay) is the only thing that records the day.
 */
export async function tickDailySummary(o: AutomatchOpts & { fetch?: SendFetch; now?: Date } = {}): Promise<TickResult> {
  const env = o.env ?? runtimeEnv();
  const now = o.now ?? new Date();
  const dayKey = dayKeyAst(now);
  if (!dailySummaryEnabled(env)) return { action: "disabled" };
  const root = o.root ?? periskopeRoot(env);
  const store = new PeriskopeStore(root);
  const existing = dayKey ? lastSentDay(store, dayKey) : null;
  if (existing) return { action: "already-sent", dayKey, id: existing.id };
  const at = dailySummaryAt(env);
  if (!dailySummaryDue(now, { enabled: true, lastDay: null, at })) {
    return { action: "not-due", dayKey, at };
  }
  if (!hasResendKey(env)) return { action: "no-transport", dayKey };
  const summary = await loadDailySummary({ ...o, env, root, now });
  const delivered = await deliverSummary(summary, {
    apiKey: resendApiKey(env)!,
    fetch: o.fetch ?? fetch,
    idempotencyKey: summaryIdempotencyKey(dayKey),
  });
  if (!delivered.ok) return { action: "failed", dayKey, error: scrubMailError(delivered.error) };
  store.recordDailySummarySent({ dayKey, at: now.toISOString(), id: delivered.id });
  return { action: "sent", dayKey, id: delivered.id, alerts: summary.alerts };
}

/** Never throws: the poll and the scheduler must not fail on the summary. */
export async function tickDailySummarySafely(o: AutomatchOpts & { fetch?: SendFetch; now?: Date } = {}): Promise<TickResult | { action: "error"; error: string }> {
  try {
    return await tickDailySummary(o);
  } catch (e) {
    return { action: "error", error: scrubMailError((e as Error).message ?? String(e)) };
  }
}

const g = globalThis as typeof globalThis & {
  __bopsDailySummary?: ReturnType<typeof setInterval>;
  __bopsDailySummaryKick?: ReturnType<typeof setTimeout>;
  __bopsDailySummaryRunning?: boolean;
};

export const SUMMARY_CHECK_MS = 60_000;

/** Start the one-minute morning-summary check once per process. First tick shortly after start. */
export function startDailySummaryScheduler(opts: AutomatchOpts = {}): void {
  if (g.__bopsDailySummary) return;
  const run = () => {
    if (g.__bopsDailySummaryRunning) return;
    g.__bopsDailySummaryRunning = true;
    void tickDailySummarySafely(opts)
      .then((r) => {
        if (r.action === "sent") console.log(JSON.stringify({ dailySummary: "sent", alerts: r.alerts, dayKey: r.dayKey }));
        else if (r.action === "failed" || r.action === "error") console.error(JSON.stringify({ dailySummary: r.action, error: "error" in r ? r.error : undefined }));
      })
      .finally(() => {
        g.__bopsDailySummaryRunning = false;
      });
  };
  g.__bopsDailySummaryKick = setTimeout(run, 20_000);
  g.__bopsDailySummary = setInterval(run, SUMMARY_CHECK_MS);
}

export { SUMMARY_SEND_OFF, TEST_ALERT_TO };
