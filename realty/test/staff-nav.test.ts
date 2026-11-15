import assert from "node:assert/strict";
import { test } from "node:test";
import { STAFF_PAGES, visibleStaffPages } from "../../app/realty/staff-pages.ts";

/**
 * The staff nav (app/realty/staff-pages.ts, rendered by app/realty/staff-nav.tsx): labels, order, and which entries each
 * viewer sees. The owner and teacher checks are the layout's (viewer.ts); this only checks the list those flags select.
 */

const ENTRIES: readonly { label: string; href: string }[] = STAFF_PAGES;

const labels = (viewer: { owner: boolean; teacher: boolean }) => visibleStaffPages(viewer).map((p) => p.label);

test("the full nav for an owner who teaches: the new order and labels, with Requests gone and Bops home last", () => {
  assert.deepEqual(labels({ owner: true, teacher: true }), [
    "Desk",
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
    ["/realty/desk", "/realty/automatch", "/realty/search", "/realty/posts", "/realty/market", "/realty/digest", "/realty/alerts", "/realty/learn", "/"],
  );
  assert.ok(!ENTRIES.some((p) => p.label === "Requests" || p.href === "/realty/requests"), "the Requests entry is removed");
});

test("an agent (neither owner nor teacher) sees the desk, online search and Bops home", () => {
  assert.deepEqual(labels({ owner: false, teacher: false }), ["Desk", "Online search", "Bops home"]);
});

test("Bops home is at / and listed for every signed-in viewer, whatever their owner and teacher flags", () => {
  for (const owner of [true, false]) {
    for (const teacher of [true, false]) {
      const home = visibleStaffPages({ owner, teacher }).find((p) => p.label === "Bops home");
      assert.equal(home?.href, "/", `owner ${owner}, teacher ${teacher}`);
    }
  }
  const home = STAFF_PAGES.find((p) => p.label === "Bops home");
  assert.equal(home?.ownerOnly, false);
  assert.equal(home?.teacherOnly, false);
});

test("an owner who doesn't teach sees no Teach Bops; a teacher who isn't an owner sees no owner pages", () => {
  assert.deepEqual(labels({ owner: true, teacher: false }), ["Desk", "1on1 CRM Automatch", "Supply & Demand", "All posts", "Online search", "Digest", "Auto-Match Alert", "Bops home"]);
  assert.deepEqual(labels({ owner: false, teacher: true }), ["Desk", "Online search", "Teach Bops", "Bops home"]);
});

test("gating flags on the entries match the labels: owner pages are owner-only, Teach Bops is teacher-only, the rest open", () => {
  const byLabel = Object.fromEntries(STAFF_PAGES.map((p) => [p.label, p]));
  for (const label of ["1on1 CRM Automatch", "Supply & Demand", "All posts", "Digest", "Auto-Match Alert"]) assert.equal(byLabel[label].ownerOnly, true, label);
  assert.equal(byLabel["Teach Bops"].teacherOnly, true);
  for (const label of ["Desk", "Online search"]) {
    assert.equal(byLabel[label].ownerOnly, false, label);
    assert.equal(byLabel[label].teacherOnly, false, label);
  }
});

test("every entry is a /realty page or Bops home at /, and the old URLs are still listed where they were", () => {
  for (const p of STAFF_PAGES) assert.ok(p.href.startsWith("/realty/") || p.href === "/", p.href);
  assert.ok(!ENTRIES.some((p) => p.label === "Back to Bops"), "Back to Bops is now the Bops home entry, not a one-off link");
  const hrefs = STAFF_PAGES.map((p) => p.href);
  assert.ok(hrefs.includes("/realty/market"), "online search keeps /realty/market");
  assert.ok(hrefs.includes("/realty/posts"), "all posts keeps /realty/posts");
});
