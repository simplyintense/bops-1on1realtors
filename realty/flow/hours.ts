import { runtimeEnv } from "./env.ts";
/**
 * Business hours for the agent-reply SLA (Wendy/Crystal: an agent answers within 15 minutes during
 * business hours). Offer deadlines count only business time: an inquiry at 16:50 with a 15-minute window
 * is due at 08:05 the next business morning, not at 17:05.
 *
 * Always Port of Spain time. Trinidad keeps AST (UTC-4) all year with no DST, so local time is UTC minus
 * four hours and the math needs no tz database. Pure functions, no clock of their own.
 */

export const BUSINESS_TZ = "America/Port_of_Spain" as const;

/** AST is UTC-4 all year. */
const OFFSET_MS = -4 * 3_600_000;
const DAY_MS = 86_400_000;

export type BusinessHours = {
  /** "HH:MM", local, inclusive. */
  start: string;
  /** "HH:MM", local, exclusive. Must be after start (no overnight windows). */
  end: string;
  /** Business days, 0 = Sunday … 6 = Saturday. */
  days: number[];
  tz: typeof BUSINESS_TZ;
  /** True while the hours (or the days) are our guess, not confirmed by 1on1. */
  placeholder: boolean;
};

/**
 * PLACEHOLDER. Official business hours have NOT yet been confirmed with Wendy/Crystal. This default
 * (08:00–17:00, Monday–Friday, Port of Spain) is a placeholder for the 15-minute SLA clock only.
 * Set ONEON1_BUSINESS_HOURS and ONEON1_BUSINESS_DAYS once they confirm the real hours.
 */
export const PLACEHOLDER_BUSINESS_HOURS: BusinessHours = Object.freeze({
  start: "08:00",
  end: "17:00",
  days: Object.freeze([1, 2, 3, 4, 5]) as number[],
  tz: BUSINESS_TZ,
  placeholder: true,
});

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "08:00-17:00" or "8:00-17:00" → { start: "08:00", end: "17:00" }; null if it isn't a valid same-day window. */
export function parseHours(text: string): { start: string; end: string } | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || h2 > 24 || m1 > 59 || m2 > 59 || (h2 === 24 && m2 > 0)) return null;
  const start = `${String(h1).padStart(2, "0")}:${String(m1).padStart(2, "0")}`;
  const end = `${String(h2).padStart(2, "0")}:${String(m2).padStart(2, "0")}`;
  return minutes(start) < minutes(end) ? { start, end } : null;
}

/**
 * "mon-fri", "mon,tue,wed,thu,fri", "mon-fri,sat", "Monday,Friday" → sorted day numbers. Ranges may wrap
 * ("fri-mon"). Null if any part isn't a day.
 */
export function parseDays(text: string): number[] | null {
  const day = (s: string) => {
    const i = DAY_NAMES.indexOf(s.trim().toLowerCase().slice(0, 3));
    return i >= 0 && s.trim().length >= 3 ? i : null;
  };
  const out = new Set<number>();
  const parts = text.split(",").filter((p) => p.trim());
  if (!parts.length) return null;
  for (const part of parts) {
    const [a, b, ...rest] = part.split("-");
    if (rest.length) return null;
    const from = day(a);
    const to = b === undefined ? from : day(b);
    if (from === null || to === null) return null;
    for (let d = from; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === to) break;
    }
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * ONEON1_BUSINESS_HOURS ("08:00-17:00") and ONEON1_BUSINESS_DAYS ("mon-fri"). Each one that is set and
 * valid replaces that part of the placeholder; an unset or unreadable value keeps the placeholder's.
 * `placeholder` is false only when BOTH are set and valid.
 */
export function businessHoursFromEnv(env: Record<string, string | undefined> = runtimeEnv()): BusinessHours {
  const hours = env.ONEON1_BUSINESS_HOURS ? parseHours(env.ONEON1_BUSINESS_HOURS) : null;
  const days = env.ONEON1_BUSINESS_DAYS ? parseDays(env.ONEON1_BUSINESS_DAYS) : null;
  return {
    start: hours?.start ?? PLACEHOLDER_BUSINESS_HOURS.start,
    end: hours?.end ?? PLACEHOLDER_BUSINESS_HOURS.end,
    days: days ?? [...PLACEHOLDER_BUSINESS_HOURS.days],
    tz: BUSINESS_TZ,
    placeholder: !(hours && days),
  };
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Local midnight (as a UTC instant) of the local day `date` falls on, and that day's weekday. */
function localDay(date: Date): { midnight: number; weekday: number } {
  const local = date.getTime() + OFFSET_MS;
  const localMidnight = Math.floor(local / DAY_MS) * DAY_MS;
  return { midnight: localMidnight - OFFSET_MS, weekday: new Date(localMidnight).getUTCDay() };
}

/** True iff `date` is on a business day, at or after start and before end (end is exclusive). */
export function isBusinessTime(date: Date, hours: BusinessHours): boolean {
  const { midnight, weekday } = localDay(date);
  if (!hours.days.includes(weekday)) return false;
  const into = date.getTime() - midnight;
  return into >= minutes(hours.start) * 60_000 && into < minutes(hours.end) * 60_000;
}

/** The instant business time next starts at or after `from` (`from` itself if it is business time). */
export function nextBusinessOpen(from: Date, hours: BusinessHours): Date {
  if (!hours.days.length) throw new Error("business hours have no business days");
  if (isBusinessTime(from, hours)) return from;
  const { midnight, weekday } = localDay(from);
  const startMs = minutes(hours.start) * 60_000;
  for (let i = 0; i <= 7; i++) {
    const open = midnight + i * DAY_MS + startMs;
    if (hours.days.includes((weekday + i) % 7) && open >= from.getTime()) return new Date(open);
  }
  throw new Error("no business open within a week"); // unreachable with at least one business day
}

/**
 * The instant at which `ms` of business time has elapsed after `from`. Outside business hours the count
 * starts at the next business open. 0 ms from inside hours is `from` itself; 0 ms from outside hours is
 * the next open. A window that runs out exactly at close is due at close (e.g. 16:45 + 15 min → 17:00).
 */
export function addBusinessMs(from: Date, ms: number, hours: BusinessHours): Date {
  if (!(ms >= 0)) throw new Error(`can't add ${ms} ms of business time`);
  let left = ms;
  let t = from;
  for (;;) {
    t = nextBusinessOpen(t, hours);
    const close = localDay(t).midnight + minutes(hours.end) * 60_000;
    const room = close - t.getTime();
    if (left <= room) return new Date(t.getTime() + left);
    left -= room;
    t = new Date(close);
  }
}
