import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveMatchStatus, LiveRequest } from "../flow/live-match.ts";
import type { GroupConsent, Kind, MarketIngestItem, PostRecord } from "../flow/periskope.ts";
import { applyStatus, type MatchStatus, type StatusRow } from "../flow/match-status.ts";
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
  posts: "posts.jsonl",
} as const;

export type Collection = keyof typeof FILES;

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
    this.add("posts", row);
    return true;
  }

  /**
   * Insert a post, or fill only fields that were missing (originalText, photos, senderName). Does not
   * duplicate, and does not overwrite text that is already stored.
   */
  upsertPost(row: PostRecord): "added" | "refilled" | "unchanged" {
    const existing = this.post(row.messageId);
    if (!existing) {
      this.add("posts", row);
      return "added";
    }
    const patch: Partial<PostRecord> = {};
    if (!existing.originalText && row.originalText) patch.originalText = row.originalText;
    if (!existing.senderName && row.senderName) patch.senderName = row.senderName;
    if ((!existing.mediaFiles || !existing.mediaFiles.length) && row.mediaFiles?.length) patch.mediaFiles = row.mediaFiles;
    if ((!existing.mediaUrls || !existing.mediaUrls.length) && row.mediaUrls?.length) patch.mediaUrls = row.mediaUrls;
    if (!Object.keys(patch).length) return "unchanged";
    this.updatePost(row.messageId, patch);
    return "refilled";
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

  private storedLive(): Omit<LiveRow, "requestId">[] {
    return this.rows<Omit<LiveRow, "requestId">>("live");
  }

  addLive(row: Omit<LiveRow, "requestId">): void {
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

  /** Sets (or with null, clears) one status. The same status again writes nothing. */
  setMatchStatus(c: { requestId: string; listingKey: string; status: MatchStatus | null; by: string | null; at: string }): { changed: boolean } {
    const next = applyStatus(this.matchStatuses(), c);
    if (next.changed) this.replace("matchStatus", next.rows);
    return { changed: next.changed };
  }

  /** Drops the statuses whose request is no longer live (purged, or the sender opted out). */
  pruneMatchStatuses(): void {
    const ids = new Set(this.live().map((r) => r.requestId));
    this.removeWhere<StatusRow>("matchStatus", (r) => !ids.has(r.requestId));
  }
}
