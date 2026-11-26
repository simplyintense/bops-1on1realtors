import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as lucide from "lucide-react";
import { CRM_SUPER_ADMIN_EMAILS, crmRole, type CrmRole } from "../../app/realty/crm-role.ts";
import {
  CRM_BACK_TO_SITE,
  CRM_FOOTER,
  CRM_GROUPS,
  AI_DESK_GROUP,
  CRM_GROUPS_OPEN_BY_DEFAULT,
  CRM_ORIGIN,
  DESK_LINKS,
  LOGOUT,
  SIDEBAR_DESK_HREFS,
  crmHref,
  crmSidebar,
  isCurrentPage,
  portalHeader,
} from "../../app/realty/sidebar-model.ts";
import { navTourId } from "../../app/realty/staff-pages.ts";

/**
 * The staff sidebar copies the 1on1 CRM's staff sidebar (UnifiedSidebar.tsx). The model (app/realty/sidebar-model.ts) is checked
 * as data; the role rule (app/realty/crm-role.ts) too. The component (app/realty/staff-sidebar.tsx) and the theme CSS are checked
 * as source, because these tests run without React or a browser.
 */

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
const SIDEBAR = source("app/realty/staff-sidebar.tsx");
const LAYOUT = source("app/realty/layout.tsx");
const THEME = source("app/realty/realty-theme.css");
const GLOBALS = source("app/globals.css");
const TOUR = source("app/realty/desk-tour.tsx");

const SUPER: CrmRole = "super_admin";
const AGENT: CrmRole = "admin";

/** Strips the component's own comments, so the checks are about what renders. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every link a role sees, in the sidebar's order: [label, href]. */
function linksFor(role: CrmRole): [string, string][] {
  const side = crmSidebar(role);
  return [
    ...side.top.map((i): [string, string] => [i.label, crmHref(i.to)]),
    ...DESK_LINKS.map((i): [string, string] => [i.label, i.href]),
    ...side.groups.flatMap((g) => g.items.map((i): [string, string] => [i.label, crmHref(i.to)])),
    ...side.footer.map((i): [string, string] => [i.label, crmHref(i.to)]),
    [CRM_BACK_TO_SITE.label, crmHref(CRM_BACK_TO_SITE.to)],
    [LOGOUT.label, LOGOUT.href],
  ];
}

const labelsFor = (role: CrmRole) => linksFor(role).map(([label]) => label);

test("the role: a desk owner, or a listed CRM super admin, is the Admin Portal; any other signed-in email is the Agent Portal", () => {
  assert.equal(crmRole({ email: "someone@example.com", owner: true }), SUPER, "an owner");
  assert.equal(crmRole({ email: null, owner: true }), SUPER, "the gate off: an owner");
  for (const email of CRM_SUPER_ADMIN_EMAILS) {
    assert.equal(crmRole({ email, owner: false }), SUPER, "a listed super admin");
    assert.equal(crmRole({ email: `  ${email.toUpperCase()} `, owner: false }), SUPER, "case and spaces are the same person");
  }
  assert.equal(crmRole({ email: "kerry@1on1.example", owner: false }), AGENT, "any other staff member");
  assert.equal(crmRole({ email: null, owner: false }), AGENT, "nobody signed in");
  assert.equal(crmRole({ email: "", owner: false }), AGENT, "an empty email");
});

test("the Admin Portal sees the whole CRM; the Agent Portal sees only the agent pages", () => {
  const superLabels = labelsFor(SUPER);
  const agentLabels = labelsFor(AGENT);
  for (const label of ["Admin Dashboard", "All Clients", "All Tasks", "All Inquiries", "All Properties", "Contact Submissions", "User Management", "Agents", "Agent Invites", "Analytics", "All Activity", "AI Usage & Cost", "Task Performance", "Image Optimization", "Settings"]) {
    assert.ok(superLabels.includes(label), `the Admin Portal shows ${label}`);
    assert.ok(!agentLabels.includes(label), `the Agent Portal does not show ${label}`);
  }
  for (const label of ["Dashboard", "Desk", "Message Search (WA)", "Online search", "Automatch", "All posts", "Digest", "Auto-Match Alert", "Teach", "Bot Workspace", "My Clients", "Add Client", "Team Client Activity", "My Properties", "Add Property", "Team Property Activity", "Tasks", "My Inquiries", "My Activity", "MCP settings", "My Profile", "Back to Site", "Logout"]) {
    assert.ok(agentLabels.includes(label), `the Agent Portal shows ${label}`);
    assert.ok(superLabels.includes(label), `the Admin Portal shows ${label}`);
  }
});

