import type { CrmRole } from "./crm-role.ts";

/**
 * The staff sidebar's links as plain data (no React), so a test can check hrefs, labels, order, the role split and the active
 * item without rendering. The markup is staff-sidebar.tsx, which copies the 1on1 CRM's sidebar (UnifiedSidebar.tsx) and reads
 * this list. Every CRM link is a same-tab link to the CRM's domain. Market Search is the one link to the desk.
 */

export const CRM_ORIGIN = "https://1on1realtors.com";

/** The icon names. staff-sidebar.tsx maps each one to the Lucide icon of the same name. */
export type CrmIcon =
  | "Shield"
  | "LayoutDashboard"
  | "Search"
  | "Briefcase"
  | "Users"
  | "Plus"
  | "UsersRound"
  | "Home"
  | "Building2"
  | "MessageSquare"
  | "ListChecks"
  | "ClipboardList"
  | "Mail"
  | "Settings"
  | "UserCog"
  | "Send"
  | "BarChart"
  | "Activity"
  | "Sparkles"
  | "ImageDown"
  | "Cable"
  | "User"
  | "LogOut";

export type CrmItem = { readonly label: string; readonly to: string; readonly icon: CrmIcon; readonly roles: readonly CrmRole[] };
export type CrmGroup = { readonly label: string; readonly icon: CrmIcon; readonly roles: readonly CrmRole[]; readonly items: readonly CrmItem[] };

const BOTH: readonly CrmRole[] = ["super_admin", "admin"];
const SUPER: readonly CrmRole[] = ["super_admin"];

/** The top links, above Market Search. */
export const CRM_TOP: readonly CrmItem[] = [
  { label: "Admin Dashboard", to: "/admin", icon: "Shield", roles: SUPER },
  { label: "Dashboard", to: "/agent/dashboard", icon: "LayoutDashboard", roles: BOTH },
];

/** The collapsible groups, in the CRM's order. */
export const CRM_GROUPS: readonly CrmGroup[] = [
  {
    label: "CRM",
    icon: "Briefcase",
    roles: BOTH,
    items: [
      { label: "My Clients", to: "/agent/crm", icon: "Users", roles: BOTH },
      { label: "Add Client", to: "/agent/crm/add", icon: "Plus", roles: BOTH },
      { label: "All Clients", to: "/admin/crm", icon: "UsersRound", roles: SUPER },
      { label: "Team Client Activity", to: "/admin/crm/leaderboard", icon: "UsersRound", roles: BOTH },
    ],
  },
  {
    label: "Properties",
    icon: "Building2",
    roles: BOTH,
    items: [
      { label: "My Properties", to: "/agent/properties", icon: "Home", roles: BOTH },
      { label: "Add Property", to: "/agent/properties/new", icon: "Plus", roles: BOTH },
      { label: "All Properties", to: "/admin/properties", icon: "Building2", roles: SUPER },
      { label: "Team Property Activity", to: "/admin/properties/leaderboard", icon: "Building2", roles: BOTH },
    ],
  },
  {
    label: "Communications",
    icon: "MessageSquare",
    roles: BOTH,
    items: [
      { label: "Tasks", to: "/agent/tasks", icon: "ListChecks", roles: BOTH },
      { label: "All Tasks", to: "/admin/tasks", icon: "ClipboardList", roles: SUPER },
      { label: "My Inquiries", to: "/agent/inquiries", icon: "MessageSquare", roles: BOTH },
      { label: "All Inquiries", to: "/admin/inquiries", icon: "MessageSquare", roles: SUPER },
      { label: "Contact Submissions", to: "/admin/contacts", icon: "Mail", roles: SUPER },
    ],
  },
  {
    label: "Management",
    icon: "Settings",
    roles: SUPER,
    items: [
      { label: "User Management", to: "/admin/users", icon: "UserCog", roles: SUPER },
      { label: "Agents", to: "/admin/agents", icon: "Users", roles: SUPER },
      { label: "Agent Invites", to: "/admin/invites", icon: "Send", roles: SUPER },
    ],
  },
  {
    label: "Analytics & Logs",
    icon: "BarChart",
    roles: BOTH,
    items: [
      { label: "Analytics", to: "/admin/analytics", icon: "BarChart", roles: SUPER },
      { label: "All Activity", to: "/admin/activity-logs", icon: "Activity", roles: SUPER },
      { label: "AI Usage & Cost", to: "/admin/ai-usage", icon: "Sparkles", roles: SUPER },
      { label: "Task Performance", to: "/admin/tasks/analytics", icon: "ListChecks", roles: SUPER },
      { label: "Image Optimization", to: "/admin/image-optimization", icon: "ImageDown", roles: SUPER },
      { label: "My Activity", to: "/agent/activity", icon: "Activity", roles: BOTH },
    ],
  },
];

