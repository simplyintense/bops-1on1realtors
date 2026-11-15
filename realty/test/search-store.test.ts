import assert from "node:assert/strict";
/// <reference path="../node/node-sqlite.d.ts" />
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  NotInQueueError,
  SearchInputError,
  SearchStore,
  exportSheets,
  isVague,
  nearIdentical,
  normalizeText,
  SEARCH_DB,
  searchInputFrom,
  syncFromJsonl,
  withSearchStore,
  type SearchRow,
} from "../node/search-store.ts";
import { applyKnownTerms, termIn } from "../flow/knowledge.ts";

// Invented data only: made-up agents, 555-style numbers, invented listings.
const AGENT = "+18685550101";
const OTHER = "+18685550102";

function post(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "msg-1",
    chatId: "chat-a@g.us",
    groupName: "Test Group A",
    sentAt: "2026-11-02T12:00:00.000Z",
    category: "listing_for_sale",
    cobroke: false,
    senderPhone: AGENT,
    senderName: "Test Agent",
    firm: null,
    area: "Maraval",
    development: null,
    price: 2_500_000,
    currency: "TTD",
    beds: 3,
    baths: 2,
    type: "house",
    listingType: "sale",
    intent: "buy",
    propertyClass: "sale",
    notes: null,
    originalText: "Three bed house in Maraval, asking 2.5m",
    set: "supply",
    ...over,
  };
}

function world(files: { supply?: Record<string, unknown>[]; demand?: Record<string, unknown>[] }) {
  const root = mkdtempSync(join(tmpdir(), "search-store-"));
  const lines = (rows: Record<string, unknown>[] = []) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");
  writeFileSync(join(root, "supply.jsonl"), lines(files.supply), { mode: 0o600 });
  writeFileSync(join(root, "demand.jsonl"), lines(files.demand), { mode: 0o600 });
  return root;
}

function rowsOf(root: string, kind: "supply" | "demand" | "vague", q: Record<string, unknown> = {}): SearchRow[] {
  return withSearchStore(root, (s) => s.search({ kind, limit: 500, ...q })).rows;
}

test("vague: no place and no price, or no type and no place; clear posts are not vague", () => {
  assert.equal(isVague({ area: null, development: null, price: null, type: "house" }), true);
  assert.equal(isVague({ area: null, development: null, price: 1_000_000, type: null }), true);
  assert.equal(isVague({ area: "Maraval", development: null, price: null, type: null }), false);
  assert.equal(isVague({ area: null, development: "Aquaria", price: 900_000, type: "condo" }), false);
  assert.equal(isVague({ area: "Maraval", development: null, price: null, type: "house" }), false);
  assert.equal(isVague({ area: "   ", development: null, price: null, type: "house" }), true, "blank strings count as missing");
  assert.equal(isVague({ area: null, development: null, price: null, type: null, listingType: "shortlet" }), false, "a shortlet tag is enough");
});

test("near-identical text ignores case, accents, punctuation and emoji, but not different words", () => {
  assert.equal(normalizeText("Café – MARAVAL!! 🏡"), "cafe maraval");
  assert.equal(nearIdentical("Three bed house in Maraval, 2.5m", "three bed house in maraval 2.5m!"), true);
  assert.equal(nearIdentical("Three bed house in Maraval", "Two bed flat in Maraval"), false);
  assert.equal(nearIdentical("", ""), false, "empty text never matches");
});

test("termIn matches whole words and phrases, case-insensitively", () => {
  assert.equal(termIn("Lives in Annandale", "ann"), false);
  assert.equal(termIn("Ann Street unit", "ann"), true);
  assert.equal(termIn("BLUE HAVEN gate", "blue haven"), true);
  assert.equal(termIn("x (blue-haven) y", "blue haven"), false, "hyphen joins are not the phrase");
  assert.equal(termIn("price 2.5m", "2.5m"), true);
});

