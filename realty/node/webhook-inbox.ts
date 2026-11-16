import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

/** Claimed batches (see claimInbox) are renamed to webhook-inbox.<id>.claim; one left by a crash is picked up again. */
const CLAIM = /^webhook-inbox\.[A-Za-z0-9-]+\.claim$/;

function parseLines(text: string): InboxItem[] {
  return text
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

function claimFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => CLAIM.test(n))
    .sort()
    .map((n) => join(root, n));
}

/** Every queued item (claimed batches first, then the live file) in arrival order. A torn line is skipped. Never throws on a missing file. */
export function readInbox(root: string): InboxItem[] {
  const file = inboxFile(root);
  const files = [...claimFiles(root), ...(existsSync(file) ? [file] : [])];
  return files.flatMap((f) => parseLines(readFileSync(f, "utf8")));
}

/**
 * Takes the queue for one drain without a lock against appends: the live file is renamed to a claim file in one step,
 * so a delivery appended while the drain is still processing lands in a fresh live file and is never overwritten.
 * `release(keep)` appends the items to retry back onto the live file and removes the claim files. Claim files a crash
 * left behind are included, so nothing is lost (a re-handled message is deduplicated by its message id).
 */
export function claimInbox(root: string): { items: InboxItem[]; release: (keep: InboxItem[]) => void } {
  const file = inboxFile(root);
  if (existsSync(file)) {
    const stamp = `${Date.now().toString().padStart(15, "0")}-${crypto.randomUUID()}`;
    renameSync(file, join(root, `webhook-inbox.${stamp}.claim`));
  }
  const claimed = claimFiles(root);
  const items = claimed.flatMap((f) => parseLines(readFileSync(f, "utf8")));
  return {
    items,
    release: (keep) => {
      for (const i of keep) appendJsonl(file, JSON.stringify(i));
      for (const f of claimed) unlinkSync(f);
    },
  };
}

/** Rewrites the queue with `items` (atomic: tmp file, 0600, then rename). */
export function writeInbox(root: string, items: InboxItem[]): void {
  const file = inboxFile(root);
  writeFileSync(`${file}.tmp`, items.map((i) => `${JSON.stringify(i)}\n`).join(""), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
