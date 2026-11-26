import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GATE_OPEN_PATHS } from "../../lib/gate.ts";
import type { Env } from "../node/agent-search.ts";
import { dailyDates, dbSizeBytes, mcpStats, pctChange, usageStats, volumeQuotaMb, weekWindows, type Daily, type UsageStats } from "../node/usage-stats.ts";
import { openSearchDb, recordRealtySearchEvent, SEARCH_DB, syncFromJsonl, withSearchStore } from "../node/search-store.ts";

// Invented data only: made-up agents on example.invalid, 555-style numbers, invented groups, chats and text.
const TOKEN = "test-mcp-token-not-a-secret-0123456789";
const ENV: Env = { BOPS_MCP_TOKEN: TOKEN };
const AUTH = { authorization: `Bearer ${TOKEN}` };
const PHONE = "+18685550101";
const GROUP = "Invented HERON Group";
const CHAT = "heron-chat-0001@g.us";
const TEXT = "Invented ZEBRA listing text";
const AGENT_ONE = "agent.one@example.invalid";
const AGENT_TWO = "agent.two@example.invalid";
const AGENT_THREE = "agent.three@example.invalid";
/** A Monday 08:30 AST report: the week of 9–15 Nov is "current", the week of 2–8 Nov is "prior". */
const NOW = new Date("2026-11-16T12:30:00.000Z");
const MIB = 1024 * 1024;
const round1 = (n: number): number => Math.round(n * 10) / 10;

const world = (): string => mkdtempSync(join(tmpdir(), "usage-stats-"));