test("applyKnownTerms only fills missing fields, longest term first", () => {
  const out = applyKnownTerms(
    { area: null, development: null, type: null, listingType: null },
    "blue haven townhouse",
    [
      { term: "blue haven", area: "Elsewhere", development: null, type: "house", listingType: null },
      { term: "blue haven townhouse", area: "Blue Haven", development: null, type: "townhouse", listingType: null },
    ],
  );
  assert.deepEqual(out, { area: "Blue Haven", development: null, type: "townhouse", listingType: null });
  assert.deepEqual(applyKnownTerms({ area: "Maraval", development: null, type: null, listingType: null }, "blue haven", [{ term: "blue haven", area: "Blue Haven", development: null, type: null, listingType: null }]).area, "Maraval", "never overwrites");
});

test("clear posts go to supply and demand; vague posts go to the queue, not the match tables", () => {
  const root = world({
    supply: [
      post({ messageId: "s-clear" }),
      post({ messageId: "s-vague", sentAt: "2026-11-03T12:00:00.000Z", area: null, price: null, type: null, originalText: "anyone got something nice?", senderPhone: OTHER, senderName: null }),
    ],
    demand: [post({ messageId: "d-clear", set: "demand", category: "buyer_request", listingType: "rent", area: "St. Clair", price: null, type: "apartment", originalText: "Looking for a 2 bed apartment in St. Clair", senderPhone: OTHER })],
  });
  const counts = syncFromJsonl(root);
  assert.equal(counts.rebuilt, true);
  assert.equal(counts.messages, 3);
  assert.equal(counts.supply, 1);
  assert.equal(counts.demand, 1);
  assert.equal(counts.needsExplanation, 1);
  assert.equal(rowsOf(root, "supply").length, 1);
  assert.equal(rowsOf(root, "demand").length, 1);
  const queue = rowsOf(root, "vague");
  assert.equal(queue.length, 1);
  assert.equal(queue[0].senderName, null);
  assert.equal(queue[0].originalText, "anyone got something nice?");
});

test("the same listing posted in two groups is one record with groups, message ids, first and last seen, and a count", () => {
  const root = world({
    supply: [
      post({ messageId: "g1-post", groupName: "Test Group A", sentAt: "2026-11-02T12:00:00.000Z" }),
      post({ messageId: "g2-post", groupName: "Test Group B", chatId: "chat-b@g.us", sentAt: "2026-11-04T09:30:00.000Z", originalText: "Three bed house in Maraval asking 2.5M!" }),
    ],
  });
  syncFromJsonl(root);
  const rows = rowsOf(root, "supply");
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual(r.groups, ["Test Group A", "Test Group B"]);
  assert.deepEqual(r.messageIds, ["g1-post", "g2-post"]);
  assert.equal(r.timesSeen, 2);
  assert.equal(r.firstSentAt, "2026-11-02T12:00:00.000Z");
  assert.equal(r.lastSentAt, "2026-11-04T09:30:00.000Z");
  assert.equal(r.originalText, "Three bed house in Maraval, asking 2.5m", "the record keeps the first message's text");
});

test("same sender and same parsed ask within 3 days merge; beyond 3 days they do not", () => {
  const sameAsk = { originalText: "a totally different wording of the same house" };
  const root = world({
    supply: [
      post({ messageId: "ask-1", sentAt: "2026-11-02T12:00:00.000Z" }),
      post({ messageId: "ask-2", sentAt: "2026-11-04T12:00:00.000Z", ...sameAsk }),
      post({ messageId: "ask-3", sentAt: "2026-11-12T12:00:00.000Z", ...sameAsk }),
    ],
  });
  syncFromJsonl(root);
  const rows = rowsOf(root, "supply");
  assert.equal(rows.length, 2, "ask-1 and ask-2 merge; ask-3 is 8 days after ask-2 and stands alone");
  const merged = rows.find((r) => r.messageIds.length === 2);
  assert.ok(merged);
  assert.deepEqual(merged.messageIds, ["ask-1", "ask-2"]);
});