/** The groups open on first render. The rest start closed. The desk is never a CRM page, so none opens because of the page. */
export const CRM_GROUPS_OPEN_BY_DEFAULT: readonly string[] = ["CRM", "Properties", "Communications"];

/** The footer links above Back to Site, in the CRM's order. */
export const CRM_FOOTER: readonly CrmItem[] = [
  { label: "MCP settings", to: "/agent/mcp-settings", icon: "Cable", roles: BOTH },
  { label: "My Profile", to: "/agent/profile", icon: "User", roles: BOTH },
  { label: "Settings", to: "/admin/settings", icon: "Settings", roles: SUPER },
];

export const CRM_BACK_TO_SITE: CrmItem = { label: "Back to Site", to: "/", icon: "Home", roles: BOTH };

/** Market Search: the desk's own page. Active on /realty/search and on a stored post's page. */
export const DESK_MARKET_SEARCH = { label: "Market Search", href: "/realty/search", icon: "Search" } as const;

/** Logout: the desk's gate sign-out (clears the bops_gate cookie). Labelled Logout, as in the CRM. */
export const LOGOUT = { label: "Logout", href: "/api/gate/logout", icon: "LogOut" } as const;

/** The desk links the sidebar shows. The guided tour's nav steps use this list: a page with no sidebar link has no nav step. */
export const SIDEBAR_DESK_HREFS: readonly string[] = [DESK_MARKET_SEARCH.href];

/** The sidebar's heading and its line under it: the Admin Portal for a super admin, the Agent Portal for an agent. */
export function portalHeader(role: CrmRole): { readonly title: string; readonly subtitle: string } {
  return role === "super_admin"
    ? { title: "Admin Portal", subtitle: "Full access management" }
    : { title: "Agent Portal", subtitle: "Manage your work" };
}

/** A CRM route, as the same-tab URL on the CRM's domain. */
export function crmHref(to: string): string {
  return `${CRM_ORIGIN}${to}`;
}

/** What this role sees, in the CRM's order. A group with no visible item is dropped, as the CRM drops it. */
export function crmSidebar(role: CrmRole): {
  readonly top: readonly CrmItem[];
  readonly groups: readonly CrmGroup[];
  readonly footer: readonly CrmItem[];
} {
  const sees = (roles: readonly CrmRole[]) => roles.includes(role);
  return {
    top: CRM_TOP.filter((i) => sees(i.roles)),
    groups: CRM_GROUPS.filter((g) => sees(g.roles))
      .map((g) => ({ ...g, items: g.items.filter((i) => sees(i.roles)) }))
      .filter((g) => g.items.length > 0),
    footer: CRM_FOOTER.filter((i) => sees(i.roles)),
  };
}

/**
 * Whether a desk link is the page being shown. Market Search (/realty/search) is also the current item on a stored post's page.
 * All posts is current only on its own list, not on a post under it. Workspace is current only at /.
 */
const POST_PAGE = /^\/realty\/posts\/[A-Za-z0-9_-]+$/;

export function isCurrentPage(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/realty/posts") return pathname === href;
  if (href === "/realty/search") return pathname === href || pathname.startsWith(`${href}/`) || POST_PAGE.test(pathname);
  return pathname === href || pathname.startsWith(`${href}/`);
}
