/// <reference path="./node-sqlite.d.ts" />
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEVELOPMENTS } from "../extract.ts";
import { applyKnownTerms, bestGuess, termIn, type KnownTerm } from "../flow/knowledge.ts";
import { reparsePost, type PostRecord } from "../flow/periskope.ts";
import { dateAst } from "./group-posts.ts";
import { resolveAreaKnowledge } from "./area-knowledge-store.ts";
import { PeriskopeStore } from "./periskope-store.ts";

/**
 * Searchable index over the Periskope supply and demand JSONL files, in <root>/search.db (SQLite via the built-in
 * node:sqlite, mode 0600). JSONL stays the source of truth. syncFromJsonl rebuilds the derived tables in one
 * transaction whenever the JSONL files change (a size+mtime fingerprint makes unchanged reruns a no-op). Because the
 * JSONL is rewritten in place on reparse and rematch, a rebuild is safer than incremental upserts.
 *
 * Bops's shared knowledge lives in `knowledge` (same file): seeded from the area knowledge and the development gazetteer,
 * then taught by the owner. A term there (a place, development, alias, rule or note) is read by the parser at ingest, by
 * the sync (which fills empty fields), and by matching. Owner state also lives outside the rebuilt tables: `explanations`
 * (message id -> the owner's answer). An answer follows its message into whichever tab the item lands in.
 *
 * Privacy: this module holds phone numbers and original text, the same as the JSONL. It never logs them. Only the
 * owner-gated routes and the owner's CLI return them.
 */

export type Side = "supply" | "demand";
/** The search tabs. "vague" is the needs-explanation queue (both sides). */
export type Tab = "supply" | "demand" | "vague";

export type { KnownTerm };

/** Cross-posts from the same sender within this many days, with the same parsed ask, are one record. */
export const CROSS_POST_DAYS = 3;
/** Token-set similarity at or above this counts as near-identical text. */
const NEAR_IDENTICAL = 0.9;
const SCHEMA_VERSION = "3";
export const SEARCH_DB = "search.db";
const DAY_MS = 86_400_000;
/** Places are Trinidad and Tobago, which does not observe DST: AST is always UTC-4. */
const AST_OFFSET = "-04:00";

const TABLE: Record<Tab, string> = { supply: "supply", demand: "demand", vague: "needs_explanation" };

/** One JSONL line from supply.jsonl or demand.jsonl. Read defensively: any field may be missing or the wrong type. */
export type SourceRow = Record<string, unknown>;

/** What the owner teaches about one queued item. `answer` is one line; the rest are optional parts. */
export type TeachInput = {
  answer: string;
  term?: string | null;
  area?: string | null;
  development?: string | null;
  type?: string | null;
  listingType?: string | null;
  note?: string | null;
};
export type TeachResult = {
  id: string;
  /** What was saved in knowledge: an alias (term + place or type), a rule (term + sale/rent), or a note. */
  saved: "alias" | "rule" | "note";
  term: string | null;
  stillVague: boolean;
  /** This item moved out of the queue. */
  promoted: boolean;
  /** Stored posts whose text contains the term, parsed again with the new knowledge. */
  reparsed: number;
  /** Queue items (any) that moved out of the queue because of this answer. */
  promotedRecords: number;
};

/** A past answer: a taught knowledge row, newest first on the teach page. */
export type TaughtRow = { kind: string; term: string | null; area: string | null; development: string | null; type: string | null; listingType: string | null; note: string | null; taughtBy: string | null; taughtAt: string | null };

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

/**
 * Normalize one JSONL row. The file it came from sets the side; a row that can't be keyed or dated is skipped. Taught terms
 * fill whatever the row leaves empty (never overwrite), so a record stored before a term was taught is read with it too.
 */