test("a different sender or a different ask does not merge", () => {
  const root = world({
    supply: [
      post({ messageId: "x-1" }),
      post({ messageId: "x-2", senderPhone: OTHER, originalText: "Three bed house in Maraval, asking 2.5m" }),
      post({ messageId: "x-3", price: 2_600_000, originalText: "something else entirely" }),
    ],
  });
  syncFromJsonl(root);
  assert.equal(rowsOf(root, "supply").length, 3);
});

test("vague posts merge on near-identical text only, never on an empty ask", () => {
  const vague = { area: null, price: null, type: null, originalText: "anyone got a place?" };
  const root = world({
    supply: [
      post({ messageId: "v-1", ...vague, sentAt: "2026-11-02T12:00:00.000Z" }),
      post({ messageId: "v-2", ...vague, groupName: "Test Group B", sentAt: "2026-11-03T12:00:00.000Z" }),
      post({ messageId: "v-3", area: null, price: null, type: null, originalText: "does anyone have a lot for sale", sentAt: "2026-11-03T13:00:00.000Z" }),
    ],
  });
  syncFromJsonl(root);
  const queue = rowsOf(root, "vague");
  assert.equal(queue.length, 2);
  assert.deepEqual(queue.find((q) => q.messageIds.length === 2)?.groups, ["Test Group A", "Test Group B"]);
});

test("sync is idempotent, skips the rebuild when the JSONL is unchanged, and rebuilds when a message is rewritten", () => {
  const root = world({ supply: [post({ messageId: "i-1" })] });
  const first = syncFromJsonl(root);
  const again = syncFromJsonl(root);
  assert.equal(first.rebuilt, true);
  assert.equal(again.rebuilt, false);
  assert.equal(again.supply, 1);
  assert.equal(rowsOf(root, "supply").length, 1);

  // The JSONL is rewritten in place on reparse: the same messageId with new facts replaces the old record.
  writeFileSync(join(root, "supply.jsonl"), `${JSON.stringify(post({ messageId: "i-1", area: "St. Ann's", originalText: "Two bed flat in St. Ann's" }))}\n`);
  const changed = syncFromJsonl(root);
  assert.equal(changed.rebuilt, true);
  const [only] = rowsOf(root, "supply");
  assert.equal(only.area, "St. Ann's");
  assert.equal(only.messageIds.length, 1);
});

test("a torn line and a message without a usable time are skipped and counted, not stored", () => {
  const root = world({});
  writeFileSync(join(root, "supply.jsonl"), `${JSON.stringify(post({ messageId: "ok-1" }))}\n{"messageId":"torn\n${JSON.stringify(post({ messageId: "no-time", sentAt: "not a date" }))}\n`);
  const counts = syncFromJsonl(root);
  assert.equal(counts.skippedLines, 2);
  assert.equal(counts.supply, 1);
});

test("aliases set by the owner promote vague posts during a later sync", () => {
  const root = world({
    supply: [
      post({ messageId: "q-1", area: null, price: null, type: null, originalText: "nice place at Blue Haven, call me" }),
      post({ messageId: "q-2", area: null, price: null, type: null, originalText: "unrelated vague ask", sentAt: "2026-11-03T12:00:00.000Z" }),
    ],
  });
  syncFromJsonl(root);
  const [item] = rowsOf(root, "vague").filter((r) => r.messageIds.includes("q-1"));
  withSearchStore(root, (s) => s.teach(item.id, { answer: "Blue Haven is a house development", term: "blue haven", area: "Blue Haven", type: "house" }));

  // A new vague post with the same term arrives: the saved alias applies during the sync, no owner step needed.
  writeFileSync(join(root, "supply.jsonl"), [
    post({ messageId: "q-1", area: null, price: null, type: null, originalText: "nice place at Blue Haven, call me" }),
    post({ messageId: "q-2", area: null, price: null, type: null, originalText: "unrelated vague ask", sentAt: "2026-11-03T12:00:00.000Z" }),
    post({ messageId: "q-3", area: null, price: null, type: null, originalText: "is Blue Haven still available?", sentAt: "2026-11-05T12:00:00.000Z" }),
  ].map((r) => `${JSON.stringify(r)}\n`).join(""));
  const counts = syncFromJsonl(root);
  assert.equal(counts.promotedByAlias, 2, "q-1 and q-3 are clear through the alias");
  assert.equal(rowsOf(root, "vague").length, 1);
  assert.equal(rowsOf(root, "supply").find((r) => r.messageIds.includes("q-3"))?.area, "Blue Haven");
});