test("the groups and the top and footer links, in the CRM's order and counts; Management is the Admin Portal's", () => {
  assert.deepEqual(crmSidebar(SUPER).groups.map((g) => g.label), ["CRM", "Properties", "Communications", "Management", "Analytics & Logs"]);
  assert.deepEqual(crmSidebar(AGENT).groups.map((g) => g.label), ["CRM", "Properties", "Communications", "Analytics & Logs"]);
  assert.deepEqual(crmSidebar(SUPER).groups.map((g) => g.items.length), [4, 4, 5, 3, 6]);
  assert.deepEqual(crmSidebar(AGENT).groups.map((g) => g.items.length), [3, 3, 2, 1]);
  assert.deepEqual(crmSidebar(AGENT).groups.at(-1)?.items.map((i) => i.label), ["My Activity"]);
  assert.deepEqual(crmSidebar(SUPER).top.map((i) => i.label), ["Admin Dashboard", "Dashboard"]);
  assert.deepEqual(crmSidebar(AGENT).top.map((i) => i.label), ["Dashboard"]);
  assert.deepEqual(crmSidebar(SUPER).footer.map((i) => i.label), ["MCP settings", "My Profile", "Settings"]);
  assert.deepEqual(crmSidebar(AGENT).footer.map((i) => i.label), ["MCP settings", "My Profile"]);
  assert.deepEqual(CRM_GROUPS_OPEN_BY_DEFAULT, ["AI Desk", "CRM", "Properties", "Communications"], "AI Desk and the three CRM groups open by default; Management and Analytics start closed");
  assert.equal(CRM_GROUPS.length, 5);
});

test("the links are the CRM's exact routes on its domain, and the AI Desk group is the desk's nine pages", () => {
  assert.equal(CRM_ORIGIN, "https://1on1realtors.com");
  assert.deepEqual(linksFor(SUPER), [
    ["Admin Dashboard", "https://1on1realtors.com/admin"],
    ["Dashboard", "https://1on1realtors.com/agent/dashboard"],
    ["Desk", "/realty/desk"],
    ["Message Search (WA)", "/realty/search"],
    ["Online search", "/realty/market"],
    ["Automatch", "/realty/automatch"],
    ["All posts", "/realty/posts"],
    ["Digest", "/realty/digest"],
    ["Auto-Match Alert", "/realty/alerts"],
    ["Teach", "/realty/learn"],
    ["Bot Workspace", "/"],
    ["My Clients", "https://1on1realtors.com/agent/crm"],
    ["Add Client", "https://1on1realtors.com/agent/crm/add"],
    ["All Clients", "https://1on1realtors.com/admin/crm"],
    ["Team Client Activity", "https://1on1realtors.com/admin/crm/leaderboard"],
    ["My Properties", "https://1on1realtors.com/agent/properties"],
    ["Add Property", "https://1on1realtors.com/agent/properties/new"],
    ["All Properties", "https://1on1realtors.com/admin/properties"],
    ["Team Property Activity", "https://1on1realtors.com/admin/properties/leaderboard"],
    ["Tasks", "https://1on1realtors.com/agent/tasks"],
    ["All Tasks", "https://1on1realtors.com/admin/tasks"],
    ["My Inquiries", "https://1on1realtors.com/agent/inquiries"],
    ["All Inquiries", "https://1on1realtors.com/admin/inquiries"],
    ["Contact Submissions", "https://1on1realtors.com/admin/contacts"],
    ["User Management", "https://1on1realtors.com/admin/users"],
    ["Agents", "https://1on1realtors.com/admin/agents"],
    ["Agent Invites", "https://1on1realtors.com/admin/invites"],
    ["Analytics", "https://1on1realtors.com/admin/analytics"],
    ["All Activity", "https://1on1realtors.com/admin/activity-logs"],
    ["AI Usage & Cost", "https://1on1realtors.com/admin/ai-usage"],
    ["Task Performance", "https://1on1realtors.com/admin/tasks/analytics"],
    ["Image Optimization", "https://1on1realtors.com/admin/image-optimization"],
    ["My Activity", "https://1on1realtors.com/agent/activity"],
    ["MCP settings", "https://1on1realtors.com/agent/mcp-settings"],
    ["My Profile", "https://1on1realtors.com/agent/profile"],
    ["Settings", "https://1on1realtors.com/admin/settings"],
    ["Back to Site", "https://1on1realtors.com/"],
    ["Logout", "/api/gate/logout"],
  ]);
  assert.deepEqual(
    linksFor(AGENT).filter(([, href]) => href.startsWith("https://")).map(([, href]) => href).slice(0, 3),
    ["https://1on1realtors.com/agent/dashboard", "https://1on1realtors.com/agent/crm", "https://1on1realtors.com/agent/crm/add"],
  );
  assert.deepEqual(SIDEBAR_DESK_HREFS, DESK_LINKS.map((l) => l.href), "the nine AI Desk hrefs, in order");
});