function toItem(raw: SourceRow, side: Side, terms: readonly KnownTerm[]): Item | null {
  const messageId = str(raw.messageId);
  const at = typeof raw.sentAt === "string" ? Date.parse(raw.sentAt) : NaN;
  if (!messageId || !Number.isFinite(at)) return null;
  const price = num(raw.price);
  const text = str(raw.originalText) ?? "";
  const row = { area: str(raw.area), development: str(raw.development), type: str(raw.type), listingType: str(raw.listingType) };
  const fields = applyKnownTerms(row, text, terms);
  const promoted = isVague({ ...row, price }) && !isVague({ ...fields, price });
  const tab: Tab = isVague({ ...fields, price }) ? "vague" : side;
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
    price,
    currency: str(raw.currency),
    beds: num(raw.beds),
    baths: num(raw.baths),
    type: fields.type,
    listingType: fields.listingType,
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
    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('place', 'development', 'alias', 'rule', 'note')),
      term TEXT,
      area TEXT,
      development TEXT,
      type TEXT,
      listing_type TEXT,
      lat REAL,
      lng REAL,
      payload TEXT,
      note TEXT,
      source TEXT NOT NULL CHECK (source IN ('area-knowledge', 'gazetteer', 'taught')),
      taught_by TEXT,
      taught_at TEXT,
      UNIQUE (kind, term)
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
  // The old owner alias table is folded into knowledge once, then dropped (INSERT OR IGNORE keeps a re-run harmless).
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'aliases'").get()) {
    db.exec(`INSERT OR IGNORE INTO knowledge (kind, term, area, development, type, source, taught_at, note)
      SELECT 'alias', term, area, development, type, 'taught', updated_at, NULL FROM aliases;
      DROP TABLE aliases;`);
  }
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

  /** Every taught or seeded term, longest first. Read by the parser, the sync and the matcher. */
  knownTerms(): KnownTerm[] {
    return this.db
      .prepare("SELECT term, area, development, type, listing_type FROM knowledge WHERE kind IN ('place', 'development', 'alias', 'rule') AND term IS NOT NULL ORDER BY length(term) DESC, term ASC")
      .all()
      .map((r) => ({ term: String(r.term), area: str(r.area), development: str(r.development), type: str(r.type), listingType: str(r.listing_type) }));
  }

  /**
   * Seeds the knowledge store from the area knowledge (the volume file, else the bundled snapshot) and the development
   * gazetteer. INSERT OR IGNORE: a re-run adds only what is new, and never touches a taught row.
   */
  seed(): void {
    const area = resolveAreaKnowledge(join(dirname(this.root), "area-knowledge.json"));
    const put = this.db.prepare(
      `INSERT OR IGNORE INTO knowledge (kind, term, area, development, lat, lng, payload, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const p of area?.places ?? []) {
        const term = p.name.trim().toLowerCase();
        const coords = p.coords ?? null;
        if (p.kind === "development") put.run("development", term, null, p.name, coords?.lat ?? null, coords?.lon ?? null, JSON.stringify({ parent: p.parent }), "area-knowledge");
        else put.run("place", term, p.name, null, coords?.lat ?? null, coords?.lon ?? null, null, "area-knowledge");
      }
      for (const d of DEVELOPMENTS) {
        put.run("development", d.name.toLowerCase(), null, d.name, null, null, JSON.stringify({ parent: d.parent }), "gazetteer");
        for (const alias of d.aliases) put.run("alias", alias.toLowerCase(), null, d.name, null, null, null, "gazetteer");
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** A stamp that changes when the knowledge does, so an unchanged JSONL still rebuilds after a teach. */
  private knowledgeStamp(): string {
    const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(taught_at), '') AS t FROM knowledge").get();
    return `${Number(r?.n ?? 0)}:${String(r?.t ?? "")}`;
  }

  /**
   * Idempotent. Seeds the knowledge, then rebuilds every derived table from supply.jsonl and demand.jsonl when their
   * fingerprint (JSONL and knowledge) has changed, or when force is set. Owner state (knowledge, explanations) is kept.
   * Counts only: no text, no phone numbers.
   */
  sync(opts: { force?: boolean } = {}): SyncResult {
    this.seed();
    const fp = `${fingerprint(this.root)}|${this.knowledgeStamp()}`;
    if (!opts.force && this.meta("fingerprint") === fp) {
      const last = this.meta("last_counts");
      if (last) return { ...(JSON.parse(last) as SyncResult), rebuilt: false };
    }
    const terms = this.knownTerms();
    const supplyFile = readJsonl(join(this.root, "supply.jsonl"));
    const demandFile = readJsonl(join(this.root, "demand.jsonl"));
    // Upsert by messageId: a later line for the same message replaces an earlier one (demand after supply).
    const byId = new Map<string, Item>();
    let skipped = supplyFile.skipped + demandFile.skipped;
    for (const [side, rows] of [["supply", supplyFile.rows], ["demand", demandFile.rows]] as const) {
      for (const raw of rows) {
        const it = toItem(raw, side, terms);
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
   * Teach Bops from one queued item. The answer is kept on the item, and the teaching is saved to knowledge: an alias (term
   * plus a place or type), a rule (term plus sale or rent), or else a note. Then the stored posts whose text contains the
   * term are parsed again with the new knowledge, and the tables are rebuilt, so every affected item is read again and the
   * ones that are now clear move to supply or demand. Local only: no network, no WhatsApp, no CRM.
   */
  teach(id: string, input: TeachInput, by = "owner"): TeachResult {
    const v = validateTeach(input);
    const row = this.db.prepare("SELECT message_ids FROM needs_explanation WHERE id = ?").get(id);
    if (!row) throw new NotInQueueError("That item isn't in the needs-explanation queue.");
    const messageIds = JSON.parse(String(row.message_ids)) as string[];
    const now = new Date().toISOString();
    const affected = v.term ? this.recordsWithText(v.term) : [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE needs_explanation SET explanation = ?, explained_at = ? WHERE id = ?").run(v.answer, now, id);
      const note = this.db.prepare(
        `INSERT INTO explanations (message_id, explanation, explained_at) VALUES (?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET explanation = excluded.explanation, explained_at = excluded.explained_at`,
      );
      for (const mid of messageIds) note.run(mid, v.answer, now);
      // One row per (kind, term): a later teaching of the same term replaces the earlier one.
      this.db.prepare(
        `INSERT INTO knowledge (kind, term, area, development, type, listing_type, note, source, taught_by, taught_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'taught', ?, ?)
         ON CONFLICT(kind, term) DO UPDATE SET area = excluded.area, development = excluded.development, type = excluded.type,
           listing_type = excluded.listing_type, note = excluded.note, taught_by = excluded.taught_by, taught_at = excluded.taught_at`,
      ).run(v.saved, v.term, v.area, v.development, v.type, v.listingType, v.note, by, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    const reparsed = v.term ? this.reparseStored(v.term) : 0;
    this.sync({ force: true });
    const stillVague = !!this.db.prepare("SELECT 1 FROM needs_explanation WHERE id = ?").get(id);
    const promoted = !stillVague && !!(this.db.prepare("SELECT 1 FROM supply WHERE id = ?").get(id) ?? this.db.prepare("SELECT 1 FROM demand WHERE id = ?").get(id));
    const stillQueued = new Set(this.db.prepare("SELECT id FROM needs_explanation").all().map((r) => String(r.id)));
    const promotedRecords = affected.filter((a) => a.tab === "vague" && !stillQueued.has(a.id)).length;
    return { id, saved: v.saved, term: v.term, stillVague, promoted, reparsed, promotedRecords };
  }

  /** Records in any tab whose original text contains the term (whole word). Text is read here and never returned. */
  private recordsWithText(term: string): { id: string; tab: Tab }[] {
    const out: { id: string; tab: Tab }[] = [];
    for (const tab of ["supply", "demand", "vague"] as const) {
      for (const r of this.db.prepare(`SELECT id, original_text FROM ${TABLE[tab]} WHERE original_text LIKE ? ESCAPE '\\'`).all(likeOf(term))) {
        if (termIn(String(r.original_text), term)) out.push({ id: String(r.id), tab });
      }
    }
    return out;
  }

  /**
   * Parses again every stored post whose text contains the term, with the current knowledge (the same parser as ingest),
   * and rewrites the posts and their projections when any changed. Returns how many posts contain the term.
   */
  private reparseStored(term: string): number {
    const store = new PeriskopeStore(this.root);
    const posts = store.posts();
    const hits = posts.filter((p) => !!p.originalText && termIn(p.originalText, term));
    if (!hits.length) return 0;
    const terms = this.knownTerms();
    const next = new Map<string, PostRecord>();
    for (const p of hits) {
      const r = reparsePost(p, terms);
      if (JSON.stringify(r) !== JSON.stringify(p)) next.set(p.messageId, r);
    }
    if (next.size) store.reprojectObservation(posts.map((p) => next.get(p.messageId) ?? p));
    return hits.length;
  }

  /** The needs-explanation queue, newest first, each with Bops's best guess at what the post means. */
  openQueue(limit = 200): { total: number; rows: (SearchRow & { guess: string })[] } {
    const terms = this.knownTerms();
    const result = this.search({ kind: "vague", limit });
    return { total: result.total, rows: result.rows.map((r) => ({ ...r, guess: bestGuess(r.originalText ?? "", terms) })) };
  }

  /** Taught knowledge, newest first: the owner's past answers. */
  taught(limit = 100): TaughtRow[] {
    return this.db
      .prepare("SELECT kind, term, area, development, type, listing_type, note, taught_by, taught_at FROM knowledge WHERE source = 'taught' ORDER BY taught_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map((r) => ({
        kind: String(r.kind),
        term: str(r.term),
        area: str(r.area),
        development: str(r.development),
        type: str(r.type),
        listingType: str(r.listing_type),
        note: str(r.note),
        taughtBy: str(r.taught_by),
        taughtAt: str(r.taught_at),
      }));
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

type ValidTeach = {
  answer: string;
  saved: "alias" | "rule" | "note";
  term: string | null;
  area: string | null;
  development: string | null;
  type: string | null;
  listingType: string | null;
  note: string | null;
};

/**
 * One line of answer. A term with a place or type is an alias; a term with sale or rent is a rule; anything else is a note
 * (kept with its term when it has one). A place, type or sale/rent without a term has nothing to match on, so it's refused.
 */
function validateTeach(input: TeachInput): ValidTeach {
  const answer = typeof input?.answer === "string" ? input.answer.replace(/\s+/g, " ").trim() : "";
  if (!answer) throw new SearchInputError("Write what this post means.");
  if (answer.length > 300) throw new SearchInputError("Keep the answer to one line (300 characters at most).");
  const clean = (v: unknown, max = 80) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);
  const termRaw = clean(input.term);
  const term = termRaw ? termRaw.toLowerCase() : null;
  if (term && (term.length < 2 || term.length > 80)) throw new SearchInputError("A term needs 2 to 80 characters.");
  const area = clean(input.area);
  const development = clean(input.development);
  const type = clean(input.type);
  const listingType = clean(input.listingType, 10);
  if (listingType && listingType !== "sale" && listingType !== "rent") throw new SearchInputError("listingType must be sale or rent.");
  const mapping = !!(area || development || type);
  if (!term && (mapping || listingType)) throw new SearchInputError("A place, type or sale/rent needs a term: the words in posts it should match.");
  const note = clean(input.note, 2000) ?? answer;
  const saved = term && mapping ? "alias" : term && listingType ? "rule" : "note";
  return { answer: answer.slice(0, 300), saved, term, area, development, type, listingType, note };
}

/** The taught terms in a store's root, for the parser at ingest. No database yet: none (the built-in gazetteer only). */
export function taughtTermsFrom(root: string): KnownTerm[] {
  if (!existsSync(join(root, SEARCH_DB))) return [];
  const store = SearchStore.open(root);
  try {
    return store.knownTerms();
  } finally {
    store.close();
  }
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
