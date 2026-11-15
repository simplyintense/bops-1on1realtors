import { join } from "node:path";
import { runtimeEnv, type Env } from "../flow/env.ts";

/**
 * The Periskope store root, shared by the poller, the backfill, the intake, the search store and every
 * route or page that reads them: PERISKOPE_ROOT when set, else .data/realty/periskope under the working
 * directory. Callers that need a different root pass it explicitly; nothing else should build this path.
 */
export function periskopeRoot(env: Env = runtimeEnv()): string {
  return env.PERISKOPE_ROOT?.trim() || join(process.cwd(), ".data", "realty", "periskope");
}
