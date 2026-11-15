import assert from "node:assert/strict";
/// <reference path="../node/node-sqlite.d.ts" />
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { bestGuess, applyKnownTerms, aliasesOf, termAt, type KnownTerm } from "../flow/knowledge.ts";
import { interpret, postRecordOf, type ParsedMessage } from "../flow/periskope.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { SEARCH_DB, SearchInputError, SearchStore, syncFromJsonl, taughtTermsFrom, withSearchStore, type SearchRow } from "../node/search-store.ts";

// Invented data only: made-up agents, 555-style numbers, invented listings and places.
const AGENT = "+18685550101";
const term = (over: Partial<KnownTerm> & { term: string }): KnownTerm => ({ area: null, development: null, type: null, listingType: null, ...over });

function world(supply: Record<string, unknown>[] = []) {
  const root = mkdtempSync(join(tmpdir(), "knowledge-"));
  writeFileSync(join(root, "supply.jsonl"), supply.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
  writeFileSync(join(root, "demand.jsonl"), "", { mode: 0o600 });
  return root;
}

function vaguePost(messageId: string, originalText: string, sentAt = "2026-11-02T12:00:00.000Z"): Record<string, unknown> {
  return { messageId, chatId: "chat-a@g.us", groupName: "Test Group A", sentAt, category: "listing_for_sale", cobroke: false, senderPhone: AGENT, senderName: "Test Agent", firm: null, area: null, development: null, price: null, currency: null, beds: null, baths: null, type: null, listingType: null, intent: null, propertyClass: null, notes: null, originalText, set: "supply" };
}

function rowsOf(root: string, kind: "supply" | "demand" | "vague"): SearchRow[] {
  return withSearchStore(root, (s) => s.search({ kind, limit: 500 })).rows;
}

/** A stored post built by the same parser as ingest (the posts store is what teach re-parses). */
function storedPost(messageId: string, body: string, sentAt = "2026-11-02T12:00:00.000Z") {
  const m: ParsedMessage = { messageId, chatId: "chat-a@g.us", sender: AGENT, senderName: "Test Agent", chatName: "Test Group A", body, fromMe: false, hasText: true, textOnly: true, mediaUrls: [], sentAt };
  return postRecordOf({ message: m, phone: AGENT, interpretation: interpret(body), sentAt });
}

test("the parser reads taught terms: a place, a development and a sale/rent rule fill what the text leaves empty", () => {
  const terms = [
    term({ term: "blue haven", area: "Blue Haven", type: "townhouse" }),
    term({ term: "the pines", development: "The Pines" }),
    term({ term: "to let", listingType: "rent" }),
  ];
  const plain = interpret("Blue Haven, call me");
  assert.equal(plain.facts.area, null, "no taught term, no area");
  const taught = interpret("Blue Haven townhouse, call me", terms);
  assert.equal(taught.facts.area, "Blue Haven");
  assert.equal(taught.facts.type, "townhouse");
  assert.equal(interpret("The Pines, DM me", terms).facts.area, "The Pines", "a development fills the area the matcher and search read");
  assert.equal(interpret("nice place to let, DM me", terms).facts.intent, "rent");
  assert.equal(interpret("Blue Haven, 3 beds for rent", []).facts.intent, "rent", "the built-in gazetteer alone still reads the text");
});

test("the built-in gazetteer always wins: a taught term never overwrites what the parser found", () => {
  const out = applyKnownTerms({ area: "Maraval", development: null, type: "house", listingType: null }, "Blue Haven house in Maraval", [term({ term: "blue haven", area: "Blue Haven", type: "townhouse" })]);
  assert.deepEqual(out, { area: "Maraval", development: null, type: "house", listingType: null });
});

test("term matching is whole-word and case-insensitive, and the first match position is reported", () => {
  assert.equal(termAt("Lowlands is quiet", "lowlands"), 0);
  assert.equal(termAt("nolowlands here", "lowlands"), -1, "no match inside a word");
  assert.equal(termAt("Quiet street near Blue Haven", "blue haven"), 18);
});

test("aliasesOf lists the taught places for the matcher, by their canonical name", () => {
  assert.deepEqual(
    aliasesOf([term({ term: "blue haven", area: "Blue Haven" }), term({ term: "the pines", development: "The Pines" }), term({ term: "to let", listingType: "rent" })]),
    [
      { alias: "blue haven", canonical: "Blue Haven" },
      { alias: "the pines", canonical: "The Pines" },
    ],
  );
});

test("the best guess names the first known place, the type, sale or rent, and the price; 'No guess' when there is nothing", () => {
  const terms = [term({ term: "blue haven", area: "Blue Haven" }), term({ term: "the pines", development: "The Pines" })];
  assert.equal(bestGuess("Two bed apartment for rent in Blue Haven, TTD 4,500 a month", terms), "Blue Haven · apartment · rent · TTD 4,500 a month");
  assert.equal(bestGuess("The Pines is lovely, DM me", terms), "The Pines");
  assert.equal(bestGuess("anyone got something?", terms), "No guess");
});

test("seeding is idempotent: the area knowledge and the gazetteer are there once, and a taught row is never touched", () => {
  const root = world([vaguePost("s-1", "anyone got something?")]);
  syncFromJsonl(root);
  const raw = new DatabaseSync(join(root, SEARCH_DB));
  const count = () => Number(raw.prepare("SELECT COUNT(*) AS n FROM knowledge").get()?.n);
  const seeded = count();
  assert.ok(seeded > 80, "the ~78 area places and the developments are seeded");
  // The area knowledge seeds first, so its row for a name the gazetteer also has is the one kept (INSERT OR IGNORE).
  assert.equal(raw.prepare("SELECT source FROM knowledge WHERE term = 'la fontaine' AND kind = 'development'").get()?.source, "area-knowledge");
  assert.equal(raw.prepare("SELECT source FROM knowledge WHERE term = 'owp' AND kind = 'alias'").get()?.source, "gazetteer", "a gazetteer alias with no area-knowledge twin");
  assert.equal(raw.prepare("SELECT kind, area, source FROM knowledge WHERE term = 'maraval'").get()?.kind, "place");

  const store = SearchStore.open(root);
  try {
    store.teach(rowsOf(root, "vague")[0].id, { answer: "a note about nothing in particular" });
    store.seed();
    store.seed();
  } finally {
    store.close();
  }
  assert.equal(count(), seeded + 1, "one taught note, and no repeats of the seeds");
  raw.close();
});

test("the old alias table is folded into knowledge once, with its rows kept as taught aliases", () => {
  const root = world([vaguePost("m-1", "is blue haven open?")]);
  const raw = new DatabaseSync(join(root, SEARCH_DB));
  raw.exec(`CREATE TABLE aliases (term TEXT PRIMARY KEY, area TEXT, development TEXT, type TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO aliases VALUES ('blue haven', 'Blue Haven', NULL, 'townhouse', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');`);
  raw.close();

  syncFromJsonl(root);
  const again = new DatabaseSync(join(root, SEARCH_DB));
  assert.equal(again.prepare("SELECT 1 FROM sqlite_master WHERE name = 'aliases'").get(), undefined, "the alias table is gone");
  const row = again.prepare("SELECT kind, area, type, source, taught_at FROM knowledge WHERE term = 'blue haven'").get();
  assert.deepEqual({ kind: row?.kind, area: row?.area, type: row?.type, source: row?.source, at: row?.taught_at }, { kind: "alias", area: "Blue Haven", type: "townhouse", source: "taught", at: "2026-11-01T00:00:00.000Z" });
  again.close();
  assert.deepEqual(taughtTermsFrom(root).filter((t) => t.term === "blue haven").map((t) => t.area), ["Blue Haven"]);
  assert.equal(rowsOf(root, "supply").find((r) => r.messageIds.includes("m-1"))?.area, "Blue Haven", "the migrated alias applies in the sync");
});

test("a taught alias applies on a plain sync that finds the JSONL unchanged (another process taught it)", () => {
  const root = world([vaguePost("p-1", "Blue Haven, call me")]);
  syncFromJsonl(root);
  assert.equal(rowsOf(root, "vague").length, 1);
  const raw = new DatabaseSync(join(root, SEARCH_DB));
  raw.prepare("INSERT INTO knowledge (kind, term, area, source, taught_by, taught_at) VALUES ('alias', 'blue haven', 'Blue Haven', 'taught', 'cli', ?)").run("2026-11-10T00:00:00.000Z");
  raw.close();
  const counts = syncFromJsonl(root);
  assert.equal(counts.rebuilt, true, "the knowledge stamp changed, so the tables rebuild");
  assert.equal(rowsOf(root, "vague").length, 0);
});

test("teach with a term and a sale/rent answer saves a rule; without a term it saves a note with no term", () => {
  const root = world([vaguePost("r-1", "for sale or rent, quiet spot, DM me")]);
  syncFromJsonl(root);
  const [item] = rowsOf(root, "vague");
  withSearchStore(root, (s) => {
    const rule = s.teach(item.id, { answer: "a sale listing when it says to let", term: "to let", listingType: "rent" }, "cli");
    assert.equal(rule.saved, "rule");
    assert.deepEqual(s.taught().map((t) => [t.kind, t.term, t.listingType, t.taughtBy]), [["rule", "to let", "rent", "cli"]]);
    assert.ok(s.knownTerms().some((t) => t.term === "to let" && t.listingType === "rent"));
  });
  const root2 = world([vaguePost("n-1", "anyone got something?")]);
  syncFromJsonl(root2);
  const [n] = rowsOf(root2, "vague");
  const note = withSearchStore(root2, (s) => s.teach(n.id, { answer: "wants a flat, no place named" }));
  assert.equal(note.saved, "note");
  assert.equal(note.term, null);
  assert.equal(note.reparsed, 0);
  assert.equal(note.stillVague, true);
});

test("a place, a type or sale/rent without a term is refused, and so is a listingType other than sale, rent or shortlet", () => {
  const root = world([vaguePost("v-1", "anyone?")]);
  syncFromJsonl(root);
  const [item] = rowsOf(root, "vague");
  withSearchStore(root, (s) => {
    assert.throws(() => s.teach(item.id, { answer: "ok", area: "Maraval" }), SearchInputError);
    assert.throws(() => s.teach(item.id, { answer: "ok", listingType: "rent" }), SearchInputError);
    assert.throws(() => s.teach(item.id, { answer: "ok", term: "anyone", listingType: "lease" }), SearchInputError);
    assert.deepEqual(s.taught(), []);
  });
});

test("a shortlet listing type can be taught, including the spelling short-let, and is stored as shortlet", () => {
  const root = world([vaguePost("v-2", "Looking for Carnival rental for one person from Jan 15")]);
  writeFileSync(join(root, "demand.jsonl"), `${JSON.stringify({ ...vaguePost("v-2", "Looking for Carnival rental for one person from Jan 15"), set: "demand", category: "rental_request" })}\n`, { mode: 0o600 });
  syncFromJsonl(root);
  const item = [...rowsOf(root, "vague"), ...rowsOf(root, "demand")].find((r) => r.messageIds.includes("v-2"));
  assert.ok(item);
  withSearchStore(root, (s) => {
    const r = s.teach(item.id, { answer: "A Carnival short let: a seasonal stay at premium prices, usually a couple of weeks.", term: "carnival rental", type: "carnival rental", listingType: "short-let" }, "Miles");
    assert.equal(r.saved, "alias");
    assert.equal(s.taught().find((t) => t.term === "carnival rental")?.listingType, "shortlet");
    assert.equal(s.taught().find((t) => t.term === "carnival rental")?.taughtBy, "Miles");
  });
});

test("teach re-parses the stored posts that contain the term, and promotes the vague ones it clears", () => {
  const root = world();
  // Each post has a price or beds (so it is a post, not "other") and no place Bops knows, so it is in the queue.
  const store = new PeriskopeStore(root);
  store.reprojectObservation([
    storedPost("t-1", "FOR SALE - Blue Haven, asking $2,500,000"),
    storedPost("t-2", "anyone got a 3 bed in Blue Haven?", "2026-11-03T12:00:00.000Z"),
    storedPost("t-3", "FOR SALE - Maraval, 3 beds, asking $2,500,000", "2026-11-04T12:00:00.000Z"),
  ]);
  syncFromJsonl(root);
  const before = rowsOf(root, "vague");
  assert.equal(before.length, 2, "the two Blue Haven posts have no place Bops knows yet");
  const [item] = before.filter((r) => r.messageIds.includes("t-1"));

  const result = withSearchStore(root, (s) => s.teach(item.id, { answer: "Blue Haven, a townhouse development", term: "blue haven", area: "Blue Haven", type: "townhouse" }));
  assert.equal(result.reparsed, 2, "both stored posts contain the term, and both were parsed again");
  assert.equal(result.promoted, true);
  assert.equal(result.promotedRecords, 2);
  assert.equal(rowsOf(root, "vague").length, 0);

  // The stored post itself carries the new place, so a later reclassify keeps it.
  const reparsed = new PeriskopeStore(root).posts().find((p) => p.messageId === "t-1");
  assert.equal(reparsed?.area, "Blue Haven");
  assert.equal(reparsed?.type, "townhouse");
  assert.equal(rowsOf(root, "supply").find((r) => r.messageIds.includes("t-3"))?.area, "Maraval", "a post without the term is untouched");
});

test("the queue carries Bops's best guess for each open item, and a taught place clears it", () => {
  const root = world([vaguePost("g-1", "Blue Haven apartment for rent, TTD 4,500 a month")]);
  syncFromJsonl(root);
  const before = withSearchStore(root, (s) => s.openQueue());
  assert.equal(before.total, 1);
  assert.equal(before.rows[0].guess, "apartment · rent · TTD 4,500 a month", "no place yet: the type, sale or rent and the price");

  const after = withSearchStore(root, (s) => {
    s.teach(before.rows[0].id, { answer: "a place in Blue Haven", term: "blue haven", area: "Blue Haven" });
    return s.openQueue();
  });
  assert.equal(after.total, 0, "the taught place clears it; nothing left to guess at");
});

test("taughtTermsFrom is empty when there is no database yet, and never creates one", () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-none-"));
  assert.deepEqual(taughtTermsFrom(root), []);
  assert.equal(existsSync(join(root, SEARCH_DB)), false, "no database file was created by the read");
});
