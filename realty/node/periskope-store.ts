import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveMatchStatus, LiveRequest } from "../flow/live-match.ts";
import type { GroupConsent, Kind, MarketIngestItem } from "../flow/periskope.ts";
import type { MatchItem } from "../flow/recommendations.ts";
import { appendJsonl } from "./jsonl.ts";

/**
 * Node-only I/O for the Periskope intake. The decisions are in realty/flow/periskope.ts; this file only
 * reads and writes. One JSONL file per collection, the same privacy as jsonl.ts: a 0700 directory and
 * 0600 files. Appends use appendJsonl; deletes and consent updates rewrite the file through a temp file
 * and a rename, so a crash leaves the old file or the new one, never half of each.
 */

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
  chatId: string;
  senderPhone: string;
  receivedAt: string;
  request: LiveRequest;
  status: LiveMatchStatus | "pending";
  matchedAt: string | null;
  matches: MatchItem[];
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
    return this.rows<LiveRow>("live");
  }

  addLive(row: LiveRow): void {
    this.add("live", row);
  }

  updateLive(messageId: string, patch: Partial<Omit<LiveRow, "messageId">>): LiveRow | null {
    const all = this.live();
    const i = all.findIndex((r) => r.messageId === messageId);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch, messageId };
    this.replace("live", all);
    return all[i];
  }
}
