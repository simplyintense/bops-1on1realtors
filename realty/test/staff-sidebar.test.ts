import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CRM_LINKS, CRM_LOGO, LOGO_FALLBACK, isCurrentPage, sidebarModel } from "../../app/realty/sidebar-model.ts";

/**
 * The staff sidebar (app/realty/sidebar-model.ts, the data; app/realty/staff-sidebar.tsx, the markup). The model is checked as
 * data. The component's markup is checked as source, because the realty tests run without React: same-tab CRM links, the
 * active item's classes, the drawer, and the words that must never show.
 */

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
const SIDEBAR = source("app/realty/staff-sidebar.tsx");
const LAYOUT = source("app/realty/layout.tsx");
const THEME = source("app/realty/realty-theme.css");

const AGENT = { owner: false, teacher: false };
const OWNER = { owner: true, teacher: false };
const TEACHER = { owner: false, teacher: true };
const OWNER_TEACHER = { owner: true, teacher: true };

/** Strips comments (the component's own notes), so the check is about what renders. */
const rendered = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the CRM agent routes are exactly the ones the desk links to, in the CRM's order", () => {
  assert.deepEqual(
    CRM_LINKS.map((l) => [l.label, l.href]),
    [
      ["Dashboard", "https://1on1realtors.com/agent/dashboard"],
      ["Properties", "https://1on1realtors.com/agent/properties"],
      ["Clients", "https://1on1realtors.com/agent/crm"],
      ["Inquiries", "https://1on1realtors.com/agent/inquiries"],
      ["Tasks", "https://1on1realtors.com/agent/tasks"],
      ["MCP settings", "https://1on1realtors.com/agent/mcp-settings"],
      ["My Profile", "https://1on1realtors.com/agent/profile"],
      ["Public site", "https://1on1realtors.com/"],
    ],
  );
  for (const l of CRM_LINKS) assert.ok(l.href.startsWith("https://1on1realtors.com/"), l.href);
  assert.deepEqual(sidebarModel(OWNER_TEACHER, "/realty/desk").crm, CRM_LINKS, "every viewer gets the CRM links");
  assert.deepEqual(sidebarModel(AGENT, "/realty/desk").crm, CRM_LINKS);
});

test("CRM links are same-tab: the sidebar never opens a new window, and the CRM anchors carry no target", () => {
  const markup = rendered(SIDEBAR);
  assert.ok(!markup.includes("_blank"), "no target=_blank in the sidebar");
  assert.ok(!markup.includes("noopener"), "no new-window rel either");
  // The CRM anchor is the plain <a>, with an href from the CRM list and no target attribute.
  const crm = markup.match(/<a\s[^>]*href=\{link\.href\}[^>]*>/);
  assert.ok(crm, "the CRM links are plain anchors on link.href");
  assert.ok(!/target=/.test(crm[0]), "no target on the CRM anchor");
});

test("the logo is the public site's logo, with alt text and the local file only as a fallback", () => {
  assert.equal(CRM_LOGO, "https://1on1realtors.com/logo.png");
  assert.equal(LOGO_FALLBACK, "/realty/1on1-realtors-logo.png");
  assert.ok(existsSync(fileURLToPath(new URL("../../public/realty/1on1-realtors-logo.png", import.meta.url))), "the fallback file is in public/");
  assert.ok(SIDEBAR.includes('alt="1on1 Realtors"'), "alt text is 1on1 Realtors");
  assert.ok(SIDEBAR.includes("onError="), "the local fallback swaps in on error");
});

test("Market Search is the active item on /realty/search, on its sub-paths and on a stored post's page", () => {
  for (const path of ["/realty/search", "/realty/search/", "/realty/posts/abc123DEF"]) {
    const current = sidebarModel(AGENT, path).staff.filter((l) => l.current).map((l) => l.href);
    assert.deepEqual(current, ["/realty/search"], path);
  }
  assert.deepEqual(
    sidebarModel(OWNER_TEACHER, "/realty/search").staff.filter((l) => l.current).map((l) => l.label),
    ["Market Search"],
  );
});

test("the active item is the only one current; the list pages stay their own", () => {
  assert.deepEqual(sidebarModel(OWNER, "/realty/desk").staff.filter((l) => l.current).map((l) => l.label), ["Desk"]);
  assert.deepEqual(sidebarModel(OWNER, "/realty/posts").staff.filter((l) => l.current).map((l) => l.label), ["All posts"]);
  assert.equal(sidebarModel(OWNER, "/realty/posts/abc").staff.find((l) => l.label === "All posts")?.current, false, "a post is not the list");
  assert.deepEqual(sidebarModel(OWNER, "/").staff.filter((l) => l.current).map((l) => l.label), ["Workspace"]);
  assert.equal(sidebarModel(AGENT, "/realty/search").staff.find((l) => l.label === "Workspace"), undefined, "agents have no Workspace");
  assert.equal(isCurrentPage("/", "/realty/desk"), false, "Workspace is not current on a desk page");
  assert.equal(isCurrentPage("/realty/market", "/realty/market/x"), true, "a sub-page of the same section is current");
});

