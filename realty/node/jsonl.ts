import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { FixtureCrm, type Fixture } from "../flow/source.ts";

/**
 * Node-only helpers for the CLI and tests. NOT part of the portable lead-flow core (realty/flow/*),
 * which has no node:* imports so it can run in a Deno edge function or a browser bundle too.
 */

/** Appends one line to a JSONL file (private: 0700 dir, 0600 file). Pass as DryRunOutbox's `append`. */
export function appendJsonl(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${line}\n`, { mode: 0o600 });
}

/** `(line) => appendJsonl(file, line)`, for DryRunOutbox's `append` or runDemoDay's `outboxAppend`. */
export const jsonlAppender = (file: string) => (line: string) => appendJsonl(file, line);

/** The fixture CRM from a JSON file; default realty/fixtures/crm.json (made-up people and listings). */
export function loadFixtureCrm(file: string | URL = new URL("../fixtures/crm.json", import.meta.url)): FixtureCrm {
  return FixtureCrm.from(JSON.parse(readFileSync(file, "utf8")) as Fixture);
}
