import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveMatchStatus, LiveRequest } from "../flow/live-match.ts";
import { developmentNameOf, foldPrice, priceKey, setOf, unknownPlaceHints, type PriceRangeRow, type StrongAlert, type UnknownPlace } from "../flow/observe.ts";
import { applyRecordOverride, type GroupConsent, type Kind, type KindOverride, type MarketIngestItem, type PostRecord } from "../flow/periskope.ts";
import { applyStatus, type StatusChange, type StatusRow } from "../flow/match-status.ts";
import type { MatchSeenRow } from "../flow/automatch-leads.ts";
import type { AlertSentRow } from "../flow/automatch-alert.ts";
import type { DailySummarySentRow } from "../flow/daily-summary.ts";
import type { MatchItem } from "../flow/recommendations.ts";
import { appendJsonl } from "./jsonl.ts";

/**
 * Node-only I/O for the Periskope intake. The decisions are in realty/flow/periskope.ts; this file only
 * reads and writes. One JSONL file per collection, the same privacy as jsonl.ts: a 0700 directory and
 * 0600 files. Appends use appendJsonl; deletes and consent updates rewrite the file through a temp file
 * and a rename, so a crash leaves the old file or the new one, never half of each.
 */

/**
 * The desk's id for a WhatsApp request: the first 24 hex characters of the SHA-256 of its message id. The message id can
 * carry a sender's number, so the pages and the status buttons only ever see this.
 */
export const requestIdOf = (messageId: string): string => createHash("sha256").update(messageId).digest("hex").slice(0, 24);

export type SeenRow = { id: string; senderPhone: string | null; kind: Kind; at: string };
export type OptOutRow = { senderPhone: string; at: string };
/** A lead this route created: links an opt-out or purge to the lead in the flow's snapshot. */
export type LeadRow = { leadId: string; messageId: string; senderPhone: string; receivedAt: string };

/**
 * A WhatsApp buyer request and its live matches (live-match.ts). Structured facts only, never the message text.
 * senderPhone is the posting agent's own number: it ties the request to an agent on the desk, and opt-out and
 * retention remove the row with the sender's other records. status "pending" means matching hasn't finished.
 */
export type LiveRow = {
  messageId: string;
  /** Derived on read by live(), never stored: requestIdOf(messageId). */
  requestId: string;
  chatId: string;
  senderPhone: string;
  receivedAt: string;
  request: LiveRequest;
  status: LiveMatchStatus | "pending";
  matchedAt: string | null;
  matches: MatchItem[];
  /** Our own CRM listings that fit, each with its holder agent. Missing on rows from before the CRM was connected. */
  ours?: MatchItem[];
};

/** A queued market-ingest POST (listing, request, group or optout). status pending is retried later, never inline. */
export type MarketOutboxRow = {
  localId: string;
  item: MarketIngestItem;
  at: string;
  status: "pending" | "sent" | "rejected";
  lastError?: string;
  remoteId?: number;
  deduped?: boolean;
  remoteGroup?: { group: string; active: boolean; adminOk: boolean };
};

const FILES = {
  seen: "seen.jsonl",
  optOut: "opt-out.jsonl",
  consent: "consent.jsonl",
  market: "market-outbox.jsonl",
  leads: "leads.jsonl",
  live: "live-matches.jsonl",
  matchStatus: "match-status.jsonl",
  matchSeen: "match-seen.jsonl",
  automatchAlertSent: "automatch-alert-sent.jsonl",
  dailySummarySent: "daily-summary-sent.jsonl",
  posts: "posts.jsonl",
  supply: "supply.jsonl",
  demand: "demand.jsonl",
  priceRanges: "price-ranges.jsonl",
  unknownPlaces: "unknown-places.jsonl",
  alerts: "alerts.jsonl",
  kindOverrides: "kind-overrides.jsonl",
} as const;

export type Collection = keyof typeof FILES;

const saleOrRent = (t: PostRecord["listingType"]): t is "sale" | "rent" => t === "sale" || t === "rent";

