import { navTourId, visibleStaffPages } from "./staff-pages.ts";

/**
 * The staff sidebar's links as plain data (no React), so a test can check the routes, the same-tab rule, the active item and what
 * each viewer sees without rendering. The component is staff-sidebar.tsx. The CRM links are the 1on1 Realtors agent pages on
 * the CRM's own domain: same-tab anchors, never new windows.
 */

export const CRM_ORIGIN = "https://1on1realtors.com";
/** The public logo. The sidebar falls back to LOGO_FALLBACK (a file in public/) only if this one fails to load. */
export const CRM_LOGO = `${CRM_ORIGIN}/logo.png`;
export const LOGO_FALLBACK = "/realty/1on1-realtors-logo.png";

export type CrmLink = { readonly key: string; readonly label: string; readonly href: string };

/** The CRM's agent pages, in the CRM sidebar's order. "Public site" is the public website (Back to Site). */
export const CRM_LINKS: readonly CrmLink[] = [
  { key: "dashboard", label: "Dashboard", href: `${CRM_ORIGIN}/agent/dashboard` },
  { key: "properties", label: "Properties", href: `${CRM_ORIGIN}/agent/properties` },
  { key: "clients", label: "Clients", href: `${CRM_ORIGIN}/agent/crm` },
  { key: "inquiries", label: "Inquiries", href: `${CRM_ORIGIN}/agent/inquiries` },
  { key: "tasks", label: "Tasks", href: `${CRM_ORIGIN}/agent/tasks` },
  { key: "mcp-settings", label: "MCP settings", href: `${CRM_ORIGIN}/agent/mcp-settings` },
  { key: "profile", label: "My Profile", href: `${CRM_ORIGIN}/agent/profile` },
  { key: "public-site", label: "Public site", href: `${CRM_ORIGIN}/` },
];

export type SidebarStaffLink = { readonly label: string; readonly href: string; readonly tourId: string; readonly current: boolean };
export type SidebarModel = { readonly staff: readonly SidebarStaffLink[]; readonly crm: readonly CrmLink[] };

/** A stored post's page: /realty/posts/<request id> (the id is hex or base64url, as requestIdOf makes it). */
const POST_PAGE = /^\/realty\/posts\/[A-Za-z0-9_-]+$/;

/**
 * Whether a staff entry is the page being shown. Market Search (/realty/search) is also the current item on a stored post's page.
 * All posts is current only on its own list, not on a post under it. Workspace is current only at /.
 */
export function isCurrentPage(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/realty/posts") return pathname === href;
  if (href === "/realty/search") return pathname === href || pathname.startsWith(`${href}/`) || POST_PAGE.test(pathname);
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The sidebar for this viewer on this path: the staff entries they may see (nav order), then the CRM links. */
export function sidebarModel(viewer: { owner: boolean; teacher: boolean }, pathname: string): SidebarModel {
  return {
    staff: visibleStaffPages(viewer).map((p) => ({
      label: p.label,
      href: p.href,
      tourId: navTourId(p.href),
      current: isCurrentPage(p.href, pathname),
    })),
    crm: CRM_LINKS,
  };
}
