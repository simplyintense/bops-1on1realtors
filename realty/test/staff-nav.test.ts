import assert from "node:assert/strict";
import { test } from "node:test";
import { STAFF_PAGES, navTourId, staffMayOpen, visibleStaffPages } from "../../app/realty/staff-pages.ts";

/**
 * The staff desk's pages (app/realty/staff-pages.ts), read by the Bops home's top nav (staff-nav.tsx) and the guided tour: labels,
 * order, and which entries each viewer sees. Every AI Desk page is open to every staff member now, so the list is the same for
 * every viewer. The owner and teacher checks are the APIs' (lib/gate.ts) and the pages' own, not this list's.
 */

const labels = (viewer: { owner: boolean; teacher: boolean }) => visibleStaffPages(viewer).map((p) => p.label);
const AGENT = { owner: false, teacher: false };
const TEACHER = { owner: false, teacher: true };
const OWNER = { owner: true, teacher: false };
const OWNER_TEACHER = { owner: true, teacher: true };

const ALL_NINE = ["Desk", "Message Search (WA)", "Online search", "Automatch", "All posts", "Digest", "Auto-Match Alert", "Teach", "Bot Workspace"];

test("the nine AI Desk pages, in the sidebar's order, with Bot Workspace last", () => {
  assert.deepEqual(STAFF_PAGES.map((p) => p.label), ALL_NINE);
  assert.deepEqual(STAFF_PAGES.map((p) => p.href), ["/realty/desk", "/realty/search", "/realty/market", "/realty/automatch", "/realty/posts", "/realty/digest", "/realty/alerts", "/realty/learn", "/"]);
});

test("every staff member sees all nine: an agent, a teacher, an owner, and an owner who teaches get the same list", () => {
  for (const viewer of [AGENT, TEACHER, OWNER, OWNER_TEACHER]) {
    assert.deepEqual(labels(viewer), ALL_NINE, JSON.stringify(viewer));
  }
  assert.deepEqual(visibleStaffPages(AGENT), visibleStaffPages(OWNER), "the same entries, not just the same labels");
  assert.deepEqual(visibleStaffPages(TEACHER), visibleStaffPages(OWNER_TEACHER));
});

test("no entry is owner-only or teacher-only any more: the flags stay, and every one is false", () => {
  for (const p of STAFF_PAGES) {
    assert.equal(p.ownerOnly, false, p.label);
    assert.equal(p.teacherOnly, false, p.label);
  }
});

test("Bot Workspace is the chat app at / and is listed for every staff member, the root only", () => {
  for (const viewer of [AGENT, TEACHER, OWNER]) {
    assert.ok(visibleStaffPages(viewer).some((p) => p.label === "Bot Workspace" && p.href === "/"), JSON.stringify(viewer));
  }
  const home = STAFF_PAGES.find((p) => p.label === "Bot Workspace");
  assert.equal(home?.href, "/");
  assert.equal(navTourId("/"), "nav-home");
});

test("Message Search (WA) is the renamed Supply & Demand / Market Search page: same URL, for every staff member, no owner flag", () => {
  const entry = STAFF_PAGES.find((p) => p.href === "/realty/search");
  assert.equal(entry?.label, "Message Search (WA)");
  assert.equal(entry?.ownerOnly, false);
  assert.equal(entry?.teacherOnly, false);
  assert.ok(labels(AGENT).includes("Message Search (WA)"));
  assert.ok(!STAFF_PAGES.some((p) => p.label === "Supply & Demand" || p.label === "Market Search"), "the old labels are gone");
});

test("the CRM's public site is not in the desk's list: it is a sidebar link to the CRM, same tab", () => {
  assert.ok(!STAFF_PAGES.some((p) => p.label === "Public site"));
  assert.ok(!STAFF_PAGES.some((p) => "external" in p), "no external entries in the desk's list");
});

test("the access rule for Message Search (WA) and a stored post: any signed-in staff, and owners; nobody else", () => {
  assert.equal(staffMayOpen({ staff: true, owner: false }), true, "an agent");
  assert.equal(staffMayOpen({ staff: false, owner: true }), true, "an owner");
  assert.equal(staffMayOpen({ staff: false, owner: false }), false, "neither");
});

test("the data-tour ids: each nav entry's id is its last path segment, nav-home for Bot Workspace", () => {
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