/** The records the intake keeps under one root (default .data/realty/periskope). */
export class PeriskopeStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private file(c: Collection): string {
    return join(/*turbopackIgnore: true*/ this.root, FILES[c]);
  }

  private rows<T>(c: Collection): T[] {
    const file = this.file(c);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          // A torn line from a crash: skip it rather than fail every request.
          return [];
        }
      });
  }

  private replace<T>(c: Collection, rows: T[]): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = this.file(c);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    renameSync(tmp, file);
  }

  private add<T>(c: Collection, row: T): void {
    appendJsonl(this.file(c), JSON.stringify(row));
  }

  /** Removes the rows that match and returns them. Rewrites the file only if something matched. */
  removeWhere<T>(c: Collection, drop: (row: T) => boolean): T[] {
    const all = this.rows<T>(c);
    const gone = all.filter(drop);
    if (gone.length) this.replace(c, all.filter((r) => !drop(r)));
    return gone;
  }

  /* ---- seen message ids (the dedupe key is message_id) ---- */

  seenRows(): SeenRow[] {
    return this.rows<SeenRow>("seen");
  }

  isSeen(messageId: string): boolean {
    return this.seenRows().some((r) => r.id === messageId);
  }

  markSeen(row: SeenRow): void {
    this.add("seen", row);
  }

  /* ---- structured posts (no message body) ---- */

  posts(): PostRecord[] {
    return this.rows<PostRecord>("posts");
  }

  post(messageId: string): PostRecord | null {
    return this.posts().find((r) => r.messageId === messageId) ?? null;
  }

  /** False if this messageId is already stored. */
  addPost(row: PostRecord): boolean {
    if (this.post(row.messageId)) return false;
    this.add("posts", this.withKindOverride(row));
    return true;
  }

  /**
   * Insert a post, or fill only fields that were missing (originalText, photos, senderName). Does not
   * duplicate, and does not overwrite text that is already stored.
   */
  upsertPost(row: PostRecord): "added" | "refilled" | "unchanged" {
    const existing = this.post(row.messageId);
    if (!existing) {
      const added = this.withKindOverride(row);
      this.add("posts", added);
      this.observe(added, true);
      return "added";
    }
    const patch: Partial<PostRecord> = {};
    if (!existing.originalText && row.originalText) patch.originalText = row.originalText;
    if (!existing.senderName && row.senderName) patch.senderName = row.senderName;
    if (!existing.groupName && row.groupName) patch.groupName = row.groupName;
    if ((!existing.mediaFiles || !existing.mediaFiles.length) && row.mediaFiles?.length) patch.mediaFiles = row.mediaFiles;
    if ((!existing.mediaHashes || !existing.mediaHashes.length) && row.mediaHashes?.length) patch.mediaHashes = row.mediaHashes;
    if ((!existing.mediaUrls || !existing.mediaUrls.length) && row.mediaUrls?.length) patch.mediaUrls = row.mediaUrls;
    if (!Object.keys(patch).length) {
      this.observe(existing, false);
      return "unchanged";
    }
    const next = this.updatePost(row.messageId, patch);
    if (next) this.observe(next, false);
    return "refilled";
  }

  supply(): PostRecord[] { return this.rows<PostRecord>("supply"); }
  demand(): PostRecord[] { return this.rows<PostRecord>("demand"); }
  priceRanges(): PriceRangeRow[] { return this.rows<PriceRangeRow>("priceRanges"); }
  unknownPlaces(): UnknownPlace[] { return this.rows<UnknownPlace>("unknownPlaces"); }

  /** Counts place names the matcher doesn't know yet (one row per name, the count and last seen). Names only: never text or groups. */
  noteUnknownPlaces(names: readonly string[], at: string): void {
    if (!names.length) return;
    const all = this.unknownPlaces();
    for (const name of names) {
      const i = all.findIndex((r) => r.name.toLowerCase() === name.toLowerCase());
      if (i >= 0) all[i] = { ...all[i], count: all[i].count + 1, lastSeenAt: at };
      else all.push({ name, count: 1, firstSeenAt: at, lastSeenAt: at });
    }
    this.replace("unknownPlaces", all);
  }
  alerts(): StrongAlert[] { return this.rows<StrongAlert>("alerts"); }

  /** Project a parsed post into the supply or demand set, and update price and unknown-place knowledge. */
  observe(row: PostRecord, recordKnowledge = true, at = row.sentAt): void {
    const post = this.withKindOverride(row);
    const side = post.set ?? setOf(post.category);
    if (side === "supply") this.upsertSet("supply", { ...post, set: "supply", development: post.development ?? developmentNameOf(post.area) });
    if (side === "demand") this.upsertSet("demand", { ...post, set: "demand", development: post.development ?? developmentNameOf(post.area) });
    if (recordKnowledge && side && post.area && post.price != null && saleOrRent(post.listingType) && post.currency) {
      const base = { area: post.area, development: post.development ?? developmentNameOf(post.area), beds: post.beds, listingType: post.listingType, currency: post.currency, side };
      const all = this.priceRanges();
      const k = priceKey(base);
      const i = all.findIndex((r) => priceKey(r) === k);
      const next = foldPrice(i >= 0 ? all[i] : null, post.price, at, base);
      if (i >= 0) all[i] = next;
      else all.push(next);
      this.replace("priceRanges", all);
    }
    if (recordKnowledge && side && !post.area && post.originalText) {
      this.noteUnknownPlaces(unknownPlaceHints(post.originalText), at);
    }
  }

  private upsertSet(c: "supply" | "demand", row: PostRecord): void {
    const all = this.rows<PostRecord>(c);
    const i = all.findIndex((r) => r.messageId === row.messageId);
    if (i < 0) this.add(c, row);
    else {
      all[i] = { ...all[i], ...row, messageId: row.messageId };
      this.replace(c, all);
    }
  }

  /** Idempotent: the same request and listing url is stored once. Never sends. */
  addAlert(row: StrongAlert): boolean {
    const key = `${row.messageId}|${row.listingUrl ?? row.listingTitle}`;
    if (this.alerts().some((a) => `${a.messageId}|${a.listingUrl ?? a.listingTitle}` === key)) return false;
    this.add("alerts", row);
    return true;
  }

  updatePost(messageId: string, patch: Partial<PostRecord>): PostRecord | null {
    const all = this.posts();
    const i = all.findIndex((r) => r.messageId === messageId);
    if (i < 0) return null;
    const next = { ...all[i], ...patch, messageId };
    all[i] = next;
    this.replace("posts", all);
    return next;
  }

  /** Several posts' patches in one rewrite. Rewrites only if a patch changes a post. */
  patchPosts(patches: Map<string, Partial<PostRecord>>): void {
    if (!patches.size) return;
    const all = this.posts();
    let changed = false;
    for (const [i, row] of all.entries()) {
      const patch = patches.get(row.messageId);
      if (!patch) continue;
      all[i] = { ...row, ...patch };
      changed = true;
    }
    if (changed) this.replace("posts", all);
  }

  /**
   * Rewrite posts, supply, demand and price ranges after a re-parse. Demand and supply are rebuilt
   * from scratch so a post that changed sides is not left in both. Never sends.
   */
  reprojectObservation(posts: PostRecord[]): void {
    const overrides = this.kindOverrides();
    const ignored = new Set(overrides.filter((o) => o.status === "ignored").map((o) => o.messageId));
    const projected = posts.map((p) => this.withKindOverride(p));
    this.replace("posts", projected);
    const visible = projected.filter((p) => !ignored.has(p.messageId));
    this.replace("supply", visible.filter((p) => (p.set ?? setOf(p.category)) === "supply"));
    this.replace("demand", visible.filter((p) => (p.set ?? setOf(p.category)) === "demand"));
    const ranges: PriceRangeRow[] = [];
    for (const row of [...visible].sort((a, b) => a.sentAt.localeCompare(b.sentAt))) {
      const side = row.set ?? setOf(row.category);
      if (!side || !row.area || row.price == null || !saleOrRent(row.listingType) || !row.currency) continue;
      const base = { area: row.area, development: row.development ?? developmentNameOf(row.area), beds: row.beds, listingType: row.listingType, currency: row.currency, side };
      const i = ranges.findIndex((r) => priceKey(r) === priceKey(base));
      const folded = foldPrice(i >= 0 ? ranges[i] : null, row.price, row.sentAt, base);
      if (i >= 0) ranges[i] = folded;
      else ranges.push(folded);
    }
    this.replace("priceRanges", ranges);
  }

  /** Replace the alert list (used after a full rematch so stale alerts are dropped). Never sends. */
  replaceAlerts(rows: StrongAlert[]): void {
    this.replace("alerts", rows);
  }


  /* ---- kind overrides (a staff correction of supply/demand, honoured on rebuild) ---- */

  kindOverrides(): KindOverride[] {
    const last = new Map<string, KindOverride>();
    for (const row of this.rows<KindOverride>("kindOverrides")) {
      if (row?.messageId) last.set(row.messageId, row);
    }
    return [...last.values()];
  }

  /** Insert or replace the override for this message (fields merge). Does not reproject; call reprojectObservation after. */
  setKindOverride(row: KindOverride): KindOverride {
    const prev = this.kindOverrides().find((r) => r.messageId === row.messageId);
    const next: KindOverride = { ...prev, ...row, messageId: row.messageId, at: row.at ?? new Date().toISOString(), by: row.by ?? prev?.by ?? null, reason: row.reason ?? prev?.reason ?? null };
    const all = this.kindOverrides().filter((r) => r.messageId !== next.messageId);
    this.replace("kindOverrides", [...all, next]);
    return next;
  }

  /** Drop the override for this message, if any. Does not reproject. */
  clearKindOverride(messageId: string): boolean {
    const all = this.kindOverrides();
    if (!all.some((r) => r.messageId === messageId)) return false;
    this.replace("kindOverrides", all.filter((r) => r.messageId !== messageId));
    return true;
  }

  private withKindOverride(row: PostRecord): PostRecord {
    const over = this.kindOverrides().find((r) => r.messageId === row.messageId);
    return over ? applyRecordOverride(row, over) : row;
  }

  /* ---- opt-outs (normalized sender numbers) ---- */

  optOuts(): string[] {
    return this.rows<OptOutRow>("optOut").map((r) => r.senderPhone);
  }

  /** Returns false if the number was already opted out. */
  addOptOut(senderPhone: string, at: string): boolean {
    if (this.optOuts().includes(senderPhone)) return false;
    this.add("optOut", { senderPhone, at });
    return true;
  }

  /* ---- group consent ---- */

  consents(): GroupConsent[] {
    return this.rows<GroupConsent>("consent");
  }

  consent(chatId: string): GroupConsent | null {
    return this.consents().find((c) => c.chatId === chatId) ?? null;
  }

  /** Inserts or replaces the record for its chatId. */
  setConsent(next: GroupConsent): GroupConsent {
    const all = this.consents().filter((c) => c.chatId !== next.chatId);
    this.replace("consent", [...all, next]);
    return next;
  }

  /* ---- leads this route created, and the market-ingest outbox ---- */

  leads(): LeadRow[] {
    return this.rows<LeadRow>("leads");
  }

  addLead(row: LeadRow): void {
    if (this.leads().some((r) => r.messageId === row.messageId)) return;
    this.add("leads", row);
  }

  market(): MarketOutboxRow[] {
    return this.rows<MarketOutboxRow>("market");
  }

  enqueueMarket(item: MarketIngestItem, at: string): MarketOutboxRow {
    const row: MarketOutboxRow = { localId: randomUUID(), item, at, status: "pending" };
    this.add("market", row);
    return row;
  }

  updateMarket(localId: string, patch: Partial<MarketOutboxRow>): MarketOutboxRow | null {
    const all = this.market();
    const i = all.findIndex((r) => r.localId === localId);
    if (i < 0) return null;
    const next = { ...all[i], ...patch, localId, item: patch.item ?? all[i].item };
    all[i] = next;
    this.replace("market", all);
    return next;
  }

  /* ---- WhatsApp buyer requests and their live matches ---- */

  live(): LiveRow[] {
    return this.storedLive().map((r) => ({ ...r, requestId: requestIdOf(r.messageId) }));
  }

  /** The live requests the desk and digest show: not those marked not a lead (a kind override with status ignored). */
  liveShown(): LiveRow[] {
    const ignored = new Set(this.kindOverrides().filter((o) => o.status === "ignored").map((o) => o.messageId));
    return this.live().filter((r) => !ignored.has(r.messageId));
  }

  private storedLive(): Omit<LiveRow, "requestId">[] {
    return this.rows<Omit<LiveRow, "requestId">>("live");
  }

  addLive(row: Omit<LiveRow, "requestId">): void {
    if (this.storedLive().some((r) => r.messageId === row.messageId)) return;
    this.add("live", row);
  }

  updateLive(messageId: string, patch: Partial<Omit<LiveRow, "messageId" | "requestId">>): LiveRow | null {
    const all = this.storedLive();
    const i = all.findIndex((r) => r.messageId === messageId);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch, messageId };
    this.replace("live", all);
    return { ...all[i], requestId: requestIdOf(messageId) };
  }

  /* ---- match follow-up: a status per request and listing (Bops's own record; nothing is sent) ---- */

  matchStatuses(): StatusRow[] {
    return this.rows<StatusRow>("matchStatus");
  }

  /** Sets (or with null, clears) one status and its feedback. The same status, reason and note again writes nothing. */
  setMatchStatus(c: StatusChange): { changed: boolean } {
    const next = applyStatus(this.matchStatuses(), c);
    if (next.changed) this.replace("matchStatus", next.rows);
    return { changed: next.changed };
  }

  /**
   * Drops the statuses and first-seen rows whose request is gone: not live, and not a stored post either (purged, or the
   * sender opted out). An Automatch ask is a stored post, so its outcome outlives the live window and goes with the post.
   */
  pruneMatchStatuses(): void {
    const ids = new Set([...this.live().map((r) => r.requestId), ...this.posts().map((p) => requestIdOf(p.messageId))]);
    this.removeWhere<StatusRow>("matchStatus", (r) => !ids.has(r.requestId));
    this.removeWhere<MatchSeenRow>("matchSeen", (r) => !ids.has(r.requestId));
    this.removeWhere<AlertSentRow>("automatchAlertSent", (r) => !ids.has(r.requestId));
  }

  /* ---- first seen per pair (Automatch: when Bops first saw a pair, for the stale rule); Bops's own record ---- */

  matchSeenRows(): MatchSeenRow[] {
    return this.rows<MatchSeenRow>("matchSeen");
  }

  /** Appends the pairs not yet recorded (the first sighting stands). Returns how many were added. */
  recordMatchSeen(rows: readonly MatchSeenRow[]): number {
    const known = new Set(this.matchSeenRows().map((r) => `${r.requestId}|${r.listingKey}`));
    let added = 0;
    for (const r of rows) {
      const key = `${r.requestId}|${r.listingKey}`;
      if (known.has(key)) continue;
      known.add(key);
      this.add("matchSeen", r);
      added += 1;
    }
    return added;
  }

  /* ---- Auto-Match Alert sent keys (each strong pair is emailed at most once) ---- */

  automatchAlertSentRows(): AlertSentRow[] {
    return this.rows<AlertSentRow>("automatchAlertSent");
  }

  /** Records keys not yet stored (the first kind stands). Returns how many were added. */
  recordAutomatchAlertSent(rows: readonly AlertSentRow[]): number {
    const known = new Set(this.automatchAlertSentRows().map((r) => `${r.requestId}|${r.listingKey}`));
    let added = 0;
    for (const r of rows) {
      const key = `${r.requestId}|${r.listingKey}`;
      if (known.has(key)) continue;
      known.add(key);
      this.add("automatchAlertSent", r);
      added += 1;
    }
    return added;
  }

  /** After a successful send (or a Resend idempotent replay), mark the key as sent. Upserts if it was suppressed. */
  markAutomatchAlertSent(row: AlertSentRow): void {
    const key = `${row.requestId}|${row.listingKey}`;
    const all = this.automatchAlertSentRows();
    const i = all.findIndex((r) => `${r.requestId}|${r.listingKey}` === key);
    const next: AlertSentRow = { ...row, kind: "sent" };
    if (i >= 0) {
      if (all[i].kind === "sent") return;
      all[i] = next;
      this.replace("automatchAlertSent", all);
      return;
    }
    this.add("automatchAlertSent", next);
  }

  /* ---- Daily Auto-Match summary (one morning email per AST day) ---- */

  dailySummarySentRows(): DailySummarySentRow[] {
    return this.rows<DailySummarySentRow>("dailySummarySent");
  }

  /** Records one successful morning send for a day. A second row for the same day is ignored. */
  recordDailySummarySent(row: DailySummarySentRow): boolean {
    if (this.dailySummarySentRows().some((r) => r.dayKey === row.dayKey)) return false;
    this.add("dailySummarySent", row);
    return true;
  }
}
