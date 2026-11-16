import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { alertEnvelopeLines, BASELINE_CONFIRM, parseAlertArgs, SEND_OFF } from "../flow/automatch-alert.ts";
import { loadAutoMatchAlerts, sendBaselineAutoMatchAlerts, sendTestAutoMatchAlert, syncAutoMatchAlerts } from "../node/automatch-alert.ts";
import { searchRoot } from "./search-args.ts";

/**
 * Auto-Match Alert in the terminal: a PREVIEW of one email per strong match (75 and above), addressed to the holding
 * agent, CC Crystal and Wendy. A BCC is set and is not printed in this preview. Read only of the CRM. It may record
 * suppressed keys so a later flag flip does not bulk-send. Live sending happens in the poller when AUTOMATCH_ALERT_ENABLED
 * is on and RESEND_API_KEY is set. The CLI never bulk-sends new matches. An explicit --send-baseline
 * (with --dry-run, or --confirm SEND-BASELINE) can email previously suppressed baseline matches and the first-review set once.
 *   npm run realty:automatch-alert                         prints the plain-text previews to stdout
 *   npm run realty:automatch-alert -- --txt PATH           writes the first plain-text preview (or all, joined) to PATH
 *   npm run realty:automatch-alert -- --out PATH           writes the first HTML preview to PATH
 *   npm run realty:automatch-alert -- --test               prefixes subjects with [TEST]
 *   npm run realty:automatch-alert -- --counts             dry-run counts and recipient headers (To/Cc/Bcc); nothing is sent
 *   npm run realty:automatch-alert -- --test-send          sends ONE fake [TEST] alert to miles@simplyintense.com only
 *   npm run realty:automatch-alert -- --test-send --aged   same, with a 32-day-old sample so the aged-lead line is visible
 *   npm run realty:automatch-alert -- --send-baseline --dry-run
 *                                                          previews suppressed baseline matches; nothing is sent
 *   npm run realty:automatch-alert -- --send-baseline --confirm SEND-BASELINE
 *                                                          emails those suppressed matches once, then marks them sent
 *   npm run realty:automatch-alert -- --send               refused (exit 2); use the flag + poller for live mail
 * The summary goes to stderr. No secret or env value is printed, and phone numbers appear only in the preview bodies.
 */

async function main(): Promise<void> {
  const args = parseAlertArgs(process.argv.slice(2));
  if (args.send) {
    console.error(SEND_OFF);
    process.exitCode = 2;
    return;
  }
  if (args.sendBaseline) {
    if (!args.dryRun && args.confirm !== BASELINE_CONFIRM) {
      console.error(`Refused: --send-baseline requires --dry-run or --confirm ${BASELINE_CONFIRM}. Nothing was sent.`);
      process.exitCode = 2;
      return;
    }
    const r = await sendBaselineAutoMatchAlerts({ dryRun: args.dryRun, confirm: args.confirm ?? undefined });
    if (r.error && !args.dryRun && r.sent === 0 && (r.failed === 0 || r.error.includes("Refused") || r.error.includes("RESEND_API_KEY"))) {
      console.error(r.error);
      process.exitCode = r.error.includes("RESEND_API_KEY") ? 1 : 2;
      return;
    }
    const lines = r.results.map((row) => {
      const age = row.ageDays == null ? "age unknown" : `${row.ageDays} day${row.ageDays === 1 ? "" : "s"}`;
      const score = `score ${row.score}`;
      const id = row.id ? ` · ${row.id}` : "";
      return `- ${row.agent} · ${row.listingTitle} · ${age} · ${score}${id}`;
    });
    const skippedLines = (r.skipped ?? []).map((row) => {
      const age = row.ageDays == null ? "age unknown" : `${row.ageDays} day${row.ageDays === 1 ? "" : "s"}`;
      const score = row.score == null ? "score unknown" : `score ${row.score}`;
      const who = row.agent ?? "unassigned";
      return `- ${who} · ${row.listingTitle} · ${age} · ${score} · skipped (${row.reason})`;
    });
    if (r.dryRun) {
      console.error(`Baseline dry-run: ${r.wouldSend} match${r.wouldSend === 1 ? "" : "es"} would be emailed (suppressed baseline plus first-review, de-duplicated).`);
      if (lines.length) console.error(lines.join("\n"));
      if (skippedLines.length) {
        console.error(`Skipped ${skippedLines.length}:`);
        console.error(skippedLines.join("\n"));
      }
      console.error("Nothing was sent.");
      return;
    }
    console.error(`Baseline send: ${r.sent} sent, ${r.failed} failed, of ${r.wouldSend} match${r.wouldSend === 1 ? "" : "es"}.`);
    if (lines.length) console.error(lines.join("\n"));
    if (skippedLines.length) {
      console.error(`Skipped ${skippedLines.length}:`);
      console.error(skippedLines.join("\n"));
    }
    if (r.failed > 0 || r.error) {
      if (r.error) console.error(r.error);
      process.exitCode = 1;
    }
    return;
  }
  if (args.testSend) {
    const r = await sendTestAutoMatchAlert({ agedDays: args.aged ?? undefined });
    if (r.ok) {
      console.error(`TEST send ok: ${r.id}`);
      process.stdout.write(`${r.id}\n`);
      return;
    }
    console.error(`TEST send failed: ${r.error}`);
    process.exitCode = 1;
    return;
  }
  const root = searchRoot();
  const loaded = await loadAutoMatchAlerts({ root, test: args.test });
  if (!args.counts) await syncAutoMatchAlerts({ root });
  const n = loaded.alerts.length;
  const summary =
    `Auto-Match Alert preview: ${n} match${n === 1 ? "" : "es"}. ` +
    `Would send ${loaded.plan.send.length}, suppress ${loaded.plan.suppress.length}, skip ${loaded.plan.skip.length}. ` +
    `On flip: ${loaded.flip.wouldSendImmediately} would go immediately, ${loaded.flip.wouldSuppress} would be held as the baseline. ` +
    `Enabled: ${loaded.enabled}. Transport: ${loaded.hasTransport ? "yes" : "no"}. Nothing bulk-sent from this CLI.`;
  console.error(summary);
  if (args.counts) {
    const sample = loaded.plan.send[0] ?? loaded.alerts[0];
    if (sample) {
      console.error(`Recipient headers (dry-run, nothing sent)${loaded.plan.send.length ? " for the next send" : " for a built alert (none waiting to send)"}:`);
      console.error(alertEnvelopeLines(sample));
    } else {
      console.error("No alerts to show recipient headers for.");
    }
    return;
  }
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
