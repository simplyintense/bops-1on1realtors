import { readFileSync } from "node:fs";
import { parseAreaTeachFile } from "../flow/taught-areas.ts";
import { SearchStore } from "../node/search-store.ts";
import { argValue, searchRoot } from "./search-args.ts";

/**
 * Teach Bops the nearby areas from map research (realty/data/area-nearby-ai-maps.json), into the search store's area tables.
 * Taught rows are kept apart from the shared knowledge, so term matching and the Teach list don't see them. Matching then uses
 * them where both areas are taught (flow/taught-areas.ts). Reversible.
 *
 *   npm run realty:area-teach -- --file realty/data/area-nearby-ai-maps.json --by ai-maps
 *   npm run realty:area-teach -- --undo ai-maps
 *   (add --root DIR for another store root, as the other search CLIs)
 *
 * Idempotent: a re-run updates the same rows. --undo removes exactly the rows taught by that name. Counts only are printed.
 */

const root = searchRoot();
const undo = argValue("undo");

if (undo) {
  const store = SearchStore.open(root);
  try {
    const removed = store.undoAreaTeach(undo);
    console.log(`Undone for "${undo}": places ${removed.places}, aliases ${removed.aliases}, pairs ${removed.pairs}.`);
  } finally {
    store.close();
  }
  process.exit(0);
}

const file = argValue("file");
const by = argValue("by");
if (!file || !by) {
  console.error("Usage: area-teach.ts --file FILE.json --by NAME   |   area-teach.ts --undo NAME   [--root DIR]");
  process.exit(2);
}

let parsed;
try {
  parsed = parseAreaTeachFile(JSON.parse(readFileSync(file, "utf8")));
} catch (err) {
  console.error(`Could not read the teaching file: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

const store = SearchStore.open(root);
try {
  const n = store.teachAreas(parsed, by);
  console.log(`Taught by "${by}": places ${n.places}, aliases ${n.aliases}, pairs ${n.pairs} (nearby ${n.nearby}, not nearby ${n.pairs - n.nearby}).`);
} finally {
  store.close();
}
