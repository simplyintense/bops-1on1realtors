import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimeEnv, type Env } from "../flow/env.ts";
import { backfillGroup, getJson, startTimeDaysAgo } from "./periskope-backfill.ts";
import {
  codeOf,
  discoverGroups,
  discoveryDue,
  ensureOwnerWaiver,
  FIRST_BACKFILL_DAYS,
  type AddedGroup,
} from "./periskope-discover.ts";
import { pollGroups } from "./periskope-groups.ts";
import { PeriskopeStore } from "./periskope-store.ts";
import { periskopeRoot } from "./periskope-root.ts";
import { exclusive, flushWebhookInbox } from "./periskope-intake.ts";
import { checkSubscription, checkWebhookHealth, SUBSCRIPTION_CHECK_MS } from "./webhook-health.ts";
import { GAP_EVERY_MS, runGapReport } from "./webhook-gap.ts";
import { sweepMedia } from "./listing-media.ts";
import { syncAutoMatchAlertsSafely } from "./automatch-alert.ts";
import { syncFromJsonl, type SyncResult } from "./search-store.ts";

/**
 * Read-only live observation: GET new messages for the pinned groups and the auto-discovered ones every 10
 * minutes, then push each through ingestEvent (parse, dedupe by message_id, supply/demand store, very-strong
 * alerts). Once an hour it also lists the groups (periskope-discover.ts) and auto-adds real-estate ones.
 * It never sends, flags, or replies to WhatsApp. Its only writes to Periskope are the webhook reconnect
 * (webhook-resubscribe.ts): when the webhook is DOWN, a PATCH or POST for OUR hook URL's message.created row, at most
 * once an hour. Every 10 minutes it also retries the durable webhook inbox (webhook-inbox.ts), checks the webhook's
 * silence (webhook-health.ts), and once an hour runs the read-only gap report (webhook-gap.ts). The API key is read
 * from PERISKOPE_API_KEY or a 0600 key file (PERISKOPE_API_KEY_FILE, or `<root>/.api-key`); it is never logged.
 */

export const POLL_EVERY_MS = 10 * 60_000;
export const DEFAULT_PHONE_ID = "phone-cykqswyyyicimtti";
const OVERLAP_MS = 2 * 60_000;
/**
 * Every poll re-reads at least the last hour of each group, however new the newest stored post is. The newest post can
 * be newer than messages we don't have yet (a webhook delivery that arrived first, or a message the API listed late),
 * and a window starting at the newest post would skip those for good. Already-seen messages are cheap no-ops.
 */
export const POLL_LOOKBACK_FLOOR_MS = 60 * 60_000;

export type PollGroupResult = {
  chatId: string;
  chatName: string;
  fetched: number;
  added: number;
  refilled: number;
  unchanged: number;
  ignored: number;
  dropped: number;
  alertsAdded: number;
  error?: string;
};

export type PollResult = {
  at: string;
  ok: boolean;
  reason?: string;
  groups: PollGroupResult[];
  fetched: number;
  added: number;
  alertsAdded: number;
  /** Groups auto-added by this poll's discovery (names and ids only). */
  groupsAdded: AddedGroup[];
  /** This poll's discovery attempt, if one was due. A code on failure, never a message. */
  discovery?: { ran: true; ok: true; checked: number } | { ran: true; ok: false; code: string } | { ran: false };
  /** The search index rebuild after this poll. Counts only; a failure here never fails the poll. */
  searchSync?: { ok: true; counts: SyncResult } | { ok: false; code: string };
  /** The webhook's health after this poll, where the webhook is configured and the API answered (webhook-health.ts). */
  health?: { state: "UP" | "DOWN"; lagMs: number | null };
};

type Cursor = { lastRunAt: string | null; lastDiscoveryAt: string | null; lastGapAt: string | null; byChat: Record<string, { lastSentAt: string | null }> };

export type PollOptions = {
  apiKey?: string;
  keyFile?: string;
  phoneId?: string;
  root?: string;
  env?: Env;
  now?: () => Date;
  fetcher?: typeof getJson;
  /** Tests pass null so a live CRM on the machine is not used. */
  crm?: null;
  /** The webhook API (reconnect) and Resend (alerts). Tests pass a fake; unset is the global fetch. */
  webhookFetch?: typeof fetch;
  /** The silence threshold. Unset: WEBHOOK_SILENCE_MS (30 minutes). */
  silenceMs?: number;
};

function keyFileCandidates(root: string, env: Env, explicit?: string): string[] {
  return [explicit, env.PERISKOPE_API_KEY_FILE, join(root, ".api-key")].filter((p): p is string => !!p && p.trim().length > 0);
}

