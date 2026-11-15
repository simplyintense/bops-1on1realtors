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