test("teach stores the answer, saves the alias, reapplies it to every vague item, and keeps unresolved notes", () => {
  const root = world({
    supply: [
      post({ messageId: "e-1", area: null, price: null, type: null, originalText: "Blue Haven townhouse, DM me" }),
      post({ messageId: "e-2", area: null, price: null, type: null, originalText: "is blue haven open for viewings", sentAt: "2026-11-03T12:00:00.000Z" }),
      post({ messageId: "e-3", area: null, price: null, type: null, originalText: "anyone got something to rent?", sentAt: "2026-11-04T12:00:00.000Z" }),
    ],
  });
  syncFromJsonl(root);
  const queue = rowsOf(root, "vague");
  assert.equal(queue.length, 3);
  const pick = (mid: string) => queue.find((r) => r.messageIds.includes(mid))!;

  const store = SearchStore.open(root);
  try {
    const first = store.teach(pick("e-1").id, { answer: "Blue Haven is a townhouse development", term: "Blue Haven", area: "Blue Haven", type: "townhouse" });
    assert.equal(first.saved, "alias");
    assert.equal(first.promoted, true);
    assert.equal(first.stillVague, false);
    assert.equal(first.reparsed, 0, "no stored posts in this fixture, so nothing to parse again");
    assert.equal(first.promotedRecords, 2, "e-1 and e-2 both mention the term and are clear now");

    const note = store.teach(pick("e-3").id, { answer: "Wants a rental, no place named" });
    assert.equal(note.saved, "note");
    assert.equal(note.stillVague, true);
    assert.equal(note.promoted, false);
  } finally {
    store.close();
  }

  // A rebuild keeps the owner's note on the unresolved item.
  syncFromJsonl(root, { force: true });
  const [left] = rowsOf(root, "vague");
  assert.equal(left.messageIds[0], "e-3");
  assert.equal(left.explanation, "Wants a rental, no place named");
  assert.ok(left.explainedAt);
  assert.equal(rowsOf(root, "supply").find((r) => r.messageIds.includes("e-2"))?.area, "Blue Haven");
  assert.equal(rowsOf(root, "supply").find((r) => r.messageIds.includes("e-1"))?.type, "townhouse");
});

test("teach refuses an id outside the queue and invalid input, and saves nothing", () => {
  const root = world({ supply: [post({ messageId: "r-1", area: null, price: null, type: null, originalText: "vague one" })] });
  syncFromJsonl(root);
  const [item] = rowsOf(root, "vague");
  const store = SearchStore.open(root);
  try {
    assert.throws(() => store.teach("0".repeat(24), { answer: "nope" }), NotInQueueError);
    assert.throws(() => store.teach(item.id, { answer: "   " }), SearchInputError);
    assert.throws(() => store.teach(item.id, { answer: "ok", term: "x", area: "Maraval" }), SearchInputError, "one-letter term");
    assert.throws(() => store.teach(item.id, { answer: "ok", area: "Maraval" }), SearchInputError, "a place with no term to match on");
    assert.throws(() => store.teach(item.id, { answer: "ok", term: "vague one", listingType: "lease" }), SearchInputError, "sale or rent only");
    assert.throws(() => store.teach(item.id, { answer: "two\nlines".repeat(100) }), SearchInputError, "one line, 300 characters at most");
    assert.deepEqual(store.taught(), [], "a failed teach saves nothing");
  } finally {
    store.close();
  }
  assert.equal(rowsOf(root, "vague")[0].explanation ?? null, null);
});

