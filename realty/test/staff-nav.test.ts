import assert from "node:assert/strict";
import { test } from "node:test";
import { STAFF_PAGES, navTourId, staffMayOpen, visibleStaffPages } from "../../app/realty/staff-pages.ts";

/**
 * The staff desk's pages (app/realty/staff-pages.ts), read by the sidebar (sidebar-model.ts) and the Bops home's top nav
 * (staff-nav.tsx): labels, order, and which entries each viewer sees. The owner and teacher checks are the layout's (viewer.ts);
 * this only checks the list those flags select.
 */

const labels = (viewer: { owner: boolean; teacher: boolean }) => visibleStaffPages(viewer).map((p) => p.label);
const AGENT = { owner: false, teacher: false };
const TEACHER = { owner: false, teacher: true };
const OWNER = { owner: true, teacher: false };
const OWNER_TEACHER = { owner: true, teacher: true };

test("the full desk for an owner who teaches: the new order and labels, Workspace last", () => {
  assert.deepEqual(labels(OWNER_TEACHER), [
    "Desk",
    "1on1 CRM Automatch",
    "Market Search",
    "All posts",
    "Online search",
    "Digest",
    "Auto-Match Alert",
    "Teach",
    "Workspace",
  ]);
});

test("an agent (neither owner nor teacher) sees the desk, Market Search and online search, and nothing owner-only", () => {
  assert.deepEqual(labels(AGENT), ["Desk", "Market Search", "Online search"]);
  const hrefs = visibleStaffPages(AGENT).map((p) => p.href);
  for (const owned of ["/realty/automatch", "/realty/posts", "/realty/digest", "/realty/alerts", "/"]) {
    assert.ok(!hrefs.includes(owned), `an agent has no ${owned}`);
  }
});

test("an owner who doesn't teach sees no Teach; a teacher who isn't an owner sees no owner pages", () => {
  assert.deepEqual(labels(OWNER), ["Desk", "1on1 CRM Automatch", "Market Search", "All posts", "Online search", "Digest", "Auto-Match Alert", "Workspace"]);
  assert.deepEqual(labels(TEACHER), ["Desk", "Market Search", "Online search", "Teach"]);
});

test("Workspace is the Bops chat app at / and listed for owners only: an agent is sent to the desk from /", () => {
  for (const teacher of [false, true]) {
    assert.ok(visibleStaffPages({ owner: true, teacher }).some((p) => p.label === "Workspace"), `owner, teacher ${teacher}`);
    assert.equal(visibleStaffPages({ owner: false, teacher }).some((p) => p.label === "Workspace"), false, `agent, teacher ${teacher}`);
  }
  const home = STAFF_PAGES.find((p) => p.label === "Workspace");
  assert.equal(home?.href, "/");
  assert.equal(navTourId("/"), "nav-home");
});

test("Market Search is the renamed Supply & Demand page: same URL, for every staff member, no owner flag", () => {
  const entry = STAFF_PAGES.find((p) => p.href === "/realty/search");
  assert.equal(entry?.label, "Market Search");
  assert.equal(entry?.ownerOnly, false);
  assert.equal(entry?.teacherOnly, false);
  assert.ok(labels(AGENT).includes("Market Search"));
  assert.ok(!STAFF_PAGES.some((p) => p.label === "Supply & Demand"), "the old label is gone");
});

test("the CRM's public site is not in the desk's list: it is a sidebar link to the CRM, same tab", () => {
  assert.ok(!STAFF_PAGES.some((p) => p.label === "Public site"));
  assert.ok(!STAFF_PAGES.some((p) => "external" in p), "no external entries in the desk's list");
});

test("gating flags on the entries match the labels: owner pages are owner-only, Teach is teacher-only, the rest open", () => {
  const byLabel = Object.fromEntries(STAFF_PAGES.map((p) => [p.label, p]));
  for (const label of ["1on1 CRM Automatch", "All posts", "Digest", "Auto-Match Alert", "Workspace"]) assert.equal(byLabel[label].ownerOnly, true, label);
  assert.equal(byLabel["Teach"].teacherOnly, true);
  for (const label of ["Desk", "Market Search", "Online search"]) {
    assert.equal(byLabel[label].ownerOnly, false, label);
    assert.equal(byLabel[label].teacherOnly, false, label);
  }
});

test("the access rule for Market Search and a stored post: any signed-in staff, and owners; nobody else", () => {
  assert.equal(staffMayOpen({ staff: true, owner: false }), true, "an agent");
  assert.equal(staffMayOpen({ staff: false, owner: true }), true, "an owner");
  assert.equal(staffMayOpen({ staff: false, owner: false }), false, "neither");
});

test("the data-tour ids: each nav entry's id is its last path segment, nav-home for Workspace", () => {
  assert.equal(navTourId("/realty/desk"), "nav-desk");
  assert.equal(navTourId("/realty/search"), "nav-search");
  assert.equal(navTourId("/realty/learn"), "nav-learn");
  assert.equal(navTourId("/"), "nav-home");
});

test("no label names the app, the database, the intake or a chat group (case-insensitive)", () => {
  const banned = ["bops", "periskope", "fly", "supabase", "whatsapp"];
  for (const p of STAFF_PAGES) {
    for (const word of banned) assert.ok(!p.label.toLowerCase().includes(word), `"${p.label}" has "${word}"`);
  }
});