test("every CRM link is same-tab: no new window, no target, anywhere in the sidebar", () => {
  const markup = code(SIDEBAR);
  assert.ok(!/_blank|noopener|noreferrer|target=/.test(markup), "no target, no new-window rel");
  // The CRM links are plain anchors on the CRM's URL.
  assert.ok(markup.includes("<a href={crmHref(item.to)}"), "a plain anchor on the CRM URL");
  for (const [, href] of linksFor(SUPER)) {
    if (href.startsWith("https://")) assert.ok(href.startsWith(`${CRM_ORIGIN}/`), href);
  }
});

test("each AI Desk link is current on its own page; Message Search (WA) is also current on a stored post; All posts is not; Bot Workspace only at /", () => {
  for (const link of DESK_LINKS) {
    assert.equal(isCurrentPage(link.href, link.href), true, link.href);
  }
  for (const path of ["/realty/search", "/realty/search/", "/realty/posts/abc123DEF"]) {
    assert.equal(isCurrentPage("/realty/search", path), true, path);
  }
  assert.equal(isCurrentPage("/realty/posts", "/realty/posts"), true);
  assert.equal(isCurrentPage("/realty/posts", "/realty/posts/abc123DEF"), false, "All posts is the list only");
  assert.equal(isCurrentPage("/", "/"), true);
  assert.equal(isCurrentPage("/", "/realty/desk"), false, "Bot Workspace is the root only");
  for (const path of ["/realty/desk", "/realty/posts", "/realty/market", "/realty/learn", "/"]) {
    assert.equal(isCurrentPage("/realty/search", path), false, path);
  }
  const markup = code(SIDEBAR);
  assert.ok(markup.includes("current ? LINK_ACTIVE : SUB_LINK"), "the active style is per AI Desk link");
  assert.ok(markup.includes('aria-current={current ? "page" : undefined}'));
  assert.ok(markup.includes("deskCurrent ? GROUP_TRIGGER_CURRENT : GROUP_TRIGGER"), "the group header is muted when a child is current");
});

