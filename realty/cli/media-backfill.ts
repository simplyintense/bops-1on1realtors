import { backfillMedia } from "../node/listing-media.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { searchRoot } from "./search-args.ts";

/**
 * One-time backfill of listing photos. Recompresses the original files kept by the first version into the content-addressed
 * layout (WebP display and thumb, with a dHash per photo), then tries one download for each supply post that has URLs but no
 * photos. Counts only: no URL, phone or message text is printed.
 *   npm run realty:media-backfill                 the default root
 *   npm run realty:media-backfill -- --root DIR   another store root
 */

async function main(): Promise<void> {
  const store = new PeriskopeStore(searchRoot());
  const c = await backfillMedia(store);
  console.log(`Listing photo backfill: ${c.considered} supply posts considered.`);
  console.log(`  files written: ${c.filesWritten}`);
  console.log(`  hashes computed: ${c.hashes}`);
  console.log(`  skipped: ${c.skipped.nonImage} non-image, ${c.skipped.cap} over the 2 GB cap, ${c.skipped.failed} failed`);
}

main().catch((err: unknown) => {
  console.error(`Listing photo backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
