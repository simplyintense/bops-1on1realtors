import { dateAst } from "../node/group-posts.ts";
import { NotInQueueError, SearchInputError, withSearchStore, type SearchRow } from "../node/search-store.ts";
import { argValue, hasFlag, searchRoot } from "./search-args.ts";

/**
 * The owner's terminal for teaching Bops: the same teach as /realty/learn, with no sign-in (it reads this machine's store).
 *   node --experimental-strip-types realty/cli/learn.ts --list
 *   node --experimental-strip-types realty/cli/learn.ts --teach <id> --answer "Maraval house, not a rental" [--term "blue haven" --area "Blue Haven" --development X --type house --listing-type sale]
 * Times are AST. Text is printed to this terminal only; nothing is logged or sent.
 */

const compact = (s: string | null, width: number) => {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > width ? `${one.slice(0, width - 1)}…` : one;
};

function row(r: SearchRow & { guess: string }): string {
  return [r.id, dateAst(r.lastSentAt), compact(r.groups.join(", "), 24), compact(r.senderName ?? "", 16), compact(r.guess, 36), compact(r.originalText, 90)].join(" | ");
}

const root = searchRoot();
try {
  const teach = argValue("teach");
  if (hasFlag("list")) {
    const queue = withSearchStore(root, (s) => s.openQueue(500));
    console.log(`${queue.total} open · id | last seen (AST) | group(s) | sender | best guess | text`);
    for (const r of queue.rows) console.log(row(r));
  } else if (teach) {
    const answer = argValue("answer");
    if (!answer) {
      console.error('Give the one-line answer with --answer "...".');
      process.exit(2);
    }
    const result = withSearchStore(root, (s) =>
      s.teach(
        teach,
        { answer, term: argValue("term"), area: argValue("area"), development: argValue("development"), type: argValue("type"), listingType: argValue("listing-type") },
        "cli",
      ),
    );
    console.log(
      `Saved as ${result.saved}${result.term ? ` (${result.term})` : ""}. ${result.reparsed} stored post(s) read again, ${result.promotedRecords} moved out of the queue. ` +
        (result.promoted ? "This item is clear now." : "This item still needs detail."),
    );
  } else {
    console.error("Usage: learn.ts --list | --teach <id> --answer \"...\" [--term --area --development --type --listing-type]");
    process.exit(2);
  }
} catch (e) {
  if (e instanceof SearchInputError || e instanceof NotInQueueError) {
    console.error(e.message);
    process.exit(2);
  }
  console.error(`learn failed: ${(e as { code?: string }).code ?? (e as Error).name}`);
  process.exit(1);
}
