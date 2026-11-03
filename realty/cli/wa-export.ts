import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Google, googleCreds } from "../google.ts";
import { readExport } from "../wa-reader.ts";
import type { Proposal } from "../proposals.ts";
import { applyApproved, args, crmSnapshot, readLedger, writeLedger, writeProposals } from "./common.ts";

/**
 * WhatsApp export reader (Si.Clienty's daily job). Reads the WhatsApp "Export chat" files (.txt or .zip)
 * dropped in a Drive folder, or given with --file, and writes proposals for approval. Writes nothing to
 * the CRM; `--apply <proposals.json>` writes the approved ones, and only with ONEON1_CRM_WRITES=1.
 *
 *   npm run realty:wa                         # the Drive folder (ONEON1_WA_DRIVE_FOLDER_ID)
 *   npm run realty:wa -- --file chat.zip      # a file on this machine
 *   npm run realty:wa -- --no-crm             # don't read the CRM (no dedupe)
 *   npm run realty:wa -- --apply <dir>/proposals.json
 *
 * Prints counts only; names and numbers go to the proposals files (0600), never the log.
 */

const { flags, values } = args();
const out = values.get("out")?.[0] ?? process.env.ONEON1_REALTY_OUT ?? ".data/realty/whatsapp";

async function main() {
  const apply = values.get("apply")?.[0];
  if (apply) return applyApproved(out, apply);

  const ledger = readLedger(out);
  const files: { key: string; name: string; data: () => Promise<Buffer>; stamp: string }[] = [];
  for (const f of values.get("file") ?? []) files.push({ key: `file:${f}`, name: basename(f), data: async () => readFileSync(f), stamp: "" });
  if (!files.length) {
    const folder = process.env.ONEON1_WA_DRIVE_FOLDER_ID?.trim();
    const creds = googleCreds(process.env.ONEON1_DRIVE_REFRESH_TOKEN);
    if (!folder || !creds) throw new Error("set ONEON1_WA_DRIVE_FOLDER_ID, ONEON1_GOOGLE_CLIENT_ID/SECRET and ONEON1_DRIVE_REFRESH_TOKEN, or pass --file");
    const g = new Google(creds);
    for (const f of await g.driveExports(folder)) {
      // A file already read at this version is skipped; a re-upload (newer modifiedTime) is read again.
      if (ledger.files[`drive:${f.id}`] === f.modifiedTime) continue;
      files.push({ key: `drive:${f.id}`, name: f.name, data: () => g.driveDownload(f.id), stamp: f.modifiedTime });
    }
  }
  if (!files.length) {
    console.log("No new WhatsApp exports.");
    return;
  }

  const snap = await crmSnapshot(flags.has("no-crm"));
  const defaultAgentId = /^\d+$/.test(process.env.ONEON1_DEFAULT_AGENT_ID ?? "") ? Number(process.env.ONEON1_DEFAULT_AGENT_ID) : null;
  const seen = new Set(ledger.proposals);
  const all: Proposal[] = [];
  for (const f of files) {
    try {
      const r = readExport(f.name, await f.data(), { crm: snap.index, agents: snap.agents, defaultAgentId, seen });
      all.push(...r.proposals);
      console.log(`${r.chat}: ${r.messages} messages, ${r.proposals.filter((p) => p.kind === "lead").length} leads, ${r.proposals.filter((p) => p.kind === "task").length} action items`);
      if (f.stamp) ledger.files[f.key] = f.stamp;
    } catch (err) {
      console.error(`Couldn't read ${f.name}: ${(err as Error).message}`);
    }
  }
  console.log(snap.note);
  if (!all.length) {
    writeLedger(out, ledger);
    console.log("Nothing new to propose.");
    return;
  }
  const dir = writeProposals(out, "WhatsApp exports: proposed CRM entries and tasks", all);
  ledger.proposals.push(...all.map((p) => p.id));
  writeLedger(out, ledger);
  const dupes = all.filter((p) => p.crm === "duplicate").length;
  console.log(`${all.length} proposal(s) (${dupes} already in the CRM) in ${dir}/proposals.md. Nothing was written to the CRM.`);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
