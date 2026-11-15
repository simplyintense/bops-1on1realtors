import { runtimeEnv } from "../flow/env.ts";
import { listGroupChats, loadRoster, previewDiscovery } from "../node/periskope-discover.ts";
import { DEFAULT_PHONE_ID, readApiKey } from "../node/periskope-poll.ts";
import { periskopeRoot } from "../node/periskope-root.ts";
import { argValue } from "./search-args.ts";

/**
 * Group discovery, dry run only: lists every Periskope group (GET) and says which the poller would auto-add and
 * why not for the rest. Writes nothing: no roster, no consent, no backfill. The poller does the real discovery
 * once an hour. Usage: npm run realty:discover -- --dry-run [--root <dir>]
 * Prints group names, chat ids, member counts and reasons. Never message text, phone numbers or the key.
 */

const argv = process.argv.slice(2);
if (!argv.includes("--dry-run")) {
  console.error("Usage: npm run realty:discover -- --dry-run [--root <dir>]. The poller does the real discovery hourly.");
  process.exit(2);
}

const env = runtimeEnv();
const root = argValue("root", argv) || periskopeRoot(env);
const apiKey = readApiKey({ root, env });
if (!apiKey) {
  console.log(JSON.stringify({ ok: false, reason: "no API key" }));
  process.exit(1);
}
const phoneId = (env.PERISKOPE_PHONE_ID ?? DEFAULT_PHONE_ID).trim() || undefined;
const listed = await listGroupChats({ apiKey, phoneId });
if (!listed.ok) {
  console.log(JSON.stringify({ ok: false, code: listed.code }));
  process.exit(1);
}
const rows = previewDiscovery(listed.chats, env, loadRoster(root));
console.log(JSON.stringify({
  dryRun: true,
  checked: listed.chats.length,
  included: rows.filter((r) => r.included).length,
  groups: rows.map((r) => ({ group: r.group, chatId: r.chatId, members: r.members, included: r.included, reason: r.reason })),
}, null, 2));
