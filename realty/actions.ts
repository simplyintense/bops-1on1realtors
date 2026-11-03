/**
 * Action items in a chat message: someone asked for something to be done ("please call…", "can someone
 * show…", "need to send…", "follow up with…"), with any @mentions and a due day worked out from the
 * message's own date ("tomorrow", "Friday", "on 5/11").
 */

export type ActionItem = {
  text: string;
  mentions: string[];
  /** YYYY-MM-DD, or null when the message gives no day. */
  due: string | null;
  kind: "viewing" | "call" | "send" | "follow_up" | "other";
};

const ASK = [
  /\b(?:please|pls|plz|kindly)\s+(?:can you\s+)?(call|send|follow[\s-]?up|check|confirm|arrange|schedule|book|show|contact|reach out|share|update|email|forward|get|prepare|look into)\b/i,
  /\b(?:can|could)\s+(?:someone|anyone|somebody|you|u)\s+(\w+)/i,
  /\b(?:need|needs|have)\s+to\s+(\w+)/i,
  /\b(follow[\s-]?up)\s+(?:with|on)\b/i,
  /\b(remind|reminder)\b/i,
  /\b(?:schedule|book|set up|arrange)\s+(?:a\s+)?(viewing|showing|tour|appointment|meeting)\b/i,
  /\b(viewing|showing|tour)\s+(?:is\s+)?(?:on|at|for|tomorrow|today|this)\b/i,
  /^\s*(?:todo|to do|action|task)\s*[:\-–]/i,
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const iso = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

/** A due day from words in `text`, counted from the message's local date (YYYY-MM-DD…). Day/month order as in the export. */
export function dueFrom(text: string, at: string, order: "dmy" | "mdy" = "dmy"): string | null {
  const base = new Date(`${at.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  const t = text.toLowerCase();
  const add = (n: number) => iso(new Date(base.getTime() + n * 86_400_000));
  if (/\b(today|tonight|this (?:morning|afternoon|evening)|asap|urgent(?:ly)?)\b/.test(t)) return add(0);
  if (/\b(tomorrow|tmrw|tmr|2moro)\b/.test(t)) return add(1);
  const wd = /\b(?:on|by|this|next|for)?\s?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t);
  if (wd) {
    let n = (WEEKDAYS.indexOf(wd[1]) - base.getUTCDay() + 7) % 7;
    if (n === 0) n = 7;
    if (/next\s/.test(wd[0]) && n < 7) n += 7;
    return add(n);
  }
  const d = /\b(?:on|by|for)\s(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/.exec(t);
  if (d) {
    const [day, month] = order === "dmy" ? [+d[1], +d[2]] : [+d[2], +d[1]];
    let year = d[3] ? +d[3] : base.getUTCFullYear();
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const when = new Date(Date.UTC(year, month - 1, day));
      if (!d[3] && when < base) when.setUTCFullYear(year + 1);
      return iso(when);
    }
  }
  return null;
}

export function findMentions(text: string): string[] {
  return [...new Set([...text.matchAll(/@(\+?[\d\s]{7,16}\d|[A-Z][\w'’-]*(?:\s[A-Z][\w'’-]*)?)/g)].map((m) => m[1].trim()))];
}

function kindOf(text: string): ActionItem["kind"] {
  if (/\b(viewing|showing|tour|view the|see the (?:house|place|property|apartment))\b/i.test(text)) return "viewing";
  if (/\b(call|phone|ring|reach out|contact)\b/i.test(text)) return "call";
  if (/\b(send|share|email|forward|whatsapp (?:him|her|them))\b/i.test(text)) return "send";
  if (/\bfollow[\s-]?up\b/i.test(text)) return "follow_up";
  return "other";
}

/** The action items in one message (at most one per sentence), or none. */
export function findActions(text: string, at: string, order: "dmy" | "mdy" = "dmy"): ActionItem[] {
  const out: ActionItem[] = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (!ASK.some((re) => re.test(s))) continue;
    if (/^\s*(?:ok|okay|noted|thanks|thank you|done|will do)\b/i.test(s) && s.length < 40) continue;
    // A due day may sit in the next words of the message rather than this sentence.
    out.push({ text: s, mentions: findMentions(s), due: dueFrom(s, at, order) ?? dueFrom(text, at, order), kind: kindOf(s) });
  }
  return out;
}
