/**
 * The staff desk's pages, as plain data so a test can check labels, order and gating without rendering React. The Bops home's
 * top nav (staff-nav.tsx) and the guided tour read this list. The left sidebar is the CRM's own (sidebar-model.ts), so it shows
 * only Market Search from here; the other pages stay reachable by URL. The 1on1 CRM's pages are not here: they are the CRM's
 * own links in the sidebar model.
 *
 * Owners' pages are listed only for owners, and the teach page only for teachers; the page checks themselves are on the server
 * (viewer.ts). "Workspace" is the Bops chat app at / (the old home), listed for owners only (an agent is sent to the desk from /).
 * Market Search (/realty/search) is listed for every staff member: its owner-only parts (online feed, export, original text) are
 * hidden by the page itself (app/realty/search/page.tsx), and its APIs stay owner-only.
 */
export const STAFF_PAGES: readonly StaffPageEntry[] = [
  { href: "/realty/desk", label: "Desk", ownerOnly: false, teacherOnly: false },
  { href: "/realty/automatch", label: "1on1 CRM Automatch", ownerOnly: true, teacherOnly: false },
  { href: "/realty/search", label: "Market Search", ownerOnly: false, teacherOnly: false },
  { href: "/realty/posts", label: "All posts", ownerOnly: true, teacherOnly: false },
  { href: "/realty/market", label: "Online search", ownerOnly: false, teacherOnly: false },
  { href: "/realty/digest", label: "Digest", ownerOnly: true, teacherOnly: false },
  { href: "/realty/alerts", label: "Auto-Match Alert", ownerOnly: true, teacherOnly: false },
  { href: "/realty/learn", label: "Teach", ownerOnly: false, teacherOnly: true },
  { href: "/", label: "Workspace", ownerOnly: true, teacherOnly: false },
];

/** An entry: an internal /realty page, or the Bops chat app at / (Workspace). */
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
 * Who may open Market Search (/realty/search) and a stored post (/realty/posts/<id>): any signed-in staff (viewer.ts staff),
 * and owners. The owners' post list and every owner API keep their own checks. The gate (lib/gate.ts) lets the same people in.
 */
export function staffMayOpen(viewer: { staff: boolean; owner: boolean }): boolean {
  return viewer.staff || viewer.owner;
}
