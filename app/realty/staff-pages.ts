/**
 * The staff pages' nav entries, as plain data so a test can check labels, order and gating without rendering React
 * (app/realty/staff-nav.tsx renders them). Owners' pages are listed only for owners, and the teach page only for teachers;
 * the page checks themselves are on the server (viewer.ts). "Bops home" is the Bops chat app at / (the old home), listed for
 * owners only (an agent is sent to the desk from /): the nav is the one top nav on every staff-facing page, / included.
 */
export const STAFF_PAGES: readonly StaffPageEntry[] = [
  { href: "/realty/desk", label: "Desk", ownerOnly: false, teacherOnly: false },
  { href: "https://1on1realtors.com", label: "Public site", ownerOnly: false, teacherOnly: false, external: true },
  { href: "/realty/automatch", label: "1on1 CRM Automatch", ownerOnly: true, teacherOnly: false },
  { href: "/realty/search", label: "Supply & Demand", ownerOnly: true, teacherOnly: false },
  { href: "/realty/posts", label: "All posts", ownerOnly: true, teacherOnly: false },
  { href: "/realty/market", label: "Online search", ownerOnly: false, teacherOnly: false },
  { href: "/realty/digest", label: "Digest", ownerOnly: true, teacherOnly: false },
  { href: "/realty/alerts", label: "Auto-Match Alert", ownerOnly: true, teacherOnly: false },
  { href: "/realty/learn", label: "Teach Bops", ownerOnly: false, teacherOnly: true },
  { href: "/", label: "Bops home", ownerOnly: true, teacherOnly: false },
];

/** An entry: an internal /realty page or Bops home, or (external: true) the public site, opened in a new tab. */
export type StaffPageEntry = {
  readonly href: string;
  readonly label: string;
  readonly ownerOnly: boolean;
  readonly teacherOnly: boolean;
  readonly external?: true;
};

export type StaffPage = StaffPageEntry;

/** The data-tour id of a nav link (the guided tour spotlights it): nav-desk, nav-market, ... and nav-home for "/". */
export function navTourId(href: string): string {
  if (href.startsWith("http")) return "nav-public-site";
  return href === "/" ? "nav-home" : `nav-${href.split("/").filter(Boolean).pop()}`;
}

/** The entries this viewer may see, in nav order. */
export function visibleStaffPages(viewer: { owner: boolean; teacher: boolean }): StaffPage[] {
  return STAFF_PAGES.filter((p) => (viewer.owner || !p.ownerOnly) && (viewer.teacher || !p.teacherOnly));
}
