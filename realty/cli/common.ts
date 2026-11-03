import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Crm, crmEnv } from "../crm.ts";
import { CrmIndex } from "../dedupe.ts";
import type { Agent } from "../agents.ts";
import { proposalsMarkdown, type Proposal } from "../proposals.ts";

/** What both CLIs share: arguments, the output folder and its ledgers, the CRM snapshot, the apply step. */

export function args(argv = process.argv.slice(2)): { flags: Set<string>; values: Map<string, string[]> } {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(a.slice(2), [...(values.get(a.slice(2)) ?? []), next]);
      i++;
    } else flags.add(a.slice(2));
  }
  return { flags, values };
}

export type Ledger = { proposals: string[]; files: Record<string, string>; applied: Record<string, string> };

export function readLedger(dir: string): Ledger {
  const p = join(dir, "ledger.json");
  if (!existsSync(p)) return { proposals: [], files: {}, applied: {} };
  const j = JSON.parse(readFileSync(p, "utf8")) as Partial<Ledger>;
  return { proposals: j.proposals ?? [], files: j.files ?? {}, applied: j.applied ?? {} };
}

export function writeLedger(dir: string, l: Ledger) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "ledger.json"), JSON.stringify(l, null, 2), { mode: 0o600 });
}

/** proposals.json + proposals.md in a new dated folder (0700: they hold people's contact details). */
export function writeProposals(dir: string, title: string, ps: Proposal[]): string {
  const run = join(dir, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(run, { recursive: true, mode: 0o700 });
  writeFileSync(join(run, "proposals.json"), JSON.stringify(ps, null, 2), { mode: 0o600 });
  writeFileSync(join(run, "proposals.md"), proposalsMarkdown(title, ps), { mode: 0o600 });
  return run;
}

export async function crmSnapshot(skip: boolean): Promise<{ crm: Crm | null; index: CrmIndex | null; agents: Agent[]; note: string }> {
  const e = crmEnv();
  if (skip || !e) return { crm: null, index: null, agents: [], note: skip ? "CRM skipped (--no-crm): nothing was deduped" : "CRM not set up (ONEON1_CRM_*): nothing was deduped" };
  const crm = new Crm(e);
  const agents = await crm.agents();
  const { contacts, missing } = await crm.contacts();
  return { crm, index: new CrmIndex(contacts), agents, note: `deduped against ${contacts.length} CRM contacts${missing.length ? ` (couldn't read: ${missing.join(", ")})` : ""}` };
}

/** Writes the approved, unwritten proposals in a proposals.json. A dry run unless ONEON1_CRM_WRITES=1. */
export async function applyApproved(dir: string, file: string): Promise<void> {
  const ps = JSON.parse(readFileSync(file, "utf8")) as Proposal[];
  const ledger = readLedger(dir);
  const approved = ps.filter((p) => p.approved && p.write && !ledger.applied[p.id]);
  const todo = approved.filter((p) => !p.blockers.length);
  if (approved.length > todo.length) console.log(`${approved.length - todo.length} approved proposal(s) are blocked (see "blockers") and won't be written.`);
  if (process.env.ONEON1_CRM_WRITES !== "1") {
    console.log(`Dry run: ${todo.length} approved proposal(s) would be written. Set ONEON1_CRM_WRITES=1 to write them.`);
    return;
  }
  const e = crmEnv();
  if (!e) throw new Error("the CRM isn't set up (ONEON1_CRM_*)");
  const crm = new Crm(e);
  let ok = 0;
  for (const p of todo) {
    try {
      ledger.applied[p.id] = (await crm.apply(p)) || "written";
      writeLedger(dir, ledger);
      ok++;
    } catch (err) {
      console.error(`Not written: ${p.id}: ${(err as Error).message}`);
    }
  }
  console.log(`Wrote ${ok} of ${todo.length} approved proposal(s).`);
}
