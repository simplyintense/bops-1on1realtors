/**
 * The staff pages' nav entries, as plain data so a test can check labels, order and gating without rendering React
 * (app/realty/staff-nav.tsx renders them). Owners' pages are listed only for owners, and the teach page only for teachers;
 * the page checks themselves are on the server (viewer.ts).
 */
export const STAFF_PAGES = [
  { href: "/realty/desk", label: "Desk", ownerOnly: false, teacherOnly: false },
  { href: "/realty/automatch", label: "1on1 CRM Automatch", ownerOnly: true, teacherOnly: false },
  { href: "/realty/search", label: "Supply & Demand", ownerOnly: true, teacherOnly: false },
  { href: "/realty/posts", label: "All posts", ownerOnly: true, teacherOnly: false },
  { href: "/realty/market", label: "Online search", ownerOnly: false, teacherOnly: false },
  { href: "/realty/digest", label: "Digest", ownerOnly: true, teacherOnly: false },
  { href: "/realty/learn", label: "Teach Bops", ownerOnly: false, teacherOnly: true },
] as const;

export type StaffPage = (typeof STAFF_PAGES)[number];

/** The entries this viewer may see, in nav order. */
export function visibleStaffPages(viewer: { owner: boolean; teacher: boolean }): StaffPage[] {
  return STAFF_PAGES.filter((p) => (viewer.owner || !p.ownerOnly) && (viewer.teacher || !p.teacherOnly));
}