test("search filters: keywords, area and development substrings, price, beds, type, sale or rent, agent, group", () => {
  const root = world({
    supply: [
      post({ messageId: "f-1", area: "Maraval", price: 2_500_000, beds: 3, type: "house", listingType: "sale", originalText: "Three bed house with a pool in Maraval" }),
      post({ messageId: "f-2", area: "West Hills", development: "West Hills", price: 900_000, beds: 2, type: "apartment", listingType: "rent", category: "listing_for_rent", senderPhone: OTHER, senderName: "Other Agent", groupName: "Test Group B", chatId: "chat-b@g.us", sentAt: "2026-11-05T12:00:00.000Z", originalText: "Two bed flat to rent in West Hills" }),
      post({ messageId: "f-3", area: "Woodbrook", development: null, price: 4_000_000, beds: 4, type: "townhouse", sentAt: "2026-11-09T12:00:00.000Z", originalText: "Four bed townhouse in Woodbrook" }),
    ],
  });
  syncFromJsonl(root);
  const ids = (q: Parameters<SearchStore["search"]>[0]) =>
    withSearchStore(root, (s) => s.search({ kind: "supply", limit: 500, ...q })).rows.map((r) => r.messageIds[0]).sort();

  assert.deepEqual(ids({ q: "POOL" }), ["f-1"], "keyword match, case-insensitive");
  assert.deepEqual(ids({ q: "bed flat" }), ["f-2"], "every word must match");
  assert.deepEqual(ids({ area: "maraval" }), ["f-1"], "area substring, case-insensitive");
  assert.deepEqual(ids({ area: "hills" }), ["f-2"]);
  assert.deepEqual(ids({ development: "west" }), ["f-2"]);
  assert.deepEqual(ids({ minPrice: 1_000_000, maxPrice: 3_000_000 }), ["f-1"]);
  assert.deepEqual(ids({ beds: 2 }), ["f-2"]);
  assert.deepEqual(ids({ type: "TOWNHOUSE" }), ["f-3"]);
  assert.deepEqual(ids({ listingType: "rent" }), ["f-2"]);
  assert.deepEqual(ids({ listingType: "sale" }), ["f-1", "f-3"]);
  assert.deepEqual(ids({ agent: "other agent" }), ["f-2"], "agent by name");
  assert.deepEqual(ids({ agent: "8685550102" }), ["f-2"], "agent by phone digits");
  assert.deepEqual(ids({ group: "Group B" }), ["f-2"]);
  assert.deepEqual(ids({ q: "bed", area: "zzz" }), [], "filters combine");
});

test("date filters use AST days: a sighting at 03:59Z on the 1st is still the 31st", () => {
  const root = world({
    supply: [
      post({ messageId: "t-late", sentAt: "2026-11-01T03:59:00.000Z", originalText: "Late post Maraval" }),
      post({ messageId: "t-first", sentAt: "2026-11-01T04:00:00.000Z", senderPhone: OTHER, originalText: "First post of the AST day Maraval" }),
      post({ messageId: "t-last", sentAt: "2026-11-02T03:59:59.000Z", senderPhone: "+18685550103", originalText: "Last post of the AST day Maraval" }),
    ],
  });
  syncFromJsonl(root);
  const mids = (q: Record<string, string>) => withSearchStore(root, (s) => s.search({ kind: "supply", ...searchInputFrom(q) })).rows.map((r) => r.messageIds[0]).sort();
  // AST day 1 Nov runs 04:00Z on 1 Nov to 04:00Z on 2 Nov; t-late (03:59Z on 1 Nov) is still 31 Oct in AST.
  assert.deepEqual(mids({ from: "2026-11-01", to: "2026-11-01" }), ["t-first", "t-last"]);
  assert.deepEqual(mids({ from: "2026-10-31", to: "2026-10-31" }), ["t-late"]);
  assert.deepEqual(mids({ from: "2026-11-01", to: "2026-11-02" }), ["t-first", "t-last"]);
});

