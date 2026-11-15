import { SearchInputError, searchInputFrom, withSearchStore, type SearchRow } from "../node/search-store.ts";
import { dateAst } from "../node/group-posts.ts";
import { filterParams, hasFlag, searchRoot } from "./search-args.ts";

/**
 * Search the WhatsApp supply, demand and needs-explanation queue. Flags mirror the search fields:
 *   node --experimental-strip-types realty/cli/search.ts --kind supply --area maraval --min-price 1000000 --beds 3
 *   --kind supply|demand|vague  --q TEXT  --area X  --development X  --min-price N  --max-price N  --beds N
 *   --type T  --listing-type sale|rent|shortlet  --agent NAME-or-PHONE  --group NAME  --from YYYY-MM-DD  --to YYYY-MM-DD
 *   --limit N  --offset N  --json  --root DIR
 * Times are AST. Phone numbers and text are printed to this terminal only; nothing is logged.
 */

function compact(s: string | null, width: number): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > width ? `${one.slice(0, width - 1)}…` : one;
}

function line(r: SearchRow): string {
  const place = [r.area, r.development].filter(Boolean).join(" / ");
  const price = r.price == null ? "" : `${r.price}${r.currency ? ` ${r.currency}` : ""}`;
  return [
    dateAst(r.lastSentAt),
    `×${r.timesSeen}`,
    compact(r.groups.join(", "), 28),
    compact(r.senderName ?? "", 18),
    r.senderPhone,
    compact(place, 22),
    r.type ?? "",
    r.listingType ?? "",
    r.beds == null ? "" : `${r.beds}b`,
    price,
    compact(r.originalText, 80),
  ].join(" | ");
}

try {
  const input = searchInputFrom(filterParams());
  const result = withSearchStore(searchRoot(), (store) => store.search(input));
  if (hasFlag("json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.total} ${result.kind} match${result.total === 1 ? "" : "es"} (showing ${result.rows.length} from ${result.offset + 1})`);
    for (const r of result.rows) console.log(line(r));
  }
} catch (e) {
  if (e instanceof SearchInputError) {
    console.error(e.message);
    process.exit(2);
  }
  console.error(`search failed: ${(e as { code?: string }).code ?? (e as Error).name}`);
  process.exit(1);
}
