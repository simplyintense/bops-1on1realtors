import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { dayKeyAst } from "../flow/ast-time.ts";
import { bearerOk, type Env } from "./agent-search.ts";
import { openSearchDb, SEARCH_DB } from "./search-store.ts";

/**
 * The weekly usage report's numbers, read by the 1on1 CRM's Monday job through GET /api/mcp/stats (app/api/mcp/stats/route.ts,
 * the handler is mcpStats). Read-only, deterministic: SQL and JS only, no AI, no network, no sync from the JSONL.
 *
 * Weeks run Monday to Monday in AST (America/Port_of_Spain, UTC-4 all year, no DST). On a Monday the report covers the Mon–Sun
 * week just ended (current) against the week before it (prior). Labels: "Market Search" (staff web searches, the
 * realty_search_events log), "Market Listings" (the supply table), "Search Backend" (the database and its volume).
 *
 * Nothing here returns group names, chat ids, phone numbers, message ids or original text: the listings are counted, and the
 * web searches are counted by the signed-in email (or "unknown").
 */

export const STATS_TIMEZONE = "America/Port_of_Spain";
export const DEFAULT_VOLUME_QUOTA_MB = 3072;
const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
/** AST is UTC-4 year-round. */
const AST_OFFSET_MS = 4 * 60 * 60 * 1000;
const MIB = 1024 * 1024;
const UNKNOWN = "unknown";

export type Daily = { date: string; count: number };
export type WeekWindows = { priorStart: Date; currentStart: Date; currentEnd: Date };
export type AgentWeek = { email: string; current7d: number; prior7d: number; pctChange: number | null };
export type UsageStats = {
  generatedAt: string;
  timezone: typeof STATS_TIMEZONE;
  db: { sizeBytes: number; sizeMb: number; volumeQuotaMb: number; percentUsed: number };
  health: { ok: true; lastIngestAt: string | null };
  listings: { total: number; current7d: number; prior7d: number; pctChange: number | null; daily: Daily[] };
  webSearches: { current7d: number; prior7d: number; pctChange: number | null; activeAgents7d: number; daily: Daily[]; byAgent: AgentWeek[] };
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Week-over-week change in percent, rounded. A prior of 0 has no percent: 0 to 0 is 0, and 0 to N is null ("New" in the email).
 */
export function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return Math.round(((current - prior) / prior) * 100);
}

/**
 * The three Monday 00:00 AST instants for a report at `now`. currentEnd is the most recent Monday 00:00 AST that is <= now, so a
 * Monday 08:30 AST report covers the week that ended at that Monday. currentStart and priorStart are 7 and 14 days before it.
 */
export function weekWindows(now: Date): WeekWindows {
  // AST wall clock, read with the UTC getters (AST has no DST, so a fixed offset is exact).
  const ast = new Date(now.getTime() - AST_OFFSET_MS);
  const sinceMonday = (ast.getUTCDay() + 6) % 7;
  const monday = Date.UTC(ast.getUTCFullYear(), ast.getUTCMonth(), ast.getUTCDate() - sinceMonday) + AST_OFFSET_MS;
  return {
    priorStart: new Date(monday - 2 * WEEK_DAYS * DAY_MS),
    currentStart: new Date(monday - WEEK_DAYS * DAY_MS),
    currentEnd: new Date(monday),
  };
}

/** The 14 AST calendar dates of the two windows, oldest first: priorStart (inclusive) to currentEnd (exclusive). */
export function dailyDates(w: WeekWindows): string[] {
  return Array.from({ length: 2 * WEEK_DAYS }, (_, i) => dayKeyAst(new Date(w.priorStart.getTime() + i * DAY_MS)));
}

/** Bytes on disk for search.db, its WAL and its shared-memory file (each 0 when missing). */
export function dbSizeBytes(root: string): number {
  let total = 0;
  for (const name of [SEARCH_DB, `${SEARCH_DB}-wal`, `${SEARCH_DB}-shm`]) {
    try {
      total += statSync(join(root, name)).size;
    } catch {
      /* missing (or gone between the check and the read): counts as 0 */
    }
  }
  return total;
}

/** SEARCH_DB_QUOTA_MB when it is a positive number, else the 3072 MB default (the 3 GB volume). */
export function volumeQuotaMb(env: Env): number {
  const n = Number(env.SEARCH_DB_QUOTA_MB);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_VOLUME_QUOTA_MB;
}

/** Which window an instant falls in: current [currentStart, currentEnd), prior [priorStart, currentStart), or neither. */
function windowOf(t: number, w: WeekWindows): "current" | "prior" | null {
  if (t >= w.currentStart.getTime() && t < w.currentEnd.getTime()) return "current";
  if (t >= w.priorStart.getTime() && t < w.currentStart.getTime()) return "prior";
  return null;
}