test("search pages: limit and offset, newest first, with a total", () => {
  const root = world({
    supply: [1, 2, 3].map((n) => post({ messageId: `p-${n}`, senderPhone: `+1868555010${n}`, sentAt: `2026-11-0${n}T12:00:00.000Z`, originalText: `Maraval listing ${n} unique words${n}` })),
  });
  syncFromJsonl(root);
  const page = withSearchStore(root, (s) => s.search({ kind: "supply", limit: 2, offset: 0 }));
  assert.equal(page.total, 3);
  assert.deepEqual(page.rows.map((r) => r.messageIds[0]), ["p-3", "p-2"]);
  const next = withSearchStore(root, (s) => s.search({ kind: "supply", limit: 2, offset: 2 }));
  assert.deepEqual(next.rows.map((r) => r.messageIds[0]), ["p-1"]);
});

test("searchInputFrom validates filters and clamps paging", () => {
  assert.throws(() => searchInputFrom({ kind: "elsewhere" }), SearchInputError);
  assert.throws(() => searchInputFrom({ from: "2026-13-40" }), SearchInputError);
  assert.throws(() => searchInputFrom({ listingType: "lease" }), SearchInputError);
  assert.throws(() => searchInputFrom({ minPrice: "lots" }), SearchInputError);
  assert.throws(() => searchInputFrom({ beds: "2.5" }), SearchInputError);
  const v = searchInputFrom(new URLSearchParams("kind=vague&limit=9999&offset=-4&minPrice=1,000,000&agent=%2B1868"));
  assert.equal(v.kind, "vague");
  assert.equal(v.limit, 500);
  assert.equal(v.offset, 0);
  assert.equal(v.minPrice, 1_000_000);
  assert.equal(v.agent, "+1868");
  assert.equal(searchInputFrom({}).kind, "supply");
});

test("people: one row per sender phone, with the latest name and post counts per tab", () => {
  const root = world({
    supply: [
      post({ messageId: "pp-1", senderName: "Old Name", sentAt: "2026-11-01T12:00:00.000Z" }),
      post({ messageId: "pp-2", senderName: "New Name", sentAt: "2026-11-05T12:00:00.000Z", originalText: "a different listing", area: "St. Ann's" }),
      post({ messageId: "pp-3", senderName: null, sentAt: "2026-11-06T12:00:00.000Z", area: null, price: null, type: null, originalText: "vague from same agent" }),
    ],
  });
  syncFromJsonl(root);
  const people = withSearchStore(root, (s) => s.search({ kind: "supply", agent: "new name" }));
  assert.equal(people.total, 2, "both records of that phone match by the person's latest name, even the one stored under the old name");
});

test("export: a header row per tab, strings only, times in AST, and no line for a missing value", () => {
  const root = world({
    supply: [post({ messageId: "x-s", price: null, beds: null, originalText: "Maraval house, price on request" })],
    demand: [post({ messageId: "x-d", set: "demand", category: "buyer_request", listingType: "rent", originalText: "Two bed in Maraval wanted", senderPhone: OTHER, senderName: null, beds: 2, price: null, type: "apartment", area: "Maraval" })],
  });
  syncFromJsonl(root);
  const sheets = exportSheets(root);
  assert.deepEqual(Object.keys(sheets), ["Supply", "Demand", "Needs explanation"]);
  assert.equal(sheets.Supply[0][0], "First seen (AST)");
  assert.equal(sheets["Needs explanation"][0].length, 12);
  assert.equal(sheets.Supply[1][0], "2026-11-02 08:00 AST", "2026-11-02T12:00Z is 08:00 in Trinidad");
  assert.equal(sheets.Supply[1][9], "", "a missing beds value is an empty string");
  for (const rows of Object.values(sheets)) for (const row of rows) for (const cell of row) assert.equal(typeof cell, "string");
});

test("the database file is created 0600", () => {
  const root = world({ supply: [post({ messageId: "perm-1" })] });
  syncFromJsonl(root);
  assert.equal(statSync(join(root, "search.db")).mode & 0o777, 0o600);
});