test("the active styling is the CRM's: purple background, light text, rounded, small medium text (theme CSS, scoped to .realty-theme)", () => {
  const cur = THEME.match(/\.rt-side-link\[aria-current="page"\]\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(cur.includes("background: hsl(var(--primary))"), "active: purple background");
  assert.ok(cur.includes("color: hsl(var(--primary-foreground))"), "active: light text");
  const link = THEME.match(/\.rt-side-link\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(link.includes("border-radius: 0.5rem"), "rounded-lg");
  assert.ok(link.includes("font-size: 0.875rem") && link.includes("font-weight: 500"), "text-sm font-medium");
  assert.ok(SIDEBAR.includes('className="rt-side-link"'), "the links use the theme class");
  assert.ok(SIDEBAR.includes("aria-current={link.current"), "the current item carries aria-current");
});

test("an agent's sidebar has no owner-only links, and every staff link is one they may open", () => {
  const hrefs = sidebarModel(AGENT, "/realty/desk").staff.map((l) => l.href);
  assert.deepEqual(hrefs, ["/realty/desk", "/realty/search", "/realty/market"]);
  for (const owned of ["/realty/automatch", "/realty/posts", "/realty/digest", "/realty/alerts", "/", "/realty/learn"]) {
    assert.ok(!hrefs.includes(owned), `no ${owned} for an agent`);
  }
});

test("owners see every desk page; teachers add Teach; nobody sees owner pages without the owner flag", () => {
  assert.deepEqual(
    sidebarModel(OWNER, "/realty/desk").staff.map((l) => l.label),
    ["Desk", "1on1 CRM Automatch", "Market Search", "All posts", "Online search", "Digest", "Auto-Match Alert", "Workspace"],
  );
  assert.deepEqual(sidebarModel(TEACHER, "/realty/desk").staff.map((l) => l.label), ["Desk", "Market Search", "Online search", "Teach"]);
  assert.ok(sidebarModel(OWNER_TEACHER, "/realty/desk").staff.some((l) => l.label === "Teach"));
});

test("the tour's data-tour ids are on the sidebar's desk links, and the Start tour button stays in the footer", () => {
  const ids = sidebarModel(OWNER_TEACHER, "/realty/desk").staff.map((l) => l.tourId);
  assert.deepEqual(ids, ["nav-desk", "nav-automatch", "nav-search", "nav-posts", "nav-market", "nav-digest", "nav-alerts", "nav-learn", "nav-home"]);
  assert.ok(SIDEBAR.includes("data-tour={link.tourId}"), "the sidebar renders the id");
  assert.ok(LAYOUT.includes("footer={<StartTourButton />}"), "the Start tour button is in the sidebar's footer");
  assert.ok(source("app/realty/desk-tour.tsx").includes('data-tour="start-tour"'), "and still carries its data-tour hook");
});

test("the sidebar is the desktop column (w-64, a right border, the page background) and a drawer on a phone", () => {
  for (const cls of ["w-64", "rt-side", "md:sticky", "md:translate-x-0", "md:hidden", "max-md:invisible"]) {
    assert.ok(SIDEBAR.includes(cls), cls);
  }
  const side = THEME.match(/\.rt-side\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(side.includes("background: hsl(var(--background))"), "the page background token");
  assert.ok(side.includes("border-right: 1px solid hsl(var(--border))"), "border-r in the border token");
  assert.ok(SIDEBAR.includes('aria-controls="staff-sidebar"') && SIDEBAR.includes("aria-expanded={open}"), "the menu button says what it opens");
  assert.ok(SIDEBAR.includes('e.key === "Escape"'), "Escape closes the drawer");
});

test("the layout uses the sidebar, not the old top header, and no longer loads the serif", () => {
  assert.ok(LAYOUT.includes("<StaffSidebar"));
  assert.ok(!LAYOUT.includes("StaffNav"), "the /realty pages don't use the top nav");
  assert.ok(!LAYOUT.includes("Playfair"), "Playfair is not loaded");
  assert.ok(LAYOUT.includes("Inter("), "Inter is the UI font");
});

test("no sidebar text says BOPS, Periskope, Fly or Supabase (case-insensitive)", () => {
  const banned = /bops|periskope|\bfly\b|supabase/i;
  const texts: string[] = [];
  for (const viewer of [AGENT, OWNER, TEACHER, OWNER_TEACHER]) {
    const m = sidebarModel(viewer, "/realty/search");
    texts.push(...m.staff.map((l) => l.label), ...m.crm.map((l) => l.label));
  }
  texts.push(...CRM_LINKS.map((l) => l.href));
  texts.push(...(rendered(SIDEBAR).match(/"[^"\n]*"|>[^<>{}\n]+</g) ?? []));
  for (const t of texts) assert.ok(!banned.test(t), `forbidden word in: ${t}`);
});
