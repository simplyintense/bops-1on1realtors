/**
 * Times in Trinidad's clock (AST, America/Port_of_Spain, no daylight saving). Shared by the desk, the exports and the admin digest,
 * so every place shows the same "2026-11-14 09:44 AST". Pure: the time comes in as an ISO string. Portable: no node:*, no next,
 * no bare process.
 */

const AST = "America/Port_of_Spain";

/** Date in AST, e.g. "2026-11-14 09:44 AST". An unreadable time gives "". */
export function dateAst(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} AST`;
}

/** The 24-hour clock in AST, e.g. "07:00", or "" when the time is unreadable. */
export function clockHmAst(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: AST, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${hour}:${get("minute")}`;
}

/** The calendar date in AST, e.g. "2026-11-15", or "" when the time is unreadable. */
export function dayKeyAst(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: AST, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Clock time in AST, e.g. "2:15 PM AST". An unreadable time gives "". */
export function timeAst12(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AST,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayPeriod = get("dayPeriod").toUpperCase();
  return `${get("hour")}:${get("minute")} ${dayPeriod} AST`;
}

/**
 * A day relative to `now` in AST: "earlier today", "yesterday", or "on Fri 13 Nov". An unreadable time gives "".
 */
export function relativeDayAst(iso: string, now: Date): string {
  const posted = dayKeyAst(iso);
  const today = dayKeyAst(now);
  if (!posted || !today) return "";
  if (posted === today) return "earlier today";
  const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Walk back one calendar day in AST (not raw 24h, in case of exact timezone edge; AST has no DST so 24h is the previous civil day).
  if (posted === dayKeyAst(y)) return "yesterday";
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: AST, weekday: "short", day: "numeric", month: "short" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `on ${get("weekday")} ${get("day")} ${get("month")}`;
}

/**
 * The soft mention line for an Auto-Match Alert: "A contact mentioned this property on WhatsApp earlier today at 2:15 PM AST."
 * Empty when the posted time is unreadable.
 */
export function mentionedOnWhatsApp(iso: string, now: Date): string {
  const day = relativeDayAst(iso, now);
  const time = timeAst12(iso);
  if (!day || !time) return "";
  return `A contact mentioned this property on WhatsApp ${day} at ${time}.`;
}

/**
 * The long calendar date in AST for the alert's opening line, e.g. "Tuesday 10 Nov". Always the calendar date, never "today" or
 * "yesterday". An unreadable time gives "".
 */
export function longDateAst(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: AST, weekday: "long", day: "numeric", month: "short" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}`;
}

/** A short date and the clock time in AST, e.g. "Tue 10 Nov, 5:30 PM AST". An unreadable time gives "". */
export function shortDateTimeAst(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: AST, weekday: "short", day: "numeric", month: "short" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}, ${timeAst12(iso)}`;
}