test("a queue id from an old rebuild survives as long as one of its messages is still vague", () => {
  const root = world({
    supply: [
      post({ messageId: "stable-1", area: null, price: null, type: null, originalText: "vague stable" }),
      post({ messageId: "stable-2", area: null, price: null, type: null, originalText: "vague stable", groupName: "Test Group B", sentAt: "2026-11-03T12:00:00.000Z" }),
    ],
  });
  syncFromJsonl(root);
  const [before] = rowsOf(root, "vague");
  assert.equal(before.messageIds.length, 2);
  const store = SearchStore.open(root);
  try {
    store.teach(before.id, { answer: "a note" });
  } finally {
    store.close();
  }
  const [after] = rowsOf(root, "vague");
  assert.equal(after.id, before.id, "the id is the hash of the first message, so it does not move");
  assert.equal(after.explanation, "a note");
});

test("an explanation follows its item out of the queue: on the promoted row, in search and export, and after a rebuild", () => {
  const root = world({
    supply: [
      post({ messageId: "k-1", area: null, price: null, type: null, originalText: "Blue Haven townhouse, DM me" }),
      post({ messageId: "k-2", area: null, price: null, type: null, originalText: "is blue haven open", sentAt: "2026-11-03T12:00:00.000Z" }),
    ],
  });
  syncFromJsonl(root);
  const item = rowsOf(root, "vague").find((r) => r.messageIds.includes("k-1"))!;
  const note = "Blue Haven is a townhouse development";
  withSearchStore(root, (s) => s.teach(item.id, { answer: note, term: "blue haven", area: "Blue Haven", type: "townhouse" }));

  assert.equal(rowsOf(root, "vague").length, 0, "both items are clear through the alias now");
  const promoted = () => rowsOf(root, "supply").find((r) => r.messageIds.includes("k-1"))!;
  assert.equal(promoted().explanation, note);
  assert.ok(promoted().explainedAt, "the explained time is kept");
  assert.equal(rowsOf(root, "supply").find((r) => r.messageIds.includes("k-2"))?.explanation, note, "the other item, promoted by the same alias, carries the note too");

  // A rebuild, and a sync after the JSONL changes, keep the note.
  syncFromJsonl(root, { force: true });
  assert.equal(promoted().explanation, note);

  const sheets = exportSheets(root);
  const header = sheets.Supply[0];
  const col = header.indexOf("Explanation");
  assert.ok(col >= 0 && header.includes("Explained (AST)"));
  const line = sheets.Supply.find((r) => r[header.indexOf("Text")] === "Blue Haven townhouse, DM me");
  assert.equal(line?.[col], note);
  assert.match(line?.[col + 1] ?? "", /^\d{4}-\d{2}-\d{2} /, "the explained time is in AST");
});

test("a database from before the explanation columns is migrated in place, keeping the owner's notes", () => {
  const root = world({
    supply: [post({ messageId: "m-1", area: null, price: null, type: null, originalText: "vague old one" })],
  });
  syncFromJsonl(root);
  const [item] = rowsOf(root, "vague");
  withSearchStore(root, (s) => s.teach(item.id, { answer: "an old note" }));

  // Simulate the old layout: no explanation columns on supply and demand, and the old schema version.
  const raw = new DatabaseSync(join(root, SEARCH_DB));
  raw.exec("ALTER TABLE supply DROP COLUMN explanation; ALTER TABLE supply DROP COLUMN explained_at; ALTER TABLE demand DROP COLUMN explanation; ALTER TABLE demand DROP COLUMN explained_at;");
  raw.prepare("UPDATE meta SET value = '1|old' WHERE key = 'fingerprint'").run();
  raw.close();

  const counts = syncFromJsonl(root);
  assert.equal(counts.rebuilt, true);
  assert.equal(rowsOf(root, "vague")[0]?.explanation, "an old note", "the note is still on the queue item after the migration");
});
