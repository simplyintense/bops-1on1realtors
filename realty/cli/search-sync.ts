import { syncFromJsonl } from "../node/search-store.ts";
import { hasFlag, searchRoot } from "./search-args.ts";

/**
 * Rebuild <root>/search.db from supply.jsonl and demand.jsonl (a no-op when they haven't changed; --force to rebuild).
 *   node --experimental-strip-types realty/cli/search-sync.ts [--root DIR] [--force]
 * Prints counts only: no text and no phone numbers.
 */
try {
  const counts = syncFromJsonl(searchRoot(), { force: hasFlag("force") });
  console.log(JSON.stringify(counts, null, 2));
} catch (e) {
  console.error(`search sync failed: ${(e as { code?: string }).code ?? (e as Error).name}`);
  process.exit(1);
}