test("the active and inactive classes are the CRM's; the active one is purple with light text on a 1rem radius", () => {
  assert.ok(SIDEBAR.includes("bg-primary text-primary-foreground"), "active: bg-primary text-primary-foreground");
  assert.ok(SIDEBAR.includes("text-muted-foreground hover:bg-muted hover:text-foreground"), "inactive: muted text, muted hover");
  assert.ok(SIDEBAR.includes("rounded-lg"), "rounded-lg");
  // rounded-lg is var(--radius) in globals.css (@theme inline), and the theme sets --radius to 1rem.
  assert.ok(GLOBALS.includes("--radius-lg: var(--radius);"), "rounded-lg follows --radius");
  const theme = THEME.match(/\.realty-theme\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(/--radius:\s*1rem;/.test(theme), "--radius is 1rem inside .realty-theme");
  assert.ok(theme.includes("--destructive: 0 84.2% 60.2%;"), "the CRM's destructive red");
});

test("the sidebar's shapes and sizes are the CRM's: aside, header, nav, footer, icons, groups", () => {
  for (const cls of [
    "w-64 bg-background border-r border-border flex flex-col h-screen",
    "p-6 border-b border-border",
    "text-xl font-bold",
    "text-sm text-muted-foreground mt-1",
    "flex-1 p-4 space-y-1 overflow-y-auto",
    "px-4 pb-6 space-y-2 border-t border-border pt-4",
    "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-sm font-medium w-full",
    "space-y-1 pl-4",
    "h-5 w-5",
    "h-4 w-4",
    "rotate-180",
    "text-destructive hover:bg-destructive/10",
  ]) {
    assert.ok(SIDEBAR.includes(cls), cls);
  }
  assert.ok(SIDEBAR.includes("const isOpen = openGroups[group.label] ?? false"), "a group starts closed unless listed as open");
  assert.ok(SIDEBAR.includes("setOpenGroups((prev) => ({ ...prev, [group.label]: !isOpen }))"), "the group toggles on its own");
});

test("the colour classes the sidebar uses are pinned inside .realty-theme, so they resolve to the theme's tokens", () => {
  const escape = (cls: string) => cls.replace(/[:/]/g, (m) => `\\${m}`);
  for (const cls of [
    "bg-background",
    "bg-muted",
    "bg-primary",
    "border-border",
    "text-foreground",
    "text-muted-foreground",
    "text-primary-foreground",
    "text-destructive",
    "hover:bg-muted",
    "hover:text-foreground",
    "hover:bg-destructive/10",
  ]) {
    assert.ok(SIDEBAR.includes(cls), `the sidebar uses ${cls}`);
    assert.ok(THEME.includes(`.realty-theme .${escape(cls)}`), `${cls} is pinned in the theme`);
  }
  assert.ok(THEME.includes(".realty-theme .bg-primary {\n  background-color: hsl(var(--primary));"), "purple, from the bare HSL token");
  assert.ok(THEME.includes(".realty-theme .text-destructive {\n  color: hsl(var(--destructive));"), "destructive from its token");
  assert.ok(GLOBALS.includes("@theme inline") && GLOBALS.includes("--color-primary: var(--primary);"), "why: the root theme inlines the tokens");
});

test("Logout is the desk's gate sign-out: labelled Logout, pointing at GET /api/gate/logout, which exists", () => {
  assert.equal(LOGOUT.label, "Logout");
  assert.equal(LOGOUT.href, "/api/gate/logout");
  assert.ok(code(SIDEBAR).includes("href={LOGOUT.href}"));
  assert.ok(code(SIDEBAR).includes("<span>{LOGOUT.label}</span>"));
  assert.ok(existsSync(fileURLToPath(new URL("../../app/api/gate/logout/route.ts", import.meta.url))), "the route is there");
  assert.ok(!/bops/i.test(LOGOUT.label), "no Bops on the button");
});

test("the header: Admin Portal with its line for a super admin, Agent Portal with 'Manage your work' for an agent; no logo", () => {
  assert.deepEqual(portalHeader(SUPER), { title: "Admin Portal", subtitle: "Full access management" });
  assert.deepEqual(portalHeader(AGENT), { title: "Agent Portal", subtitle: "Manage your work" });
  const markup = code(SIDEBAR);
  assert.ok(markup.includes("{header.title}") && markup.includes("{header.subtitle}"), "the header is the model's");
  assert.ok(!/<img|_LOGO|LOGO_FALLBACK|logo\.png/.test(markup), "no logo in the sidebar");
});

test("the icons are the CRM's Lucide icons, each present in lucide-react under the same name", () => {
  const names = new Set<string>(["ChevronDown", AI_DESK_GROUP.icon, LOGOUT.icon, CRM_BACK_TO_SITE.icon, ...DESK_LINKS.map((l) => l.icon)]);
  for (const i of [...crmSidebar(SUPER).top, ...CRM_FOOTER, ...CRM_GROUPS.flatMap((g) => g.items)]) names.add(i.icon);
  for (const g of CRM_GROUPS) names.add(g.icon);
  for (const name of names) {
    assert.ok((lucide as Record<string, unknown>)[name] !== undefined, `lucide-react has ${name}`);
  }
  assert.equal(CRM_GROUPS.find((g) => g.label === "CRM")?.icon, "Briefcase");
  assert.equal(CRM_GROUPS.find((g) => g.label === "Analytics & Logs")?.icon, "BarChart");
  assert.equal(AI_DESK_GROUP.icon, "Sparkles");
  assert.deepEqual(DESK_LINKS.map((l) => l.icon), ["LayoutGrid", "Search", "Globe", "GitCompareArrows", "FileText", "Newspaper", "Bell", "GraduationCap", "Bot"]);
});

test("the AI Desk group lists the nine desk pages in order, with Sparkles, open by default; old labels are gone", () => {
  assert.equal(AI_DESK_GROUP.label, "AI Desk");
  assert.equal(AI_DESK_GROUP.icon, "Sparkles");
  assert.ok(CRM_GROUPS_OPEN_BY_DEFAULT.includes("AI Desk"));
  assert.deepEqual(
    DESK_LINKS.map((l) => [l.label, l.href, l.icon]),
    [
      ["Desk", "/realty/desk", "LayoutGrid"],
      ["Message Search (WA)", "/realty/search", "Search"],
      ["Online search", "/realty/market", "Globe"],
      ["Automatch", "/realty/automatch", "GitCompareArrows"],
      ["All posts", "/realty/posts", "FileText"],
      ["Digest", "/realty/digest", "Newspaper"],
      ["Auto-Match Alert", "/realty/alerts", "Bell"],
      ["Teach", "/realty/learn", "GraduationCap"],
      ["Bot Workspace", "/", "Bot"],
    ],
  );
  const labels = [...labelsFor(SUPER), ...labelsFor(AGENT)];
  for (const label of DESK_LINKS.map((l) => l.label)) assert.ok(labels.includes(label), label);
  for (const gone of ["Market Search", "1on1 CRM Automatch", "Workspace", "Supply & Demand"]) {
    assert.ok(!labels.includes(gone), gone);
  }
  assert.ok(code(SIDEBAR).includes("DESK_LINKS.map"), "the component renders DESK_LINKS");
  assert.ok(!code(SIDEBAR).includes("DESK_MARKET_SEARCH"), "the standalone Market Search link is gone");
});

test("the Start tour button is outside the sidebar; the sidebar keeps the hooks the tour spotlights", () => {
  assert.ok(!code(SIDEBAR).includes("StartTourButton"), "the sidebar's footer is the CRM's, with no tour button");
  assert.ok(LAYOUT.includes("<StartTourButton />"), "the layout places the tour button");
  assert.ok(LAYOUT.indexOf("<StartTourButton />") > LAYOUT.indexOf("<StaffSidebar"), "after the sidebar, in the page column");
  assert.ok(TOUR.includes('data-tour="start-tour"'), "the button still carries its hook");
  assert.ok(SIDEBAR.includes("data-tour={navTourId(link.href)}"), "each AI Desk link carries its tour hook");
  assert.equal(navTourId("/realty/search"), "nav-search");
  assert.equal(navTourId("/"), "nav-home");
  for (const href of SIDEBAR_DESK_HREFS) assert.ok(navTourId(href).startsWith("nav-"), href);
});

test("on a phone the same tree is a drawer behind a Menu bar; on md+ it is the sticky CRM column", () => {
  for (const cls of ["fixed inset-y-0 left-0 z-40", "md:sticky md:inset-auto md:top-0", "md:translate-x-0", "max-md:invisible", "md:hidden"]) {
    assert.ok(SIDEBAR.includes(cls), cls);
  }
  const markup = code(SIDEBAR);
  assert.ok(markup.includes('e.key === "Escape"'), "Escape closes the drawer");
  assert.ok(markup.includes('aria-hidden onClick={() => setOpen(false)}'), "a backdrop click closes it");
  assert.ok(markup.includes('aria-controls="staff-sidebar"') && markup.includes("aria-expanded={open}"), "the Menu button says what it opens");
  assert.ok(markup.includes('{open ? "Close menu" : "Menu"}'), "the Menu bar's labels");
  assert.ok(markup.includes('closest("a")') && markup.includes("setOpen(false)"), "a link closes the drawer on a phone; opening a group does not");
});

test("the sidebar takes only the role: no email, no address and no account detail is rendered", () => {
  assert.ok(LAYOUT.includes("<StaffSidebar role={crmRole({ email, owner })} />"));
  assert.ok(!/email|@/i.test(code(SIDEBAR)), "the component never sees or shows an email");
});

test("no staff-facing text says BOPS, Periskope, Fly or Supabase (labels, headers, aria, titles)", () => {
  const banned = /bops|periskope|\bfly\b|supabase/i;
  const texts: string[] = [
    ...labelsFor(SUPER),
    ...labelsFor(AGENT),
    ...linksFor(SUPER).map(([, href]) => href),
    ...CRM_GROUPS.map((g) => g.label),
    ...Object.values(portalHeader(SUPER)),
    ...Object.values(portalHeader(AGENT)),
    ...(code(SIDEBAR).match(/"[^"\n]*"|>[^<>{}\n]+</g) ?? []),
  ];
  for (const t of texts) assert.ok(!banned.test(t), `forbidden word in: ${t}`);
});