/** The Periskope API key, or empty. Never log the return value. */
export function readApiKey(opts: { apiKey?: string; keyFile?: string; root?: string; env?: Env } = {}): string {
  const env = opts.env ?? runtimeEnv();
  const fromEnv = (opts.apiKey ?? env.PERISKOPE_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const root = opts.root ?? periskopeRoot(env);
  for (const path of keyFileCandidates(root, env, opts.keyFile)) {
    try {
      if (existsSync(path)) {
        const v = readFileSync(path, "utf8").trim();
        if (v) return v;
      }
    } catch {
      /* missing or unreadable: try the next */
    }
  }
  return "";
}

function cursorPath(root: string): string {
  return join(root, "poll-cursor.json");
}

function loadCursor(root: string): Cursor {
  try {
    const j = JSON.parse(readFileSync(cursorPath(root), "utf8")) as Cursor;
    if (j && typeof j === "object") return { lastRunAt: j.lastRunAt ?? null, lastDiscoveryAt: j.lastDiscoveryAt ?? null, lastGapAt: j.lastGapAt ?? null, byChat: j.byChat ?? {} };
  } catch {}
  return { lastRunAt: null, lastDiscoveryAt: null, lastGapAt: null, byChat: {} };
}

function saveCursor(root: string, cursor: Cursor): void {
  mkdirSync(dirname(cursorPath(root)), { recursive: true, mode: 0o700 });
  writeFileSync(cursorPath(root), `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 });
}

function iso(d: Date): string {
  return d.toISOString();
}

function startTimeFor(store: PeriskopeStore, chatId: string, cursor: Cursor, now: Date): string {
  const fromCursor = cursor.byChat[chatId]?.lastSentAt;
  const latest = store
    .posts()
    .filter((p) => p.chatId === chatId && p.sentAt)
    .map((p) => p.sentAt)
    .sort()
    .at(-1);
  const raw = fromCursor && latest ? (fromCursor > latest ? fromCursor : latest) : fromCursor || latest;
  const floor = now.getTime() - POLL_LOOKBACK_FLOOR_MS;
  if (raw) return iso(new Date(Math.min(new Date(raw).getTime() - OVERLAP_MS, floor)));
  return iso(new Date(floor));
}

/** Groups new to the store (no cursor, no posts): the first fetch covers the last seven days. */
function isFirstFetch(store: PeriskopeStore, chatId: string, cursor: Cursor): boolean {
  return !cursor.byChat[chatId] && !store.posts().some((p) => p.chatId === chatId);
}

function emptyGroup(chatId: string, chatName: string, error?: string): PollGroupResult {
  return { chatId, chatName, fetched: 0, added: 0, refilled: 0, unchanged: 0, ignored: 0, dropped: 0, alertsAdded: 0, ...(error ? { error } : {}) };
}

export async function pollOnce(opts: PollOptions = {}): Promise<PollResult> {
  const env = { ...runtimeEnv(), ...(opts.env ?? {}) };
  const root = opts.root ?? periskopeRoot(env);
  const at = opts.now?.() ?? new Date();
  const apiKey = readApiKey({ apiKey: opts.apiKey, keyFile: opts.keyFile, root, env });
  if (!apiKey) {
    return { at: iso(at), ok: false, reason: "no API key", groups: [], fetched: 0, added: 0, alertsAdded: 0, groupsAdded: [] };
  }
  const phoneId = (opts.phoneId ?? env.PERISKOPE_PHONE_ID ?? DEFAULT_PHONE_ID).trim() || undefined;
  // The webhook checks (health, gap report) run only where the webhook is configured: a signing key is set.
  const webhookOn = (env.PERISKOPE_SIGNING_KEY ?? "").trim() !== "";
  // Retry the queued webhook deliveries first. A delivery that failed earlier is still in the durable inbox.
  try {
    await flushWebhookInbox({ root, env, now: () => at, crm: opts.crm });
  } catch {
    /* never fails the poll */
  }
  const store = new PeriskopeStore(root);
  const cursor = loadCursor(root);
  const fetcher = opts.fetcher ?? getJson;
  const intake = { root, env, now: () => at, crm: opts.crm };
  const groups: PollGroupResult[] = [];
  let fetched = 0;
  let added = 0;
  let alertsAdded = 0;
  // The newest text message from someone else across the groups this poll read (the silence check's input).
  let latestApiAt: string | null = null;
  let apiAnswered = 0;

  // Discovery first, so a group added now is polled in this same run. Throttled to once an hour; a failure
  // (or a thrown error) is logged as a code and never stops the poll.
  let groupsAdded: AddedGroup[] = [];
  let discovery: PollResult["discovery"] = { ran: false };
  if (discoveryDue(cursor.lastDiscoveryAt, at)) {
    cursor.lastDiscoveryAt = iso(at);
    try {
      const d = await discoverGroups({ apiKey, phoneId, fetcher, intake });
      if (d.ok) {
        groupsAdded = d.added;
        discovery = { ran: true, ok: true, checked: d.checked };
      } else {
        discovery = { ran: true, ok: false, code: d.code };
      }
    } catch (e) {
      discovery = { ran: true, ok: false, code: codeOf(e) };
    }
  }

  for (const g of pollGroups(root, env)) {
    // Consent before any fetch: the ingest gate drops a group with no record. Pinned groups without one (e.g.
    // Co-Broke) get the owner waiver here, the same as a newly discovered group.
    try {
      await ensureOwnerWaiver(root, g.chatId, g.chatName, intake);
    } catch (e) {
      groups.push(emptyGroup(g.chatId, g.chatName, `consent:${codeOf(e)}`));
      continue;
    }
    const startTime = isFirstFetch(store, g.chatId, cursor)
      ? startTimeDaysAgo(FIRST_BACKFILL_DAYS, at)
      : startTimeFor(store, g.chatId, cursor, at);
    const beforeIds = new Set(new PeriskopeStore(root).posts().map((p) => p.messageId));
    const alertsBefore = new PeriskopeStore(root).alerts().length;
    const listed = await backfillGroup({
      apiKey,
      chatId: g.chatId,
      chatName: g.chatName,
      startTime,
      phoneId,
      fetcher,
      opts: { root, env, now: () => at, crm: opts.crm },
    });
    if (!listed.ok) {
      groups.push(emptyGroup(g.chatId, g.chatName, listed.error));
      continue;
    }
    apiAnswered += 1;
    if (listed.latestAt && (!latestApiAt || listed.latestAt > latestApiAt)) latestApiAt = listed.latestAt;
    const afterStore = new PeriskopeStore(root);
    const newAlerts = Math.max(0, afterStore.alerts().length - alertsBefore);
    const addedNow = afterStore.posts().filter((p) => !beforeIds.has(p.messageId)).length;
    const row: PollGroupResult = {
      chatId: g.chatId,
      chatName: g.chatName,
      fetched: listed.counts.fetched,
      added: addedNow,
      refilled: listed.counts.refilled,
      unchanged: Math.max(0, listed.counts.fetched - addedNow - listed.counts.ignored - listed.counts.dropped),
      ignored: listed.counts.ignored,
      dropped: listed.counts.dropped,
      alertsAdded: newAlerts,
    };
    groups.push(row);
    fetched += row.fetched;
    added += row.added;
    alertsAdded += row.alertsAdded;
    const latest = store
      .posts()
      .filter((p) => p.chatId === g.chatId && p.sentAt)
      .map((p) => p.sentAt)
      .sort()
      .at(-1) ?? cursor.byChat[g.chatId]?.lastSentAt ?? iso(at);
    cursor.byChat[g.chatId] = { lastSentAt: latest };
  }
  cursor.lastRunAt = iso(at);

  // Webhook health (where the webhook is configured, and only if the API answered this poll): the silence check, then the
  // hourly gap report. Read-only against Periskope; a failure here never fails the poll.
  let health: PollResult["health"];
  if (webhookOn && apiAnswered > 0) {
    const webhookFetch = opts.webhookFetch ?? fetch;
    try {
      const h = await checkWebhookHealth({ root, env, now: at, apiKey, latestApiAt, silenceMs: opts.silenceMs, fetch: webhookFetch });
      health = { state: h.state, lagMs: h.lagMs };
    } catch (e) {
      console.error(JSON.stringify({ webhookHealth: "error", code: (e as { code?: string }).code ?? (e as Error).name }));
    }
    const gapDue = !cursor.lastGapAt || at.getTime() - Date.parse(cursor.lastGapAt) >= GAP_EVERY_MS;
    if (gapDue) {
      cursor.lastGapAt = iso(at);
      try {
        await runGapReport({ root, env, now: at, apiKey, fetcher, phoneId });
      } catch (e) {
        console.error(JSON.stringify({ webhookGap: "error", code: (e as { code?: string }).code ?? (e as Error).name }));
      }
    }
  }
  saveCursor(root, cursor);
  // The poller is the only scheduled loop on the hosted app, so it also runs the 180-day listing-photo sweep.
  // Never fail the poll for it.
  try {
    await exclusive(() => sweepMedia(new PeriskopeStore(root), at));
  } catch {}
  // Seed or dispatch Auto-Match Alerts (never sends while AUTOMATCH_ALERT_ENABLED is off). Never fail the poll for it.
  try {
    await syncAutoMatchAlertsSafely({ root, env, now: at });
  } catch {}
  return { at: iso(at), ok: true, groups, fetched, added, alertsAdded, groupsAdded, discovery, searchSync: searchSyncSafely(root), ...(health ? { health } : {}) };
}

/** Rebuilds <root>/search.db from the JSONL when it changed. Never throws: the poll must not fail on the index. */
function searchSyncSafely(root: string): NonNullable<PollResult["searchSync"]> {
  try {
    return { ok: true, counts: syncFromJsonl(root) };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? (e as Error).name };
  }
}

const g = globalThis as typeof globalThis & {
  __bopsPeriskopePoll?: ReturnType<typeof setInterval>;
  __bopsPeriskopePollKick?: ReturnType<typeof setTimeout>;
  __bopsWebhookWatch?: ReturnType<typeof setInterval>;
};

/**
 * One subscription-watchdog tick (see checkSubscription): only where the webhook is configured and an API key is set.
 * Logs a line only when the subscription is not live or the check failed. Never throws.
 */
export async function watchSubscriptionOnce(opts: PollOptions = {}): Promise<void> {
  try {
    const env = { ...runtimeEnv(), ...(opts.env ?? {}) };
    if ((env.PERISKOPE_SIGNING_KEY ?? "").trim() === "") return;
    const root = opts.root ?? periskopeRoot(env);
    const apiKey = readApiKey({ apiKey: opts.apiKey, keyFile: opts.keyFile, root, env });
    if (!apiKey) return;
    const r = await checkSubscription({ root, env, now: opts.now?.() ?? new Date(), apiKey, fetch: opts.webhookFetch ?? fetch });
    if (r.state !== "subscribed" || r.reconnect) {
      console.log(JSON.stringify({ webhookSubscription: r.state, reconnect: r.reconnect ? (r.reconnect.ok ? r.reconnect.action : `failed: ${r.reconnect.code}`) : null, deferred: r.deferred }));
    }
  } catch (e) {
    console.error(JSON.stringify({ webhookSubscription: "error", code: (e as { code?: string }).code ?? (e as Error).name }));
  }
}

/** Start the 10-minute GET poller once per process. No-op without a key on the first cycle. First cycle runs shortly after start. */
export function startPeriskopePoller(opts: PollOptions = {}): void {
  if (g.__bopsPeriskopePoll) return;
  const run = () => {
    void pollOnce(opts)
      .then((r) => {
        if (!r.ok) {
          console.log(JSON.stringify({ periskopePoll: r.reason ?? "skipped", at: r.at }));
          return;
        }
        console.log(JSON.stringify({
          periskopePoll: "ok",
          at: r.at,
          fetched: r.fetched,
          added: r.added,
          alertsAdded: r.alertsAdded,
          webhook: r.health ?? null,
          search: r.searchSync?.ok ? { supply: r.searchSync.counts.supply, demand: r.searchSync.counts.demand, needsExplanation: r.searchSync.counts.needsExplanation, rebuilt: r.searchSync.counts.rebuilt } : (r.searchSync ?? null),
          discovery: r.discovery ?? null,
          groupsAdded: r.groupsAdded.map((x) => ({ group: x.group, chatId: x.chatId, members: x.members, source: x.source })),
          groups: r.groups.map((x) => ({ group: x.chatName, fetched: x.fetched, added: x.added, unchanged: x.unchanged, alertsAdded: x.alertsAdded, error: x.error ?? null })),
        }));
      })
      .catch((e: Error) => console.error(JSON.stringify({ periskopePoll: "error", error: e.message })));
  };
  g.__bopsPeriskopePollKick = setTimeout(run, 5_000);
  g.__bopsPeriskopePoll = setInterval(run, POLL_EVERY_MS);
  // The subscription watchdog runs on its own short timer, so a Periskope pause is caught in minutes, not when the
  // silence detector notices (30 minutes of missing messages). A tick still running skips the next one.
  let watching = false;
  const watch = () => {
    if (watching) return;
    watching = true;
    void watchSubscriptionOnce(opts).finally(() => {
      watching = false;
    });
  };
  setTimeout(watch, 20_000);
  g.__bopsWebhookWatch = setInterval(watch, SUBSCRIPTION_CHECK_MS);
}
