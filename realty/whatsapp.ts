/**
 * WhatsApp "Export chat" text → messages. Handles both layouts WhatsApp writes:
 *   iPhone:   [02/11/2026, 14:05:12] Kerry Ann: text        (or [2/11/26, 2:05:12 PM])
 *   Android:  02/11/2026, 14:05 - Kerry Ann: text           (or 2/11/26, 2:05 pm - …)
 * Lines that don't start a message continue the one before. System lines (no "Name:") and media
 * placeholders are kept apart so they never read as leads. Day/month order is worked out from the file
 * (a first number over 12 means day first); when nothing decides it, day first, as in Trinidad.
 */

export type ChatMessage = {
  /** Local time as written in the export (no time zone in the file): YYYY-MM-DDTHH:MM:SS. */
  at: string;
  sender: string;
  text: string;
  /** 1-based line in the export where it starts. */
  line: number;
  system: boolean;
  media: boolean;
};

export type DateOrder = "dmy" | "mdy";

// Invisible marks WhatsApp puts in exports (LRM, RLM, narrow no-break space, BOM…).
const INVISIBLE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const SPACES = /[\u00a0\u202f\u2007]/g;

const IOS = /^\[(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\]\s?(.*)$/;
const ANDROID = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\s+[-–]\s(.*)$/;
const MEDIA = /^(<media omitted>|<attached: .*>|(image|video|audio|sticker|gif|document) omitted|.*\(file attached\)|this message was deleted|you deleted this message)$/i;

// WhatsApp's own notices, which iPhone exports put under the group's name.
const SYSTEM = /^(messages and calls are end-to-end encrypted|messages to this group are now secured|.{0,80} (created group|created this group|changed the subject|changed this group's|added|removed|left|joined using this group's invite link)\b)/i;

type Head = { a: number; b: number; y: number; h: number; m: number; s: number; ampm: string; rest: string };

function head(line: string): Head | null {
  const g = IOS.exec(line) ?? ANDROID.exec(line);
  if (!g) return null;
  return { a: +g[1], b: +g[2], y: +g[3], h: +g[4], m: +g[5], s: g[6] ? +g[6] : 0, ampm: (g[7] ?? "").replace(/[.\s]/g, "").toLowerCase(), rest: g[8] };
}

export function detectOrder(lines: string[]): DateOrder {
  for (const l of lines) {
    const h = head(clean(l));
    if (!h || h.a > 31) continue;
    if (h.a > 12) return "dmy";
    if (h.b > 12) return "mdy";
  }
  return "dmy";
}

const clean = (l: string) => l.replace(INVISIBLE, "").replace(SPACES, " ").replace(/\r$/, "");
const pad = (n: number) => String(n).padStart(2, "0");

function when(h: Head, order: DateOrder): string {
  let year: number, month: number, day: number;
  if (h.a > 31) [year, month, day] = [h.a, h.b, h.y]; // 2026-11-02 style
  else [day, month, year] = order === "dmy" ? [h.a, h.b, h.y] : [h.b, h.a, h.y];
  if (year < 100) year += 2000;
  let hour = h.h;
  if (h.ampm === "pm" && hour < 12) hour += 12;
  if (h.ampm === "am" && hour === 12) hour = 0;
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(h.m)}:${pad(h.s)}`;
}

export function parseChat(text: string, order?: DateOrder): ChatMessage[] {
  const lines = text.split("\n");
  const ord = order ?? detectOrder(lines.slice(0, 500));
  const out: ChatMessage[] = [];
  lines.forEach((raw, i) => {
    const l = clean(raw);
    const h = head(l);
    if (!h) {
      const last = out[out.length - 1];
      if (last && l.trim()) {
        last.text += `\n${l}`;
        last.media = false;
      }
      return;
    }
    // "Name: text"; a name never has a colon, and system lines ("… added …", "Messages and calls are
    // end-to-end encrypted") have none before their text.
    const c = /^([^:]{1,80}?):\s(.*)$/.exec(h.rest) ?? /^([^:]{1,80}?):$/.exec(h.rest);
    const sender = c ? c[1].trim() : "";
    const body = c ? (c[2] ?? "").trim() : h.rest.trim();
    const notice = SYSTEM.test(body);
    out.push({ at: when(h, ord), sender, text: body, line: i + 1, system: !c || notice, media: MEDIA.test(body) });
  });
  return out;
}
