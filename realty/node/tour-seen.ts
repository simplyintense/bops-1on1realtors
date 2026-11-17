import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl } from "./jsonl.ts";

/**
 * Who has seen the staff tour, per user: an append-only JSONL file in the Periskope store root (tour-seen.jsonl), one
 * line per first mark: { email (lowercased), at (ISO time) }. Only the server writes it, for the signed-in viewer (the
 * POST route at app/api/realty/tour). Node-only; the pure tour logic is app/realty/tour-steps.ts.
 */

export const TOUR_SEEN_FILE = "tour-seen.jsonl";

const normal = (email: string) => email.trim().toLowerCase();

/** Has this email seen the tour? Unreadable or missing lines are skipped; a missing file means nobody has. */
export function hasSeenTour(email: string, root: string): boolean {
  const who = normal(email);
  if (!who) return false;
  let text: string;
  try {
    text = readFileSync(join(root, TOUR_SEEN_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      if (normal(String((JSON.parse(line) as { email?: unknown }).email ?? "")) === who) return true;
    } catch {
      // A torn or foreign line is not a mark.
    }
  }
  return false;
}

/** Records that this email has seen the tour. Idempotent: a second call writes nothing. Returns true when it wrote. */
export function markTourSeen(email: string, root: string, now: Date = new Date()): boolean {
  const who = normal(email);
  if (!who || hasSeenTour(who, root)) return false;
  appendJsonl(join(root, TOUR_SEEN_FILE), JSON.stringify({ email: who, at: now.toISOString() }));
  return true;
}
