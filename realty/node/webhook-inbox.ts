import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl } from "./jsonl.ts";

/**
 * The durable queue for the signed Periskope webhook. A verified delivery is appended here (0600, in the 0700 intake
 * root) before anything is processed, so the route can answer 200 once it is queued. periskope-intake.ts drains it:
 * an item is removed when it is handled, and kept with attempts+1 when handling throws. The 10-minute poller drains
 * it too, so retries happen even if the process restarted. The body is stored as base64 of the raw bytes (the same
 * bytes the signature covered). Nothing here logs or reads the body.
 */

export const WEBHOOK_INBOX_FILE = "webhook-inbox.jsonl";

export type InboxItem = {
  id: string;
  receivedAt: string;
  /** Always base64: the raw request bytes, exactly as Periskope signed them. */
  body: string;
  attempts: number;
};

function inboxFile(root: string): string {
  return join(root, WEBHOOK_INBOX_FILE);
}

/** Appends one item (0600). Throws if the file can't be written; the caller then refuses the delivery so Periskope retries it. */
export function appendInboxItem(root: string, raw: Uint8Array, at: Date, id: string = crypto.randomUUID()): InboxItem {
  const item: InboxItem = { id, receivedAt: at.toISOString(), body: Buffer.from(raw).toString("base64"), attempts: 0 };
  appendJsonl(inboxFile(root), JSON.stringify(item));
  return item;
}

/** The queued items in arrival order. A torn line from a crash is skipped. Never throws on a missing file. */
export function readInbox(root: string): InboxItem[] {
  const file = inboxFile(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const v = JSON.parse(line) as Partial<InboxItem>;
        return typeof v.id === "string" && typeof v.body === "string" ? [{ id: v.id, receivedAt: String(v.receivedAt ?? ""), body: v.body, attempts: Number(v.attempts) || 0 }] : [];
      } catch {
        return [];
      }
    });
}

/** Rewrites the queue with `items` (atomic: tmp file, 0600, then rename). */
export function writeInbox(root: string, items: InboxItem[]): void {
  const file = inboxFile(root);
  writeFileSync(`${file}.tmp`, items.map((i) => `${JSON.stringify(i)}\n`).join(""), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
