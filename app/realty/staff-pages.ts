/**
 * The staff desk's pages, as plain data so a test can check labels, order and gating without rendering React. The Bops home's
 * top nav (staff-nav.tsx) and the guided tour read this list. The left sidebar's AI Desk group (sidebar-model.ts DESK_LINKS)
 * lists the same nine pages in the same order. The 1on1 CRM's pages are not here: they are the CRM's own links in the sidebar model.
 *
 * These pages are in the AI Desk sidebar for all signed-in staff, so every entry is open to owners, teachers and agents alike
 * ("let them see everything, for now"). The owner-only and teacher-only APIs behind them stay owner- or teacher-only (lib/gate.ts),
 * and the pages hide their mutation buttons from anyone who isn't an owner or teacher. "Bot Workspace" is the chat app at / (the
 * old home). The ownerOnly and teacherOnly flags stay on each entry so a page can be closed again in one line.
 */
export const STAFF_PAGES: readonly StaffPageEntry[] = [
  { href: "/realty/desk", label: "Desk", ownerOnly: false, teacherOnly: false },
  { href: "/realty/search", label: "Message Search (WA)", ownerOnly: false, teacherOnly: false },
  { href: "/realty/market", label: "Online search", ownerOnly: false, teacherOnly: false },
  { href: "/realty/automatch", label: "Automatch", ownerOnly: false, teacherOnly: false },
  { href: "/realty/posts", label: "All posts", ownerOnly: false, teacherOnly: false },
  { href: "/realty/digest", label: "Digest", ownerOnly: false, teacherOnly: false },
  { href: "/realty/alerts", label: "Auto-Match Alert", ownerOnly: false, teacherOnly: false },
  { href: "/realty/learn", label: "Teach", ownerOnly: false, teacherOnly: false },
  { href: "/", label: "Bot Workspace", ownerOnly: false, teacherOnly: false },
];

/** An entry: an internal /realty page, or the chat app at / (Bot Workspace). */
export type StaffPageEntry = {
  readonly href: string;
  readonly label: string;
  readonly ownerOnly: boolean;
  readonly teacherOnly: boolean;
};

export type StaffPage = StaffPageEntry;

/** The data-tour id of a nav link (the guided tour spotlights it): nav-desk, nav-search, ... and nav-home for "/". */
export function navTourId(href: string): string {
  return href === "/" ? "nav-home" : `nav-${href.split("/").filter(Boolean).pop()}`;
}

/** The entries this viewer may see, in nav order. */
export function visibleStaffPages(viewer: { owner: boolean; teacher: boolean }): StaffPage[] {
  return STAFF_PAGES.filter((p) => (viewer.owner || !p.ownerOnly) && (viewer.teacher || !p.teacherOnly));
}

/**
 * Who may open Message Search (WA) (/realty/search) and a stored post (/realty/posts/<id>): any signed-in staff (viewer.ts staff),
 * and owners. The owners' post list and every owner API keep their own checks. The gate (lib/gate.ts) lets the same people in.
 */
export function staffMayOpen(viewer: { staff: boolean; owner: boolean }): boolean {
  return viewer.staff || viewer.owner;
}
