import { writeFileSync } from "node:fs";
import { exportSheets } from "../node/search-store.ts";
import { argValue, searchRoot } from "./search-args.ts";

/**
 * The three tabs as JSON (Supply, Demand, Needs explanation): header row first, all values strings, times in AST.
 * Contains phone numbers and original text, so it is written 0600 with --out, and only to stdout otherwise.
 *   node --experimental-strip-types realty/cli/search-export.ts [--root DIR] [--out FILE]
 */
const json = `${JSON.stringify(exportSheets(searchRoot()), null, 2)}\n`;
const out = argValue("out");
if (out) writeFileSync(out, json, { mode: 0o600 });
else process.stdout.write(json);
