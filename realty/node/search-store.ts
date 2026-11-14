/// <reference path="./node-sqlite.d.ts" />
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dateAst } from "./group-posts.ts";

/**
 * Searchable index over the Periskope supply and demand JSONL files, in <root>/search.db (SQLite via the built-in
 * node:sqlite, mode 0600). JSONL stays the source of truth. syncFromJsonl rebuilds the derived tables in one
 * transaction whenever the JSONL files change (a size+mtime fingerprint makes unchanged reruns a no-op). Because the
 * JSONL is rewritten in place on reparse and rematch, a rebuild is safer than incremental upserts.
 *
 * Owner-only state lives outside the rebuilt tables and survives it: `aliases` (term -> area/development/type, set by
 * the owner) and `explanations` (message id -> the owner's note). A note follows its message into whichever tab the
 * item lands in, so an explained item keeps its explanation after it is promoted out of the queue.
 *
 * Privacy: this module holds phone numbers and original text, the same as the JSONL. It never logs them. Only the
 * owner-gated routes and the owner's CLI return them.
 */

export type Side = "supply" | "demand";
/** The search tabs. "vague" is the needs-explanation queue (both sides). */
export type Tab = "supply" | "demand" | "vague";

/** Cross-posts from the same sender within this many days, with the same parsed ask, are one record. */
export const CROSS_POST_DAYS = 3;
/** Token-set similarity at or above this counts as near-identical text. */
const NEAR_IDENTICAL = 0.9;
const SCHEMA_VERSION = "2";
export const SEARCH_DB = "search.db";
const DAY_MS = 86_400_000;
/** Places are Trinidad and Tobago, which does not observe DST: AST is always UTC-4. */
const AST_OFFSET = "-04:00";

const TABLE: Record<Tab, string> = { supply: "supply", demand: "demand", vague: "needs_explanation" };

/** One JSONL line from supply.jsonl or demand.jsonl. Read defensively: any field may be missing or the wrong type. */
export type SourceRow = Record<string, unknown>;

export type AliasInput = { term: string; area?: string | null; development?: string | null; type?: string | null };
export type AliasRow = { term: string; area: string | null; development: string | null; type: string | null };
export type ExplainInput = { explanation: string; aliases?: AliasInput[] };

export class SearchInputError extends Error {}
export class NotInQueueError extends Error {}

export type SyncResult = {
  rebuilt: boolean;
  messages: number;
  supply: number;
  demand: number;
  needsExplanation: number;
  people: number;
  /** Messages folded into an earlier record (cross-posts). */
  duplicatesFolded: number;
  /** Vague messages that an alias turned into clear ones. */
  promotedByAlias: number;
  skippedLines: number;
};

export type SearchRow = {
  id: string;
  tab: Tab;
  kind: Side;
  senderPhone: string;
  senderName: string | null;
  firm: string | null;
  category: string;
  chatId: string | null;
  firstSentAt: string;
  lastSentAt: string;
  timesSeen: number;
  groups: string[];
  messageIds: string[];
  area: string | null;
  development: string | null;
  price: number | null;
  currency: string | null;
  beds: number | null;
  baths: number | null;
  type: string | null;
  listingType: string | null;
  intent: string | null;
  propertyClass: string | null;
  notes: string | null;
  originalText: string | null;
  explanation?: string | null;
  explainedAt?: string | null;
};

