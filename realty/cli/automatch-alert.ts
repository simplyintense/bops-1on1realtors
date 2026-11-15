import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseAlertArgs, SEND_OFF } from "../flow/automatch-alert.ts";
import { loadAutoMatchAlerts, syncAutoMatchAlerts } from "../node/automatch-alert.ts";
import { searchRoot } from "./search-args.ts";

/**
 * Auto-Match Alert in the terminal: a PREVIEW of one email per strong match (75 and above), addressed to the holding
 * agent, CC Crystal, Wendy and Miles. Read only of the CRM. It may record suppressed keys so a later flag flip does not
 * bulk-send. It never sends mail.
 *   npm run realty:automatch-alert                         prints the plain-text previews to stdout
 *   npm run realty:automatch-alert -- --txt PATH           writes the first plain-text preview (or all, joined) to PATH
 *   npm run realty:automatch-alert -- --out PATH           writes the first HTML preview to PATH
 *   npm run realty:automatch-alert -- --test               prefixes subjects with [TEST]
 *   npm run realty:automatch-alert -- --send               refused (exit 2)
 * The summary goes to stderr. No secret or env value is printed, and phone numbers appear only in the preview bodies.
 */

async function main(): Promise<void> {
  const args = parseAlertArgs(process.argv.slice(2));
  if (args.send) {
    console.error(SEND_OFF);
    process.exitCode = 2;
    return;
  }
  const root = searchRoot();
  const loaded = await loadAutoMatchAlerts({ root, test: args.test });
  await syncAutoMatchAlerts({ root });
  const n = loaded.alerts.length;
  console.error(
    `Auto-Match Alert preview: ${n} match${n === 1 ? "" : "es"}. ` +
      `Would send ${loaded.plan.send.length}, suppress ${loaded.plan.suppress.length}, skip ${loaded.plan.skip.length}. ` +
      `On flip: ${loaded.flip.wouldSendImmediately} would go immediately, ${loaded.flip.wouldSuppress} would be held as the baseline. ` +
      `Enabled: ${loaded.enabled}. Nothing sent.`,
  );
  const text = loaded.alerts
    .map((a) => `To: ${a.to}\nCc: ${a.cc.join(", ")}\nFrom: ${a.from}\nSubject: ${a.subject}\n\n${a.text}`)
    .join("\n-----\n");
  if (!args.out && !args.txt) {
    process.stdout.write(text || "No new strong matches to preview.\n");
    return;
  }
  if (args.txt) {
    mkdirSync(dirname(args.txt), { recursive: true });
    writeFileSync(args.txt, text || "No new strong matches to preview.\n");
    console.error(`Wrote plain text: ${args.txt}`);
  }
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, loaded.alerts[0]?.html ?? `<!doctype html><html><body><p>No new strong matches to preview.</p></body></html>`);
    console.error(`Wrote HTML: ${args.out}`);
  }
}

main().catch((err: unknown) => {
  console.error(`Auto-Match Alert failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
