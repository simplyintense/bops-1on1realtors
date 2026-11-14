import { join } from "node:path";
import { pollOnce } from "../node/periskope-poll.ts";

/**
 * One read-only poll of the six pinned WhatsApp groups (GET only). Usage:
 *   node --experimental-strip-types realty/cli/periskope-poll.ts --root /app/.data/realty/periskope [--key-file PATH] [--phone-id ID]
 * Prints counts only: no message text and no phone numbers.
 */

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = arg("root", join(process.cwd(), ".data", "realty", "periskope"));
const result = await pollOnce({
  root,
  keyFile: arg("key-file") || undefined,
  phoneId: arg("phone-id") || undefined,
});
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(2);