export type SearchInput = {
  kind?: Tab;
  q?: string;
  area?: string;
  development?: string;
  minPrice?: number;
  maxPrice?: number;
  beds?: number;
  type?: string;
  listingType?: "sale" | "rent";
  agent?: string;
  group?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export type SearchResult = { kind: Tab; total: number; limit: number; offset: number; rows: SearchRow[] };

/* ---------------- normalizing and classifying (pure) ---------------- */

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const hasText = (v: string | null | undefined): boolean => !!v && v.trim().length > 0;

/** Lowercase, accents removed, punctuation and emoji turned into single spaces. */
export function normalizeText(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Equal after normalizing, or token-set similarity at or above NEAR_IDENTICAL. */
export function nearIdentical(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const A = new Set(na.split(" "));
  const B = new Set(nb.split(" "));
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  const union = A.size + B.size - shared;
  return union > 0 && shared / union >= NEAR_IDENTICAL;
}

/** Vague: no area/development and no price, or no type and no area/development. */
export function isVague(f: { area?: string | null; development?: string | null; price?: number | null; type?: string | null }): boolean {
  const place = hasText(f.area) || hasText(f.development);
  if (!place && f.price == null) return true;
  return !hasText(f.type) && !place;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The term appears as a whole word or phrase, case-insensitive (letters and digits on either side are not allowed). */
export function termIn(text: string, term: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

type Fields = { area: string | null; development: string | null; price: number | null; type: string | null };

/** Fill only the fields that are missing. Aliases must already be sorted longest term first. */
export function applyAliases(f: Fields, text: string, aliases: AliasRow[]): Fields {
  const out = { ...f };
  for (const a of aliases) {
    if (!termIn(text, a.term)) continue;
    if (a.area && !hasText(out.area)) out.area = a.area;
    if (a.development && !hasText(out.development)) out.development = a.development;
    if (a.type && !hasText(out.type)) out.type = a.type;
  }
  return out;
}

/** Stable record id: the hash of the first message id, so the queue and pages keep their ids across rebuilds. */
export function recordId(messageId: string): string {
  return createHash("sha256").update(messageId).digest("hex").slice(0, 24);
}

/* ---------------- internal shapes ---------------- */

type Item = {
  messageId: string;
  side: Side;
  tab: Tab;
  sentAt: string;
  chatId: string | null;
  groupName: string | null;
  senderPhone: string;
  senderName: string | null;
  firm: string | null;
  category: string;
  area: string | null;
  development: string | null;
  price: number | null;
  currency: string | null;
  beds: number | null;
  baths: number | null;
  type: string | null;
  listingType: string | null;
  intent: string | null;
  propertyClass: string | null;
  notes: string | null;
  originalText: string | null;
  promoted: boolean;
};

type Rec = Omit<Item, "messageId" | "groupName" | "promoted" | "sentAt"> & {
  id: string;
  firstSentAt: string;
  lastSentAt: string;
  timesSeen: number;
  groups: string[];
  messageIds: string[];
};

const RECORD_COLS = [
  "id", "kind", "sender_phone", "sender_name", "firm", "category", "chat_id", "first_sent_at", "last_sent_at", "times_seen",
  "group_names", "message_ids", "area", "development", "price", "currency", "beds", "baths", "type", "listing_type", "intent",
  "property_class", "notes", "original_text",
] as const;

const INDEXED = ["area", "development", "price", "beds", "type", "listing_type", "sender_phone", "first_sent_at", "last_sent_at"] as const;

/** Normalize one JSONL row. The file it came from sets the side; a row that can't be keyed or dated is skipped. */
function toItem(raw: SourceRow, side: Side, aliases: AliasRow[]): Item | null {
  const messageId = str(raw.messageId);
  const at = typeof raw.sentAt === "string" ? Date.parse(raw.sentAt) : NaN;
  if (!messageId || !Number.isFinite(at)) return null;
  const base: Fields = { area: str(raw.area), development: str(raw.development), price: num(raw.price), type: str(raw.type) };
  const text = str(raw.originalText) ?? "";
  let fields = base;
  let promoted = false;
  if (isVague(base)) {
    fields = applyAliases(base, text, aliases);
    promoted = !isVague(fields);
  }
  const tab: Tab = isVague(fields) ? "vague" : side;
  return {
    messageId,
    side,
    tab,
    sentAt: new Date(at).toISOString(),
    chatId: str(raw.chatId),
    groupName: str(raw.groupName),
    senderPhone: str(raw.senderPhone) ?? "",
    senderName: str(raw.senderName),
    firm: str(raw.firm),
    category: str(raw.category) ?? side,
    area: fields.area,
    development: fields.development,
    price: fields.price,
    currency: str(raw.currency),
    beds: num(raw.beds),
    baths: num(raw.baths),
    type: fields.type,
    listingType: str(raw.listingType),
    intent: str(raw.intent),
    propertyClass: str(raw.propertyClass),
    notes: str(raw.notes),
    originalText: str(raw.originalText),
    promoted,
  };
}

/** The same parsed ask: category, place, type, sale or rent, beds and price. Nulls match nulls. */
function sameAsk(a: Item | Rec, b: Rec): boolean {
  const placeOf = (x: Item | Rec) => normalizeText(x.area) || normalizeText(x.development);
  return (
    a.category === b.category &&
    placeOf(a) === placeOf(b) &&
    (a.type ?? null) === (b.type ?? null) &&
    (a.listingType ?? null) === (b.listingType ?? null) &&
    (a.beds ?? null) === (b.beds ?? null) &&
    (a.price ?? null) === (b.price ?? null)
  );
}

const byTime = (a: { sentAt: string; messageId?: string }, b: { sentAt: string; messageId?: string }) =>
  a.sentAt.localeCompare(b.sentAt) || (a.messageId ?? "").localeCompare(b.messageId ?? "");

/**
 * Merge cross-posts. Deterministic: items are walked oldest first. An item joins the first earlier record from the same
 * sender, the same tab and side, when the text is near-identical, or (clear items only) the ask matches and the last
 * sighting is within CROSS_POST_DAYS. The record keeps the first message's fields and collects groups, message ids,
 * first and last sentAt, and a count.
 */
function dedupe(items: Item[]): Rec[] {
  const recs: Rec[] = [];
  const bySender = new Map<string, Rec[]>();
  for (const it of [...items].sort(byTime)) {
    const list = bySender.get(it.senderPhone) ?? [];
    const hit = list.find(
      (r) =>
        r.tab === it.tab &&
        r.side === it.side &&
        (nearIdentical(it.originalText, r.originalText) ||
          (it.tab !== "vague" && sameAsk(it, r) && Math.abs(Date.parse(it.sentAt) - Date.parse(r.lastSentAt)) <= CROSS_POST_DAYS * DAY_MS)),
    );
    if (hit) {
      hit.timesSeen++;
      if (it.sentAt > hit.lastSentAt) hit.lastSentAt = it.sentAt;
      if (it.sentAt < hit.firstSentAt) hit.firstSentAt = it.sentAt;
      if (it.groupName && !hit.groups.includes(it.groupName)) hit.groups.push(it.groupName);
      hit.messageIds.push(it.messageId);
      hit.senderName ??= it.senderName;
      hit.firm ??= it.firm;
      hit.chatId ??= it.chatId;
      continue;
    }
    const rec: Rec = {
      id: recordId(it.messageId),
      side: it.side,
      tab: it.tab,
      senderPhone: it.senderPhone,
      senderName: it.senderName,
      firm: it.firm,
      category: it.category,
      chatId: it.chatId,
      firstSentAt: it.sentAt,
      lastSentAt: it.sentAt,
      timesSeen: 1,
      groups: it.groupName ? [it.groupName] : [],
      messageIds: [it.messageId],
      area: it.area,
      development: it.development,
      price: it.price,
      currency: it.currency,
      beds: it.beds,
      baths: it.baths,
      type: it.type,
      listingType: it.listingType,
      intent: it.intent,
      propertyClass: it.propertyClass,
      notes: it.notes,
      originalText: it.originalText,
    };
    recs.push(rec);
    list.push(rec);
    bySender.set(it.senderPhone, list);
  }
  return recs;
}

/* ---------------- files and database ---------------- */

function readJsonl(file: string): { rows: SourceRow[]; skipped: number } {
  if (!existsSync(file)) return { rows: [], skipped: 0 };
  const rows: SourceRow[] = [];
  let skipped = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) rows.push(v as SourceRow);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

function fileStamp(file: string): string {
  try {
    const s = statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "-";
  }
}

function fingerprint(root: string): string {
  return [SCHEMA_VERSION, fileStamp(join(root, "supply.jsonl")), fileStamp(join(root, "demand.jsonl"))].join("|");
}

function openDb(root: string): DatabaseSync {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, SEARCH_DB);
  if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not our file to chmod: leave it */
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  ensureSchema(db);
  return db;
}

function recordTableSql(name: string, extra: string[] = []): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    sender_phone TEXT NOT NULL,
    sender_name TEXT,
    firm TEXT,
    category TEXT NOT NULL,
    chat_id TEXT,
    first_sent_at TEXT NOT NULL,
    last_sent_at TEXT NOT NULL,
    times_seen INTEGER NOT NULL,
    group_names TEXT NOT NULL,
    message_ids TEXT NOT NULL,
    area TEXT,
    development TEXT,
    price REAL,
    currency TEXT,
    beds INTEGER,
    baths INTEGER,
    type TEXT,
    listing_type TEXT,
    intent TEXT,
    property_class TEXT,
    notes TEXT,
    original_text TEXT${extra.length ? `,\n    ${extra.join(",\n    ")}` : ""}
  )`;
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS people (
      phone TEXT PRIMARY KEY,
      name TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      supply_posts INTEGER NOT NULL,
      demand_posts INTEGER NOT NULL,
      needs_posts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS aliases (
      term TEXT PRIMARY KEY,
      area TEXT,
      development TEXT,
      type TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS explanations (
      message_id TEXT PRIMARY KEY,
      explanation TEXT NOT NULL,
      explained_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS record_groups (
      tab TEXT NOT NULL,
      record_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      PRIMARY KEY (tab, record_id, group_name)
    );
    CREATE INDEX IF NOT EXISTS record_groups_name ON record_groups (group_name);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_text USING fts5(tab UNINDEXED, record_id UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2');
  `);
  const EXPLAIN_COLS = ["explanation TEXT", "explained_at TEXT"];
  db.exec(recordTableSql("supply", EXPLAIN_COLS) + ";\n" + recordTableSql("demand", EXPLAIN_COLS) + ";\n" + recordTableSql("needs_explanation", EXPLAIN_COLS) + ";");
  for (const t of ["supply", "demand", "needs_explanation"]) {
    const cols = new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    for (const c of EXPLAIN_COLS) {
      const name = c.split(" ")[0];
      if (!cols.has(name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`);
    }
    for (const c of INDEXED) db.exec(`CREATE INDEX IF NOT EXISTS ${t}_${c} ON ${t} (${c})`);
  }
}

/* ---------------- the store ---------------- */

export class SearchStore {
  readonly root: string;
  private readonly db: DatabaseSync;

  private constructor(root: string, db: DatabaseSync) {
    this.root = root;
    this.db = db;
  }

  static open(root: string): SearchStore {
    return new SearchStore(root, openDb(root));
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? String(row.value) : null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private count(table: string): number {
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
  }

  private aliasRows(): AliasRow[] {
    return this.db
      .prepare("SELECT term, area, development, type FROM aliases ORDER BY length(term) DESC, term ASC")
      .all()
      .map((r) => ({ term: String(r.term), area: r.area == null ? null : String(r.area), development: r.development == null ? null : String(r.development), type: r.type == null ? null : String(r.type) }));
  }

  /**
   * Idempotent. Rebuilds every derived table from supply.jsonl and demand.jsonl when their fingerprint has changed (or
   * when force is set). Owner state (aliases, explanations) is kept. Counts only: no text, no phone numbers.
   */
  sync(opts: { force?: boolean } = {}): SyncResult {
    const fp = fingerprint(this.root);
    if (!opts.force && this.meta("fingerprint") === fp) {
      const last = this.meta("last_counts");
      if (last) return { ...(JSON.parse(last) as SyncResult), rebuilt: false };
    }
    const aliases = this.aliasRows();
    const supplyFile = readJsonl(join(this.root, "supply.jsonl"));
    const demandFile = readJsonl(join(this.root, "demand.jsonl"));
    // Upsert by messageId: a later line for the same message replaces an earlier one (demand after supply).
    const byId = new Map<string, Item>();
    let skipped = supplyFile.skipped + demandFile.skipped;
    for (const [side, rows] of [["supply", supplyFile.rows], ["demand", demandFile.rows]] as const) {
      for (const raw of rows) {
        const it = toItem(raw, side, aliases);
        if (!it) skipped++;
        else byId.set(it.messageId, it);
      }
    }
    const items = [...byId.values()];
    const recs = dedupe(items);

    // Explanations the owner gave, by message id. Kept in their own table, so a note survives a rebuild
    // whichever tab the item lands in (queue, supply or demand). A note on a queue row that predates the
    // table is folded in first.
    this.db.exec(`INSERT OR IGNORE INTO explanations (message_id, explanation, explained_at)
      SELECT j.value, n.explanation, COALESCE(n.explained_at, '1970-01-01T00:00:00.000Z')
      FROM needs_explanation n, json_each(n.message_ids) j WHERE n.explanation IS NOT NULL`);
    const carried = new Map<string, { explanation: string; explainedAt: string | null }>();
    for (const row of this.db.prepare("SELECT message_id, explanation, explained_at FROM explanations").all()) {
      carried.set(String(row.message_id), { explanation: String(row.explanation), explainedAt: String(row.explained_at) });
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of ["supply", "demand", "needs_explanation", "record_groups", "people", "search_text"]) this.db.exec(`DELETE FROM ${t}`);
      const insertFts = this.db.prepare("INSERT INTO search_text (tab, record_id, body) VALUES (?, ?, ?)");
      const insertGroup = this.db.prepare("INSERT OR IGNORE INTO record_groups (tab, record_id, group_name) VALUES (?, ?, ?)");
      for (const r of recs) {
        const note = r.messageIds.map((m) => carried.get(m)).find((x) => x !== undefined);
        const values: (string | number | null)[] = [
          r.id, r.side, r.senderPhone, r.senderName, r.firm, r.category, r.chatId, r.firstSentAt, r.lastSentAt, r.timesSeen,
          JSON.stringify(r.groups), JSON.stringify(r.messageIds), r.area, r.development, r.price, r.currency, r.beds, r.baths,
          r.type, r.listingType, r.intent, r.propertyClass, r.notes, r.originalText,
        ];
        const cols: string[] = [...RECORD_COLS, "explanation", "explained_at"];
        values.push(note?.explanation ?? null, note?.explainedAt ?? null);
        this.db.prepare(`INSERT INTO ${TABLE[r.tab]} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...values);
        for (const g of r.groups) insertGroup.run(r.tab, r.id, g);
        insertFts.run(r.tab, r.id, [r.originalText, r.notes, r.area, r.development, r.type].filter(Boolean).join("\n"));
      }

      const people = new Map<string, { name: string | null; nameAt: string; first: string; last: string; supply: number; demand: number; needs: number }>();
      for (const it of [...items].sort(byTime)) {
        if (!it.senderPhone) continue;
        const p = people.get(it.senderPhone) ?? { name: null, nameAt: "", first: it.sentAt, last: it.sentAt, supply: 0, demand: 0, needs: 0 };
        if (it.senderName && it.sentAt >= p.nameAt) {
          p.name = it.senderName;
          p.nameAt = it.sentAt;
        }
        if (it.sentAt < p.first) p.first = it.sentAt;
        if (it.sentAt > p.last) p.last = it.sentAt;
        if (it.tab === "vague") p.needs++;
        else if (it.side === "supply") p.supply++;
        else p.demand++;
        people.set(it.senderPhone, p);
      }
      const insertPerson = this.db.prepare("INSERT INTO people (phone, name, first_seen, last_seen, supply_posts, demand_posts, needs_posts) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const [phone, p] of people) insertPerson.run(phone, p.name, p.first, p.last, p.supply, p.demand, p.needs);

      this.setMeta("fingerprint", fp);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    const result: SyncResult = {
      rebuilt: true,
      messages: items.length,
      supply: recs.filter((r) => r.tab === "supply").length,
      demand: recs.filter((r) => r.tab === "demand").length,
      needsExplanation: recs.filter((r) => r.tab === "vague").length,
      people: this.count("people"),
      duplicatesFolded: items.length - recs.length,
      promotedByAlias: items.filter((i) => i.promoted).length,
      skippedLines: skipped,
    };
    this.setMeta("last_counts", JSON.stringify(result));
    return result;
  }

  /**
   * Store the owner's explanation for one queued item, save any aliases (replacing an alias with the same term), then
   * rebuild so every alias is reapplied to every vague item. Items that are no longer vague move to supply or demand.
   */
  explain(id: string, input: ExplainInput): { id: string; stillVague: boolean; promoted: boolean; aliasesSaved: number; promotedByAlias: number } {
    const v = validateExplain(input);
    const row = this.db.prepare("SELECT message_ids FROM needs_explanation WHERE id = ?").get(id);
    if (!row) throw new NotInQueueError("That item isn't in the needs-explanation queue.");
    const messageIds = JSON.parse(String(row.message_ids)) as string[];
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE needs_explanation SET explanation = ?, explained_at = ? WHERE id = ?").run(v.explanation, now, id);
      const note = this.db.prepare(
        `INSERT INTO explanations (message_id, explanation, explained_at) VALUES (?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET explanation = excluded.explanation, explained_at = excluded.explained_at`,
      );
      for (const mid of messageIds) note.run(mid, v.explanation, now);
      const upsert = this.db.prepare(
        `INSERT INTO aliases (term, area, development, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(term) DO UPDATE SET area = excluded.area, development = excluded.development, type = excluded.type, updated_at = excluded.updated_at`,
      );
      for (const a of v.aliases) upsert.run(a.term, a.area, a.development, a.type, now, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    const counts = this.sync({ force: true });
    const stillVague = !!this.db.prepare("SELECT 1 FROM needs_explanation WHERE id = ?").get(id);
    const promoted = !stillVague && !!(this.db.prepare("SELECT 1 FROM supply WHERE id = ?").get(id) ?? this.db.prepare("SELECT 1 FROM demand WHERE id = ?").get(id));
    return { id, stillVague, promoted, aliasesSaved: v.aliases.length, promotedByAlias: counts.promotedByAlias };
  }

  /** Search one tab. Times in the filters are AST dates (YYYY-MM-DD, inclusive). Area and development match either column. */
  search(input: SearchInput = {}): SearchResult {
    const kind: Tab = input.kind ?? "supply";
    const where: string[] = [];
    const args: (string | number)[] = [];
    const add = (sql: string, ...xs: (string | number)[]) => {
      where.push(sql);
      args.push(...xs);
    };
    const q = ftsQuery(input.q);
    if (q) add(`id IN (SELECT record_id FROM search_text WHERE search_text MATCH ? AND tab = ?)`, q, kind);
    if (hasText(input.area)) add(`(area LIKE ? ESCAPE '\\' OR development LIKE ? ESCAPE '\\')`, likeOf(input.area!), likeOf(input.area!));
    if (hasText(input.development)) add(`(development LIKE ? ESCAPE '\\' OR area LIKE ? ESCAPE '\\')`, likeOf(input.development!), likeOf(input.development!));
    if (input.minPrice != null) add("price >= ?", input.minPrice);
    if (input.maxPrice != null) add("price <= ?", input.maxPrice);
    if (input.beds != null) add("beds = ?", input.beds);
    if (hasText(input.type)) add("lower(type) = lower(?)", input.type!.trim());
    if (input.listingType) add("listing_type = ?", input.listingType);
    if (hasText(input.agent)) {
      const a = input.agent!.trim();
      const digits = a.replace(/\D/g, "");
      if (/^[+\d\s().-]+$/.test(a) && digits.length >= 3) add("sender_phone LIKE ? ESCAPE '\\'", likeOf(digits));
      else add("(sender_name LIKE ? ESCAPE '\\' OR sender_phone IN (SELECT phone FROM people WHERE name LIKE ? ESCAPE '\\'))", likeOf(a), likeOf(a));
    }
    if (hasText(input.group)) add(`id IN (SELECT record_id FROM record_groups WHERE tab = ? AND group_name LIKE ? ESCAPE '\\')`, kind, likeOf(input.group!.trim()));
    if (input.from) add("last_sent_at >= ?", astStart(input.from));
    if (input.to) add("first_sent_at < ?", new Date(Date.parse(astStart(input.to)) + DAY_MS).toISOString());
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const table = TABLE[kind];
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${whereSql}`).get(...args)?.n ?? 0);
    const rows = this.db
      .prepare(`SELECT * FROM ${table} ${whereSql} ORDER BY last_sent_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset)
      .map((r) => toSearchRow(r, kind));
    return { kind, total, limit, offset, rows };
  }

  /** All rows of the three tabs, for the export. Text and phone numbers included: owner-gated callers only. */
  allRows(tab: Tab): SearchRow[] {
    return this.db
      .prepare(`SELECT * FROM ${TABLE[tab]} ORDER BY last_sent_at DESC, id ASC`)
      .all()
      .map((r) => toSearchRow(r, tab));
  }

  aliases(): AliasRow[] {
    return this.aliasRows();
  }
}

function toSearchRow(r: Record<string, unknown>, tab: Tab): SearchRow {
  const s = (v: unknown) => (v == null ? null : String(v));
  const n = (v: unknown) => (v == null ? null : Number(v));
  const row: SearchRow = {
    id: String(r.id),
    tab,
    kind: String(r.kind) as Side,
    senderPhone: String(r.sender_phone),
    senderName: s(r.sender_name),
    firm: s(r.firm),
    category: String(r.category),
    chatId: s(r.chat_id),
    firstSentAt: String(r.first_sent_at),
    lastSentAt: String(r.last_sent_at),
    timesSeen: Number(r.times_seen),
    groups: JSON.parse(String(r.group_names)) as string[],
    messageIds: JSON.parse(String(r.message_ids)) as string[],
    area: s(r.area),
    development: s(r.development),
    price: n(r.price),
    currency: s(r.currency),
    beds: n(r.beds),
    baths: n(r.baths),
    type: s(r.type),
    listingType: s(r.listing_type),
    intent: s(r.intent),
    propertyClass: s(r.property_class),
    notes: s(r.notes),
    originalText: s(r.original_text),
  };
  row.explanation = s(r.explanation);
  row.explainedAt = s(r.explained_at);
  return row;
}

function likeOf(s: string): string {
  return `%${s.replace(/[\\%_]/g, "\\$&")}%`;
}

/** Words only (letters and digits), each a prefix match, all required. Punctuation in the query is dropped. */
export function ftsQuery(q: string | undefined): string | null {
  const words = (q ?? "").match(/[\p{L}\p{N}]+/gu)?.slice(0, 20) ?? [];
  return words.length ? words.map((w) => `"${w.slice(0, 64)}"*`).join(" ") : null;
}

/** The first instant of an AST calendar day, as the same ISO form stored in the table. */
function astStart(ymd: string): string {
  return new Date(`${ymd}T00:00:00${AST_OFFSET}`).toISOString();
}

function validateExplain(input: ExplainInput): { explanation: string; aliases: { term: string; area: string | null; development: string | null; type: string | null }[] } {
  const explanation = typeof input?.explanation === "string" ? input.explanation.trim() : "";
  if (!explanation) throw new SearchInputError("Write an explanation.");
  if (explanation.length > 2000) throw new SearchInputError("The explanation is too long (2000 characters at most).");
  const aliases = Array.isArray(input.aliases) ? input.aliases : [];
  if (aliases.length > 20) throw new SearchInputError("Save at most 20 aliases at a time.");
  const out = aliases.map((a) => {
    const term = typeof a?.term === "string" ? a.term.trim().toLowerCase() : "";
    const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null);
    const area = clean(a?.area);
    const development = clean(a?.development);
    const type = clean(a?.type);
    if (term.length < 2 || term.length > 80) throw new SearchInputError("Each alias needs a term of 2 to 80 characters.");
    if (!area && !development && !type) throw new SearchInputError(`The alias "${term}" needs an area, a development or a type.`);
    return { term, area, development, type };
  });
  return { explanation: explanation.slice(0, 2000), aliases: out };
}

/** Reads the search filters from a URL or a Next searchParams object. Throws SearchInputError on a bad value. */
export function searchInputFrom(p: URLSearchParams | Record<string, string | string[] | undefined>): SearchInput {
  const get = (k: string): string | undefined => {
    if (p instanceof URLSearchParams) return p.get(k) ?? undefined;
    const v = p[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const text = (k: string) => {
    const v = get(k)?.trim();
    return v ? v : undefined;
  };
  const number = (k: string, opts: { int?: boolean } = {}) => {
    const raw = text(k);
    if (raw === undefined) return undefined;
    const n = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(n) || (opts.int && !Number.isInteger(n))) throw new SearchInputError(`${k} must be a number.`);
    return n;
  };
  const day = (k: string) => {
    const v = text(k);
    if (v === undefined) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new SearchInputError(`${k} must be a date as YYYY-MM-DD (AST).`);
    return v;
  };
  const kind = text("kind") ?? "supply";
  if (kind !== "supply" && kind !== "demand" && kind !== "vague") throw new SearchInputError("kind must be supply, demand or vague.");
  const listingType = text("listingType") ?? text("listing_type");
  if (listingType !== undefined && listingType !== "sale" && listingType !== "rent") throw new SearchInputError("listingType must be sale or rent.");
  const limit = Math.min(Math.max(number("limit", { int: true }) ?? 100, 1), 500);
  const offset = Math.max(number("offset", { int: true }) ?? 0, 0);
  return {
    kind,
    q: text("q"),
    area: text("area"),
    development: text("development"),
    minPrice: number("minPrice"),
    maxPrice: number("maxPrice"),
    beds: number("beds", { int: true }),
    type: text("type"),
    listingType,
    agent: text("agent"),
    group: text("group"),
    from: day("from"),
    to: day("to"),
    limit,
    offset,
  };
}

/* ---------------- entry points ---------------- */

/** Rebuild (when the JSONL changed) and return counts. Safe to call from pollOnce; never prints text or numbers. */
export function syncFromJsonl(root: string, opts: { force?: boolean } = {}): SyncResult {
  const store = SearchStore.open(root);
  try {
    return store.sync(opts);
  } finally {
    store.close();
  }
}

export function withSearchStore<T>(root: string, fn: (store: SearchStore) => T): T {
  const store = SearchStore.open(root);
  try {
    store.sync();
    return fn(store);
  } finally {
    store.close();
  }
}

/** Export rows for the three tabs: a header row, then one row per record, all values as strings, times in AST. */
export function exportSheets(root: string): Record<"Supply" | "Demand" | "Needs explanation", string[][]> {
  return withSearchStore(root, (store) => ({
    Supply: sheet(store.allRows("supply"), SALE_HEADER),
    Demand: sheet(store.allRows("demand"), SALE_HEADER),
    "Needs explanation": [QUEUE_HEADER, ...store.allRows("vague").map(queueLine)],
  }));
}

const SALE_HEADER = ["First seen (AST)", "Last seen (AST)", "Times seen", "Groups", "Sender", "Phone", "Area / development", "Type", "Sale or rent", "Beds", "Price", "Currency", "Category", "Text", "Explanation", "Explained (AST)"];
const QUEUE_HEADER = ["First seen (AST)", "Last seen (AST)", "Times seen", "Side", "Groups", "Sender", "Phone", "Text", "Explanation", "Explained (AST)"];

function sheet(rows: SearchRow[], header: string[]): string[][] {
  return [
    header,
    ...rows.map((r) => [
      dateAst(r.firstSentAt),
      dateAst(r.lastSentAt),
      String(r.timesSeen),
      r.groups.join("; "),
      r.senderName ?? "",
      r.senderPhone,
      [r.area, r.development].filter(Boolean).join(" / "),
      r.type ?? "",
      r.listingType ?? "",
      r.beds == null ? "" : String(r.beds),
      r.price == null ? "" : String(r.price),
      r.currency ?? "",
      r.category,
      r.originalText ?? "",
      r.explanation ?? "",
      r.explainedAt ? dateAst(r.explainedAt) : "",
    ]),
  ];
}

function queueLine(r: SearchRow): string[] {
  return [
    dateAst(r.firstSentAt),
    dateAst(r.lastSentAt),
    String(r.timesSeen),
    r.kind,
    r.groups.join("; "),
    r.senderName ?? "",
    r.senderPhone,
    r.originalText ?? "",
    r.explanation ?? "",
    r.explainedAt ? dateAst(r.explainedAt) : "",
  ];
}