let seq = 0;
/** One supply or demand row (the columns the stats read, plus the ones a real row carries, so the payload can be checked for them). */
function addRow(root: string, table: "supply" | "demand", firstSentAt: string, lastSentAt = firstSentAt, extra: { group?: string; chat?: string; text?: string } = {}): void {
  const db = openSearchDb(root);
  try {
    db.prepare(
      `INSERT INTO ${table} (id, kind, sender_phone, category, chat_id, first_sent_at, last_sent_at, times_seen, group_names, message_ids, original_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      `${table}-${++seq}`,
      table,
      PHONE,
      table,
      extra.chat ?? null,
      firstSentAt,
      lastSentAt,
      JSON.stringify(extra.group ? [extra.group] : []),
      JSON.stringify(["msg-1"]),
      extra.text ?? null,
    );
  } finally {
    db.close();
  }
}

/** One Market Search event, stored as the page writes it (a null email is an unknown viewer). */
function addEvent(root: string, email: string | null, at: string): void {
  const db = openSearchDb(root);
  try {
    db.prepare("INSERT INTO realty_search_events (user_email, created_at) VALUES (?, ?)").run(email, at);
  } finally {
    db.close();
  }
}

function count(root: string, table: string): number {
  const db = openSearchDb(root);
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** The non-zero buckets as { date: count }, for readable assertions. */
const nonZero = (daily: Daily[]) => Object.fromEntries(daily.filter((d) => d.count > 0).map((d) => [d.date, d.count]));

/* ---------------- pure: percent change and the week ---------------- */

test("pctChange: a rise, a fall, a decrease to 0, 0 to N is New (null), 0 to 0 is 0", () => {
  assert.equal(pctChange(124, 100), 24);
  assert.equal(pctChange(80, 100), -20);
  assert.equal(pctChange(3, 2), 50);
  assert.equal(pctChange(2, 3), -33, "rounded to a whole percent");
  assert.equal(pctChange(0, 5), -100);
  assert.equal(pctChange(5, 0), null, "new this week");
  assert.equal(pctChange(0, 0), 0);
});

test("week windows: a Monday 08:30 AST report covers the Mon–Sun week just ended and the week before it", () => {
  const w = weekWindows(NOW);
  assert.equal(w.currentEnd.toISOString(), "2026-11-16T04:00:00.000Z", "Monday 00:00 AST");
  assert.equal(w.currentStart.toISOString(), "2026-11-09T04:00:00.000Z");
  assert.equal(w.priorStart.toISOString(), "2026-11-02T04:00:00.000Z");
  const days = dailyDates(w);
  assert.equal(days.length, 14);
  assert.equal(days[0], "2026-11-02");
  assert.equal(days[13], "2026-11-15");
  assert.deepEqual(days, Array.from({ length: 14 }, (_, i) => `2026-11-${String(2 + i).padStart(2, "0")}`));
});

test("week windows: exactly Monday 00:00 AST starts the new week; the Sunday night before still belongs to the last one", () => {
  assert.equal(weekWindows(new Date("2026-11-16T04:00:00.000Z")).currentEnd.toISOString(), "2026-11-16T04:00:00.000Z");
  assert.equal(weekWindows(new Date("2026-11-16T03:59:59.999Z")).currentEnd.toISOString(), "2026-11-09T04:00:00.000Z");
});

test("volumeQuotaMb: SEARCH_DB_QUOTA_MB when it is a positive number, else the 3072 MB default", () => {
  assert.equal(volumeQuotaMb({ SEARCH_DB_QUOTA_MB: "100" }), 100);
  assert.equal(volumeQuotaMb({ SEARCH_DB_QUOTA_MB: "" }), 3072);
  assert.equal(volumeQuotaMb({ SEARCH_DB_QUOTA_MB: "   " }), 3072);
  assert.equal(volumeQuotaMb({ SEARCH_DB_QUOTA_MB: "abc" }), 3072);
  assert.equal(volumeQuotaMb({ SEARCH_DB_QUOTA_MB: "-5" }), 3072);
  assert.equal(volumeQuotaMb({}), 3072);
});

test("dbSizeBytes adds search.db, its WAL and its shared memory; a missing file counts as 0", () => {
  const root = world();
  assert.equal(dbSizeBytes(root), 0, "empty folder");
  writeFileSync(join(root, SEARCH_DB), Buffer.alloc(1000));
  writeFileSync(join(root, `${SEARCH_DB}-wal`), Buffer.alloc(500));
  writeFileSync(join(root, `${SEARCH_DB}-shm`), Buffer.alloc(100));
  assert.equal(dbSizeBytes(root), 1600);
});

/* ---------------- the AST day and the week ---------------- */

test("daily buckets are AST dates: 2026-11-24T02:30Z is still Monday 23 Nov in Port of Spain", () => {
  const root = world();
  addRow(root, "supply", "2026-11-24T02:30:00.000Z");
  const r = usageStats(root, ENV, new Date("2026-11-30T12:30:00.000Z"));
  assert.deepEqual(nonZero(r.listings.daily), { "2026-11-23": 1 }, "bucketed on the AST date, not the UTC one");
  assert.equal(r.listings.current7d, 1);
});

test("daily buckets: an event at 2026-11-10T02:30Z is on 9 Nov (AST), so 10 Nov has none", () => {
  const root = world();
  addEvent(root, AGENT_ONE, "2026-11-10T02:30:00.000Z");
  const r = usageStats(root, ENV, NOW);
  assert.equal(r.webSearches.daily.length, 14);
  assert.equal(r.webSearches.daily.find((d) => d.date === "2026-11-09")?.count, 1);
  assert.equal(r.webSearches.daily.find((d) => d.date === "2026-11-10")?.count, 0);
});

/* ---------------- the usage numbers ---------------- */

/** A small fixture for NOW (week of 9–15 Nov current, 2–8 Nov prior). Invented rows; the group, chat and text are in it on purpose. */
function fixture(): string {
  const root = world();
  // Market Listings: 3 this week, 2 last week, 1 after the report's week (counted in the total only).
  addRow(root, "supply", "2026-11-10T10:00:00.000Z", "2026-11-10T10:00:00.000Z", { group: GROUP, chat: CHAT, text: TEXT });
  addRow(root, "supply", "2026-11-11T10:00:00.000Z");
  addRow(root, "supply", "2026-11-12T10:00:00.000Z");
  addRow(root, "supply", "2026-11-03T10:00:00.000Z");
  addRow(root, "supply", "2026-11-04T10:00:00.000Z");
  addRow(root, "supply", "2026-11-16T10:00:00.000Z");
  // Demand is not a listing, but its last sighting counts for the ingest time.
  addRow(root, "demand", "2026-11-14T09:00:00.000Z", "2026-11-16T11:00:00.000Z", { group: GROUP });
  // Market Search: alice 3 this week and 1 last week; bob 1 this week; an unknown viewer 1 this week; carol 2 last week;
  // one event after the report's week, which is not counted.
  addEvent(root, AGENT_ONE, "2026-11-10T09:00:00.000Z");
  addEvent(root, AGENT_ONE, "2026-11-11T09:00:00.000Z");
  addEvent(root, AGENT_ONE, "2026-11-12T09:00:00.000Z");
  addEvent(root, AGENT_ONE, "2026-11-05T09:00:00.000Z");
  addEvent(root, AGENT_TWO, "2026-11-13T09:00:00.000Z");
  addEvent(root, null, "2026-11-14T09:00:00.000Z");
  addEvent(root, AGENT_THREE, "2026-11-06T09:00:00.000Z");
  addEvent(root, AGENT_THREE, "2026-11-07T09:00:00.000Z");
  addEvent(root, AGENT_ONE, "2026-11-16T05:00:00.000Z");
  return root;
}

test("usage numbers: listings and Market Search, week over week, with daily buckets and the agents sorted", () => {
  const r = usageStats(fixture(), ENV, NOW);
  assert.equal(r.generatedAt, NOW.toISOString());
  assert.equal(r.timezone, "America/Port_of_Spain");

  assert.equal(r.listings.total, 6, "every supply row, including the one after the week");
  assert.equal(r.listings.current7d, 3);
  assert.equal(r.listings.prior7d, 2);
  assert.equal(r.listings.pctChange, 50);
  assert.deepEqual(nonZero(r.listings.daily), {
    "2026-11-03": 1,
    "2026-11-04": 1,
    "2026-11-10": 1,
    "2026-11-11": 1,
    "2026-11-12": 1,
  });

  assert.equal(r.webSearches.current7d, 5);
  assert.equal(r.webSearches.prior7d, 3);
  assert.equal(r.webSearches.pctChange, 67, "5 against 3 is +66.7, rounded");
  assert.equal(r.webSearches.activeAgents7d, 2, "alice and bob; the unknown viewer is not an agent");
  assert.deepEqual(nonZero(r.webSearches.daily), {
    "2026-11-05": 1,
    "2026-11-06": 1,
    "2026-11-07": 1,
    "2026-11-10": 1,
    "2026-11-11": 1,
    "2026-11-12": 1,
    "2026-11-13": 1,
    "2026-11-14": 1,
  });

  assert.deepEqual(r.webSearches.byAgent, [
    { email: AGENT_ONE, current7d: 3, prior7d: 1, pctChange: 200 },
    { email: AGENT_TWO, current7d: 1, prior7d: 0, pctChange: null },
    { email: "unknown", current7d: 1, prior7d: 0, pctChange: null },
    { email: AGENT_THREE, current7d: 0, prior7d: 2, pctChange: -100 },
  ], "sorted by this week, then email");
});

test("health: the newest last_sent_at across supply, demand and needs-explanation; the report's keys are exact", () => {
  const r = usageStats(fixture(), ENV, NOW);
  assert.equal(r.health.ok, true);
  assert.equal(r.health.lastIngestAt, "2026-11-16T11:00:00.000Z");
  assert.deepEqual(Object.keys(r), ["generatedAt", "timezone", "db", "health", "listings", "webSearches"]);
  assert.deepEqual(Object.keys(r.db), ["sizeBytes", "sizeMb", "volumeQuotaMb", "percentUsed"]);
  assert.deepEqual(Object.keys(r.health), ["ok", "lastIngestAt"]);
  assert.deepEqual(Object.keys(r.listings), ["total", "current7d", "prior7d", "pctChange", "daily"]);
  assert.deepEqual(Object.keys(r.webSearches), ["current7d", "prior7d", "pctChange", "activeAgents7d", "daily", "byAgent"]);
  assert.deepEqual(Object.keys(r.webSearches.byAgent[0]), ["email", "current7d", "prior7d", "pctChange"]);
});

test("the payload carries no group names, chat ids, message text, phone numbers or message ids", () => {
  const root = fixture();
  const r = mcpStats(AUTH, root, ENV, NOW);
  assert.equal(r.status, 200);
  const json = JSON.stringify(r.body);
  for (const secret of [GROUP, "HERON", CHAT, TEXT, "ZEBRA", PHONE, "msg-1", "original", "group"]) assert.equal(json.includes(secret), false, secret);
  assert.equal(/periskope/i.test(json), false);
});

test("an empty database reports zeros, no ingest time and no agents", () => {
  const r = mcpStats(AUTH, world(), ENV, NOW);
  assert.equal(r.status, 200);
  const b = r.body as unknown as UsageStats;
  assert.equal(b.health.lastIngestAt, null);
  assert.equal(b.listings.total, 0);
  assert.equal(b.webSearches.current7d, 0);
  assert.equal(b.webSearches.pctChange, 0, "0 to 0 is 0");
  assert.deepEqual(b.webSearches.byAgent, []);
  assert.equal(b.webSearches.daily.length, 14);
});

test("db: size from the files and percent of SEARCH_DB_QUOTA_MB; the default quota is 3072 MB", () => {
  const root = fixture();
  const r = usageStats(root, { SEARCH_DB_QUOTA_MB: "2" }, NOW);
  assert.equal(r.db.volumeQuotaMb, 2);
  assert.equal(r.db.sizeBytes, dbSizeBytes(root));
  assert.ok(r.db.sizeBytes > 0);
  assert.equal(r.db.sizeMb, round1(r.db.sizeBytes / MIB));
  assert.equal(r.db.percentUsed, round1((r.db.sizeBytes / (2 * MIB)) * 100));
  assert.equal(usageStats(world(), {}, NOW).db.volumeQuotaMb, 3072);
});

/* ---------------- auth and the 503 ---------------- */

test("mcpStats: 401 with no header, a wrong token, a blank or non-bearer header, a longer token, and when BOPS_MCP_TOKEN is unset or blank; the database is not touched", () => {
  const root = join(world(), "never-created");
  for (const authorization of [null, "", "Bearer ", "Bearer wrong", `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN}x`, `Bearer ${"x".repeat(5000)}`]) {
    const r = mcpStats({ authorization }, root, ENV, NOW);
    assert.deepEqual(r, { status: 401, body: { error: "Unauthorized." } }, `header ${String(authorization).slice(0, 20)}`);
  }
  assert.equal(mcpStats(AUTH, root, {}, NOW).status, 401, "env unset");
  assert.equal(mcpStats(AUTH, root, { BOPS_MCP_TOKEN: "   " }, NOW).status, 401, "env blank");
  assert.equal(existsSync(root), false, "a refused request never opens the database");
});

test("mcpStats: 503 with a generic message when the database cannot be opened", () => {
  const file = join(world(), "not-a-folder");
  writeFileSync(file, "x");
  const r = mcpStats(AUTH, file, ENV, NOW);
  assert.deepEqual(r, { status: 503, body: { error: "Stats unavailable." } });
  assert.equal(JSON.stringify(r.body).includes(file), false, "no path in the body");
});

/* ---------------- the event log ---------------- */

test("recordRealtySearchEvent inserts one row per call (ISO time, the email trimmed and lowercased, null when there is none)", () => {
  const root = world();
  recordRealtySearchEvent(root, `  ${AGENT_ONE.toUpperCase()} `);
  recordRealtySearchEvent(root, null);
  const db = openSearchDb(root);
  try {
    const rows = db.prepare("SELECT user_email AS email, created_at AS at FROM realty_search_events ORDER BY id").all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].email, AGENT_ONE);
    assert.equal(rows[1].email, null);
    assert.equal(new Date(String(rows[0].at)).toISOString(), rows[0].at, "created_at is ISO-8601 UTC");
  } finally {
    db.close();
  }
});

test("recordRealtySearchEvent never throws on an unusable root, and its warning does not carry the email", () => {
  const file = join(world(), "not-a-folder");
  writeFileSync(file, "x");
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    assert.doesNotThrow(() => recordRealtySearchEvent(join(file, "sub"), AGENT_TWO));
    assert.doesNotThrow(() => recordRealtySearchEvent(file, null));
  } finally {
    console.warn = warn;
  }
  assert.ok(warnings.length >= 1, "the failure is reported");
  assert.ok(warnings.every((w) => !w.includes("agent.two")), "no email in the warning");
});

test("the event log does not depend on the JSONL: a sync or a store open does not drop or need the events", () => {
  const root = world(); // no JSONL files at all
  recordRealtySearchEvent(root, AGENT_ONE);
  syncFromJsonl(root, { force: true });
  withSearchStore(root, () => undefined);
  assert.equal(count(root, "realty_search_events"), 1);
});

test("the schema is added idempotently: an existing database opens again with its events", () => {
  const root = world();
  recordRealtySearchEvent(root, AGENT_ONE);
  recordRealtySearchEvent(root, AGENT_ONE);
  assert.equal(count(root, "realty_search_events"), 2);
  assert.ok(statSync(join(root, SEARCH_DB)).size > 0);
});

/* ---------------- the gate ---------------- */

test("/api/mcp/stats is open to the Google gate and server-to-server in proxy.ts", () => {
  assert.equal(GATE_OPEN_PATHS.has("/api/mcp/stats"), true);
  const proxy = readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");
  const line = proxy.split("\n").find((l) => l.startsWith("const TAILNET_PATHS"));
  assert.ok(line, "TAILNET_PATHS is found");
  assert.ok(line.includes('"/api/mcp/stats"'));
});
