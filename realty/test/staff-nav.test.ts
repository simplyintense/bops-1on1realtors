import assert from "node:assert/strict";
import { test } from "node:test";
import { STAFF_PAGES, staffMayOpen, visibleStaffPages } from "../../app/realty/staff-pages.ts";

/**
 * The staff nav (app/realty/staff-pages.ts, rendered by app/realty/staff-nav.tsx): labels, order, and which entries each
 * viewer sees. The owner and teacher checks are the layout's (viewer.ts); this only checks the list those flags select.
 */

const ENTRIES: readonly { label: string; href: string; external?: true }[] = STAFF_PAGES;
const PUBLIC_SITE = "https://1on1realtors.com";

const labels = (viewer: { owner: boolean; teacher: boolean }) => visibleStaffPages(viewer).map((p) => p.label);

test("the full nav for an owner who teaches: the new order and labels, with Requests gone and Bops home last", () => {
  assert.deepEqual(labels({ owner: true, teacher: true }), [
    "Desk",
    "Public site",
    "1on1 CRM Automatch",
    "Supply & Demand",
    "All posts",
    "Online search",
    "Digest",
    "Auto-Match Alert",
    "Teach Bops",
    "Bops home",
  ]);
  assert.deepEqual(
    visibleStaffPages({ owner: true, teacher: true }).map((p) => p.href),
    ["/realty/desk", PUBLIC_SITE, "/realty/automatch", "/realty/search", "/realty/posts", "/realty/market", "/realty/digest", "/realty/alerts", "/realty/learn", "/"],
  );
  assert.ok(!ENTRIES.some((p) => p.label === "Requests" || p.href === "/realty/requests"), "the Requests entry is removed");
});

test("an agent (neither owner nor teacher) sees the desk, Supply & Demand and online search: no owner pages, no Bops home", () => {
  assert.deepEqual(labels({ owner: false, teacher: false }), ["Desk", "Public site", "Supply & Demand", "Online search"]);
});

test("the access rule for Supply & Demand and a stored post: any signed-in staff, and owners; nobody else", () => {
  // Staff is any signed-in person the gate admits (viewer.ts): an owner, an agent or a teacher.
  assert.equal(staffMayOpen({ staff: true, owner: false }), true, "an agent");
  assert.equal(staffMayOpen({ staff: true, owner: true }), true, "an owner");
  assert.equal(staffMayOpen({ staff: false, owner: true }), true, "an owner is always staff");
  assert.equal(staffMayOpen({ staff: false, owner: false }), false, "signed out, or not allowlisted");
});

test("Bops home is at / and listed for owners only: an agent is sent to the desk from /", () => {
  for (const teacher of [true, false]) {
    const home = visibleStaffPages({ owner: true, teacher }).find((p) => p.label === "Bops home");
    assert.equal(home?.href, "/", `owner, teacher ${teacher}`);
    assert.equal(visibleStaffPages({ owner: false, teacher }).some((p) => p.label === "Bops home"), false, `agent, teacher ${teacher}`);
  }
  const home = STAFF_PAGES.find((p) => p.label === "Bops home");
  assert.equal(home?.ownerOnly, true);
  assert.equal(home?.teacherOnly, false);
});

test("an owner who doesn't teach sees no Teach Bops; a teacher who isn't an owner sees no owner pages", () => {
  assert.deepEqual(labels({ owner: true, teacher: false }), ["Desk", "Public site", "1on1 CRM Automatch", "Supply & Demand", "All posts", "Online search", "Digest", "Auto-Match Alert", "Bops home"]);
  assert.deepEqual(labels({ owner: false, teacher: true }), ["Desk", "Public site", "Supply & Demand", "Online search", "Teach Bops"]);
});

test("gating flags on the entries match the labels: owner pages are owner-only, Teach Bops is teacher-only, the rest open", () => {
  const byLabel = Object.fromEntries(STAFF_PAGES.map((p) => [p.label, p]));
  for (const label of ["1on1 CRM Automatch", "All posts", "Digest", "Auto-Match Alert"]) assert.equal(byLabel[label].ownerOnly, true, label);
  assert.equal(byLabel["Supply & Demand"].ownerOnly, false, "Supply & Demand is for all staff; its owner parts are the page's");
  assert.equal(byLabel["Teach Bops"].teacherOnly, true);
  for (const label of ["Desk", "Public site", "Online search", "Supply & Demand"]) {
    assert.equal(byLabel[label].ownerOnly, false, label);
    assert.equal(byLabel[label].teacherOnly, false, label);
  }
});

test("the Public site entry is external, not owner-only, and sits right after Desk", () => {
  for (const viewer of [{ owner: true, teacher: true }, { owner: false, teacher: false }]) {
    const nav = visibleStaffPages(viewer);
    const site = nav.find((p) => p.label === "Public site");
    assert.equal(site?.href, PUBLIC_SITE);
    assert.equal(site?.external, true);
    assert.equal(site?.ownerOnly, false);
    assert.equal(nav[1]?.label, "Public site", "directly after Desk");
  }
  assert.equal(STAFF_PAGES.filter((p) => p.external).length, 1, "the only external entry");
});

test("every entry is a /realty page, Bops home at /, or the one external public site link", () => {
  for (const p of STAFF_PAGES) assert.ok(p.external ? p.href === PUBLIC_SITE : p.href.startsWith("/realty/") || p.href === "/", p.href);
  assert.ok(!ENTRIES.some((p) => p.label === "Back to Bops"), "Back to Bops is now the Bops home entry, not a one-off link");
  const hrefs = STAFF_PAGES.map((p) => p.href);
  assert.ok(hrefs.includes("/realty/market"), "online search keeps /realty/market");
  assert.ok(hrefs.includes("/realty/posts"), "all posts keeps /realty/posts");
});
