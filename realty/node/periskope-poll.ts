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
import { exclusive } from "./periskope-intake.ts";
import { sweepMedia } from "./listing-media.ts";
import { syncFromJsonl, type SyncResult } from "./search-store.ts";

/**
 * Read-only live observation: GET new messages for the pinned groups and the auto-discovered ones every 10
 * minutes, then push each through ingestEvent (parse, dedupe by message_id, supply/demand store, very-strong
 * alerts). Once an hour it also lists the groups (periskope-discover.ts) and auto-adds real-estate ones.
 * Never POST/PUT/PATCH/DELETE, and never sends, flags, or replies. The API key is read from
 * PERISKOPE_API_KEY or a 0600 key file (PERISKOPE_API_KEY_FILE, or `<root>/.api-key`); it is never logged.
 */

export const POLL_EVERY_MS = 10 * 60_000;
export const DEFAULT_PHONE_ID = "phone-cykqswyyyicimtti";
const OVERLAP_MS = 2 * 60_000;

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
};

type Cursor = { lastRunAt: string | null; lastDiscoveryAt: string | null; byChat: Record<string, { lastSentAt: string | null }> };

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
    if (j && typeof j === "object") return { lastRunAt: j.lastRunAt ?? null, lastDiscoveryAt: j.lastDiscoveryAt ?? null, byChat: j.byChat ?? {} };
  } catch {}
  return { lastRunAt: null, lastDiscoveryAt: null, byChat: {} };
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
  if (raw) return iso(new Date(new Date(raw).getTime() - OVERLAP_MS));
  return iso(new Date(now.getTime() - POLL_EVERY_MS));
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
  const store = new PeriskopeStore(root);
  const cursor = loadCursor(root);
  const fetcher = opts.fetcher ?? getJson;
  const intake = { root, env, now: () => at, crm: opts.crm };
  const groups: PollGroupResult[] = [];
  let fetched = 0;
  let added = 0;
  let alertsAdded = 0;

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
  saveCursor(root, cursor);
  // The poller is the only scheduled loop on the hosted app, so it also runs the 180-day listing-photo sweep.
  // Never fail the poll for it.
  try {
    await exclusive(() => sweepMedia(new PeriskopeStore(root), at));
  } catch {}
  return { at: iso(at), ok: true, groups, fetched, added, alertsAdded, groupsAdded, discovery, searchSync: searchSyncSafely(root) };
}

/** Rebuilds <root>/search.db from the JSONL when it changed. Never throws: the poll must not fail on the index. */
function searchSyncSafely(root: string): NonNullable<PollResult["searchSync"]> {
  try {
    return { ok: true, counts: syncFromJsonl(root) };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? (e as Error).name };
  }
}

const g = globalThis as typeof globalThis & { __bopsPeriskopePoll?: ReturnType<typeof setInterval>; __bopsPeriskopePollKick?: ReturnType<typeof setTimeout> };

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
}
