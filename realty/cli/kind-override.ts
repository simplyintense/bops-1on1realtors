import { applyRecordOverride } from "../flow/periskope.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { syncFromJsonl } from "../node/search-store.ts";
import { argValue, hasFlag, searchRoot } from "./search-args.ts";

/**
 * A reversible staff correction of one stored post (side, place, type, shortlet, ignored, parked).
 * Honoured on reparse and search rebuild. Never sends.
 *
 *   node --experimental-strip-types realty/cli/kind-override.ts --id MESSAGE_ID --set supply --reason "..."
 *   node --experimental-strip-types realty/cli/kind-override.ts --id MESSAGE_ID --status ignored --reason "..."
 *   node --experimental-strip-types realty/cli/kind-override.ts --list
 * Counts only are printed (no phones, no text).
 */

const root = searchRoot();
const store = new PeriskopeStore(root);

if (hasFlag("list")) {
  const rows = store.kindOverrides().map((o) => ({
    messageId: o.messageId,
    set: o.set ?? null,
    area: o.area ?? null,
    type: o.type ?? null,
    listingType: o.listingType ?? null,
    status: o.status ?? null,
    priority: o.priority ?? null,
    by: o.by ?? null,
  }));
  console.log(JSON.stringify({ root, overrides: rows.length, rows }, null, 2));
  process.exit(0);
}

const id = argValue("id");
if (!id) {
  console.error("Usage: kind-override.ts --id MESSAGE_ID [--set supply|demand] [--area X] [--type X] [--listing-type sale|rent|shortlet] [--status ignored|parked] [--priority low] [--reason ...] [--by name]");
  process.exit(2);
}

const side = argValue("set");
if (side && side !== "supply" && side !== "demand") {
  console.error("set must be supply or demand.");
  process.exit(2);
}
const status = argValue("status");
if (status && status !== "ignored" && status !== "parked") {
  console.error("status must be ignored or parked.");
  process.exit(2);
}
const listingType = argValue("listing-type") ?? argValue("listingType");
if (listingType && listingType !== "sale" && listingType !== "rent" && listingType !== "shortlet" && listingType !== "short-let") {
  console.error("listing-type must be sale, rent or shortlet.");
  process.exit(2);
}

const post = store.post(id);
if (!post) {
  console.error("No stored post has that id.");
  process.exit(2);
}

const over = store.setKindOverride({
  messageId: id,
  ...(side === "supply" || side === "demand" ? { set: side } : {}),
  ...(argValue("area") ? { area: argValue("area") } : {}),
  ...(argValue("development") ? { development: argValue("development") } : {}),
  ...(argValue("type") ? { type: argValue("type") } : {}),
  ...(listingType === "short-let" || listingType === "shortlet" || listingType === "sale" || listingType === "rent"
    ? { listingType: listingType === "short-let" ? "shortlet" as const : listingType }
    : {}),
  ...(status === "ignored" || status === "parked" ? { status } : {}),
  ...(argValue("priority") === "low" ? { priority: "low" as const } : {}),
  by: argValue("by") ?? "cli",
  reason: argValue("reason") ?? null,
});
const preview = applyRecordOverride(post, over);
store.reprojectObservation(store.posts());
const counts = syncFromJsonl(root, { force: true });
console.log(JSON.stringify({
  root,
  messageId: id,
  set: preview.set ?? null,
  category: preview.category,
  area: preview.area,
  type: preview.type,
  listingType: preview.listingType,
  status: over.status ?? null,
  priority: over.priority ?? null,
  counts: { supply: store.supply().length, demand: store.demand().length, search: counts },
}, null, 2));
