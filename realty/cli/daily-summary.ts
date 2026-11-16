import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDailySummaryArgs, SUMMARY_SEND_OFF } from "../flow/daily-summary.ts";
import { loadDailySummary, sendTestDailySummary } from "../node/daily-summary.ts";
import { searchRoot } from "./search-args.ts";

/**
 * The daily Auto-Match summary in the terminal: a PREVIEW of one email to Wendy and admin (Chrystalle), covering the
 * previous 24 hours of alerts that were actually sent, with Miles on BCC (the BCC is not printed). Read only of the CRM.
 * Live morning sending happens in the app scheduler when DAILY_SUMMARY_ENABLED is on. This CLI never sends the staff
 * copy. --test-send emails one copy to miles@simplyintense.com only, with no CC or BCC, and does not record the day.
 *   npm run realty:daily-summary                         prints the plain-text preview to stdout
 *   npm run realty:daily-summary -- --txt PATH           writes the plain-text preview to PATH
 *   npm run realty:daily-summary -- --out PATH           writes the HTML preview to PATH
 *   npm run realty:daily-summary -- --test-send          sends today's summary to miles@simplyintense.com only
 *   npm run realty:daily-summary -- --send               refused (exit 2); use the flag + morning scheduler
 * The summary line goes to stderr. No secret or env value is printed.
 */

async function main(): Promise<void> {
  const args = parseDailySummaryArgs(process.argv.slice(2));
  if (args.send) {
    console.error(SUMMARY_SEND_OFF);
    process.exitCode = 2;
    return;
  }
  if (args.testSend) {
    const r = await sendTestDailySummary();
    if (r.ok) {
      console.error(`TEST send ok: ${r.id}. ${r.summary.alerts} alert${r.summary.alerts === 1 ? "" : "s"} in the last 24 hours. To miles@simplyintense.com only.`);
      process.stdout.write(`Subject: ${r.summary.subject}\n\n${r.summary.text}`);
      return;
    }
    console.error(`TEST send failed: ${r.error}`);
    process.exitCode = 1;
    return;
  }
  const root = searchRoot();
  const summary = await loadDailySummary({ root });
  console.error(
    `Daily summary preview: ${summary.alerts} alert${summary.alerts === 1 ? "" : "s"} to ${summary.agents} agent${summary.agents === 1 ? "" : "s"}. ` +
      `Subject: ${summary.subject}. To: ${summary.to.join(", ")}. Nothing sent.`,
  );
  if (!args.out && !args.txt) {
    process.stdout.write(summary.text);
    return;
  }
  if (args.txt) {
    mkdirSync(dirname(args.txt), { recursive: true });
    writeFileSync(args.txt, summary.text);
    console.error(`Wrote plain text: ${args.txt}`);
  }
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, summary.html);
    console.error(`Wrote HTML: ${args.out}`);
  }
}

main().catch((err: unknown) => {
  console.error(`Daily summary failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
