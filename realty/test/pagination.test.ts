import assert from "node:assert/strict";
import { test } from "node:test";
import { hrefWithParams, pageFromSearch, pageHref, pageWindow, parsePage, resolvePage, slicePage, PAGE_SIZE, CARD_PAGE_SIZE } from "../flow/pagination.ts";

test("pageWindow: empty list is page 1 of 1, from and to at 0", () => {
  const w = pageWindow({ page: 9, pageSize: 25, total: 0 });
  assert.deepEqual(w, { page: 1, pageSize: 25, total: 0, totalPages: 1, offset: 0, from: 0, to: 0 });
});

test("pageWindow: a single page hides nothing and ignores a huge requested page", () => {
  const w = pageWindow({ page: 99, pageSize: 25, total: 10 });
  assert.equal(w.page, 1);
  assert.equal(w.totalPages, 1);
  assert.equal(w.offset, 0);
  assert.equal(w.from, 1);
  assert.equal(w.to, 10);
});

test("pageWindow: clamps page < 1 to 1 and page > totalPages to the last page", () => {
  assert.equal(pageWindow({ page: 0, pageSize: 25, total: 55 }).page, 1);
  assert.equal(pageWindow({ page: -3, pageSize: 25, total: 55 }).page, 1);
  const last = pageWindow({ page: 99, pageSize: 25, total: 55 });
  assert.equal(last.page, 3);
  assert.equal(last.totalPages, 3);
  assert.equal(last.offset, 50);
  assert.equal(last.from, 51);
  assert.equal(last.to, 55);
});

test("pageWindow: unreadable or fractional page values become a safe integer", () => {
  assert.equal(pageWindow({ page: "nope", pageSize: 20, total: 40 }).page, 1);
  assert.equal(pageWindow({ page: "", pageSize: 20, total: 40 }).page, 1);
  assert.equal(pageWindow({ page: undefined, pageSize: 20, total: 40 }).page, 1);
  assert.equal(pageWindow({ page: ["2"], pageSize: 20, total: 40 }).page, 2);
  assert.equal(parsePage(2.9), 2);
  assert.equal(pageWindow({ page: 2.9, pageSize: 20, total: 40 }).offset, 20);
});

test("pageWindow: a zero or negative page size becomes 1, never a crash", () => {
  const w = pageWindow({ page: 1, pageSize: 0, total: 3 });
  assert.equal(w.pageSize, 1);
  assert.equal(w.totalPages, 3);
});

test("slicePage: returns only the window, leaving the source untouched", () => {
  const rows = [1, 2, 3, 4, 5];
  const w = pageWindow({ page: 2, pageSize: 2, total: rows.length });
  assert.deepEqual(slicePage(rows, w), [3, 4]);
  assert.deepEqual(rows, [1, 2, 3, 4, 5]);
  assert.deepEqual(slicePage([], pageWindow({ page: 1, pageSize: 20, total: 0 })), []);
});

test("hrefWithParams: preserves existing filters and drops blank overrides", () => {
  const raw = { band: "all", hidden: "1", page: "2", q: "maraval" };
  assert.equal(hrefWithParams("/realty/automatch", raw, { page: undefined, hidden: undefined }), "/realty/automatch?band=all&q=maraval");
  assert.equal(hrefWithParams("/realty/search", { kind: "demand", area: "Westmoorings" }, { page: "3" }), "/realty/search?kind=demand&area=Westmoorings&page=3");
  assert.equal(hrefWithParams("/realty/posts", {}, {}), "/realty/posts");
});

test("pageHref: page 1 omits the param and clears a leftover offset; later pages keep filters", () => {
  const raw = { kind: "supply", area: "Maraval", offset: "100", page: "5" };
  assert.equal(pageHref("/realty/search", raw, 1), "/realty/search?kind=supply&area=Maraval");
  assert.equal(pageHref("/realty/search", raw, 3), "/realty/search?kind=supply&area=Maraval&page=3");
  assert.equal(pageHref("/realty/automatch", { band: "all" }, 2, "leadsPage"), "/realty/automatch?band=all&leadsPage=2");
});

test("pageFromSearch: prefers ?page= and falls back to a legacy ?offset=", () => {
  assert.equal(pageFromSearch({}, 25), 1);
  assert.equal(pageFromSearch({ page: "3" }, 25), 3);
  assert.equal(pageFromSearch({ offset: "50" }, 25), 3);
  assert.equal(pageFromSearch({ page: "2", offset: "50" }, 25), 2, "page wins over offset");
  assert.equal(PAGE_SIZE, 25);
  assert.equal(CARD_PAGE_SIZE, 20);
});

test("resolvePage: uses one load when the page is in range, and reloads when it was past the end", () => {
  const all = [1, 2, 3, 4, 5];
  const calls: number[] = [];
  const load = (offset: number, limit: number) => {
    calls.push(offset);
    return { rows: all.slice(offset, offset + limit), total: all.length };
  };
  const ok = resolvePage(2, 2, load);
  assert.deepEqual(ok.rows, [3, 4]);
  assert.equal(ok.window.page, 2);
  assert.deepEqual(calls, [2]);
  calls.length = 0;
  const clamped = resolvePage(99, 2, load);
  assert.deepEqual(clamped.rows, [5]);
  assert.equal(clamped.window.page, 3);
  assert.deepEqual(calls, [196, 4]);
});