/** Counts of ISO instants per window, plus the 14 daily buckets (AST dates). Instants outside both windows are ignored. */
function tally(times: string[], w: WeekWindows): { current: number; prior: number; daily: Daily[] } {
  const days = dailyDates(w);
  const perDay = new Map<string, number>(days.map((d) => [d, 0]));
  let current = 0;
  let prior = 0;
  for (const iso of times) {
    const t = Date.parse(iso);
    const win = windowOf(t, w);
    if (!win) continue;
    if (win === "current") current++;
    else prior++;
    const day = dayKeyAst(new Date(t));
    if (perDay.has(day)) perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  return { current, prior, daily: days.map((date) => ({ date, count: perDay.get(date) ?? 0 })) };
}

/** The agent key of a search event: its signed-in email, or "unknown" when there is none. */
const agentKey = (email: string | null | undefined): string => email?.trim() || UNKNOWN;

/** The newest last_sent_at across supply, demand and needs-explanation (ISO), or null when there are none or it is unreadable. */
function lastIngestAt(db: ReturnType<typeof openSearchDb>): string | null {
  try {
    const row = db
      .prepare(
        "SELECT MAX(t) AS t FROM (SELECT last_sent_at AS t FROM supply UNION ALL SELECT last_sent_at AS t FROM demand UNION ALL SELECT last_sent_at AS t FROM needs_explanation)",
      )
      .get() as { t: string | null } | undefined;
    const ms = row?.t ? Date.parse(row.t) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * The usage report body. Opens <root>/search.db (no sync) and closes it. Throws only when the database cannot be opened or read;
 * mcpStats turns that into a 503.
 */
export function usageStats(root: string, env: Env, now: Date = new Date()): UsageStats {
  const w = weekWindows(now);
  const from = w.priorStart.toISOString();
  const to = w.currentEnd.toISOString();
  const quota = volumeQuotaMb(env);
  const db = openSearchDb(root);
  try {
    const listingsTotal = (db.prepare("SELECT COUNT(*) AS n FROM supply").get() as { n: number }).n;
    const listingRows = db
      .prepare("SELECT first_sent_at AS t FROM supply WHERE first_sent_at >= ? AND first_sent_at < ?")
      .all(from, to) as { t: string }[];
    const searchRows = db
      .prepare("SELECT user_email AS email, created_at AS t FROM realty_search_events WHERE created_at >= ? AND created_at < ?")
      .all(from, to) as { t: string; email: string | null }[];

    const listings = tally(
      listingRows.map((r) => r.t),
      w,
    );
    const searches = tally(
      searchRows.map((r) => r.t),
      w,
    );

    const perAgent = new Map<string, { current: number; prior: number }>();
    for (const r of searchRows) {
      const win = windowOf(Date.parse(r.t), w);
      if (!win) continue;
      const key = agentKey(r.email);
      const row = perAgent.get(key) ?? { current: 0, prior: 0 };
      row[win]++;
      perAgent.set(key, row);
    }
    const byAgent: AgentWeek[] = [...perAgent]
      .map(([email, v]) => ({ email, current7d: v.current, prior7d: v.prior, pctChange: pctChange(v.current, v.prior) }))
      .sort((a, b) => b.current7d - a.current7d || a.email.localeCompare(b.email));
    const activeAgents7d = byAgent.filter((a) => a.email !== UNKNOWN && a.current7d > 0).length;

    // Measured while the database is open, so the WAL and shared-memory files are counted as they are now.
    const sizeBytes = dbSizeBytes(root);
    return {
      generatedAt: now.toISOString(),
      timezone: STATS_TIMEZONE,
      db: { sizeBytes, sizeMb: round1(sizeBytes / MIB), volumeQuotaMb: quota, percentUsed: round1((sizeBytes / (quota * MIB)) * 100) },
      health: { ok: true, lastIngestAt: lastIngestAt(db) },
      listings: {
        total: listingsTotal,
        current7d: listings.current,
        prior7d: listings.prior,
        pctChange: pctChange(listings.current, listings.prior),
        daily: listings.daily,
      },
      webSearches: {
        current7d: searches.current,
        prior7d: searches.prior,
        pctChange: pctChange(searches.current, searches.prior),
        activeAgents7d,
        daily: searches.daily,
        byAgent,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * GET /api/mcp/stats: bearer auth first (the same check as the agent search, so a missing or blank BOPS_MCP_TOKEN never matches),
 * then the report. 503 with a generic message when the database cannot be read; no internals in the body.
 */
export function mcpStats(req: { authorization: string | null }, root: string, env: Env, now: Date = new Date()): { status: number; body: Record<string, unknown> } {
  if (!bearerOk(req.authorization, env)) return { status: 401, body: { error: "Unauthorized." } };
  try {
    return { status: 200, body: usageStats(root, env, now) };
  } catch {
    return { status: 503, body: { error: "Stats unavailable." } };
  }
}
