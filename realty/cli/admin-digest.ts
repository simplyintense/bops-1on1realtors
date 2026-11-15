import { writeFileSync } from "node:fs";
import { parseDigestArgs, SEND_REFUSED } from "../flow/admin-digest.ts";
import { loadAdminDigest } from "../node/admin-digest.ts";
import { searchRoot } from "./search-args.ts";

/**
 * The admin match digest in the terminal: a PREVIEW of the one email to Crystal (admin@1on1realtors.com), the strong matches
 * (75 and above) not yet actioned, grouped by the agent who holds each listing. Read only: nothing is sent, and nothing is
 * written to the CRM. It doesn't record first sight of any match either.
 *   npm run realty:admin-digest                          prints the plain-text preview to stdout (the body)
 *   npm run realty:admin-digest -- --txt PATH            writes the plain-text preview to PATH
 *   npm run realty:admin-digest -- --out PATH            writes the HTML preview to PATH
 *   npm run realty:admin-digest -- --root DIR            another store root
 *   npm run realty:admin-digest -- --send                refused: sending is off in this build (exit 2)
 * The summary goes to stderr, so stdout can be the body. Phone numbers appear only inside the wa.me links, and no secret or env
 * value is printed.
 */

async function main(): Promise<void> {
  const args = parseDigestArgs(process.argv.slice(2));
  if (args.send) {
    console.error(SEND_REFUSED);
    process.exitCode = 2;
    return;
  }
  const digest = await loadAdminDigest({ root: searchRoot() });
  const matches = `${digest.matches} match${digest.matches === 1 ? "" : "es"}`;
  const agents = `${digest.agents} agent group${digest.agents === 1 ? "" : "s"}`;
  console.error(`Admin digest preview: ${matches} for ${agents}. Subject: ${digest.subject}. Nothing sent.`);
  if (!args.out && !args.txt) {
    process.stdout.write(digest.text);
    return;
  }
  if (args.txt) {
    writeFileSync(args.txt, digest.text);
    console.error(`Wrote plain text: ${args.txt}`);
  }
  if (args.out) {
    writeFileSync(args.out, digest.html);
    console.error(`Wrote HTML: ${args.out}`);
  }
}

main().catch((err: unknown) => {
  console.error(`Admin digest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
