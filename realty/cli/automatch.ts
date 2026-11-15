import { moneyLabel } from "../flow/market-search.ts";
import { listingPriceLabel } from "../flow/live-match.ts";
import { dateAst } from "../node/group-posts.ts";
import { loadAutomatch, type AutomatchRow } from "../node/automatch.ts";
import { searchRoot } from "./search-args.ts";

/**
 * 1on1 CRM Automatch in the terminal: WhatsApp demand against our active CRM listings, the same matching as the owners' page.
 * Read only: nothing is sent and nothing is written to the CRM. Uses the CRM settings in this shell's environment, if any.
 *   npm run realty:automatch                 (the store at .data/realty/periskope)
 *   npm run realty:automatch -- --root DIR   (another store root)
 * Prints the counts and the top five pairs. It never prints a phone number, an email, a token or an env value: the sender of an
 * ask is left out on purpose, and a listing's agent is shown by name only.
 */

const beds = (n: number | null) => (n == null ? "beds not given" : `${n} bed${n === 1 ? "" : "s"}`);

function askLine(r: AutomatchRow): string {
  const a = r.ask;
  const budget = a.budget != null ? moneyLabel(a.budget, a.currency) : "no budget";
  return [a.area, beds(a.beds), budget, a.type ?? "type not given", a.listingType === "rent" ? "rent" : "sale", `last seen ${dateAst(a.lastSeenAt)} AST`].join(" · ");
}

function listingLine(r: AutomatchRow): string {
  const l = r.listing;
  const price = listingPriceLabel(l) ?? "no price listed";
  return [l.title, l.area ?? "area not given", price, beds(l.beds), `agent ${l.agentName ?? "Unassigned → office"}`].join(" · ");
}

async function main(): Promise<void> {
  const result = await loadAutomatch({ root: searchRoot() });
  console.log("1on1 CRM Automatch · read only, nothing sent");
  console.log(`Demand considered: ${result.demand} (asks with a place and sale or rent: ${result.asks})`);
  console.log(`Active CRM listings: ${result.listings}`);
  if (result.crmText) console.log(`CRM: ${result.crmText}`);
  console.log(`Pairs 75 and above: ${result.strong}`);
  console.log(`Pairs 50 to 74: ${result.fair}`);
  if (!result.pairs.length) {
    console.log("No pairs at 50 and above.");
    return;
  }
  console.log("Top 5:");
  result.pairs.slice(0, 5).forEach((r, i) => {
    console.log(`${i + 1}. ${r.score}  ask: ${askLine(r)}`);
    console.log(`     listing: ${listingLine(r)}`);
    if (r.listing.url) console.log(`     link: ${r.listing.url}`);
    console.log(`     why: ${r.reason}`);
  });
}

main().catch((err: unknown) => {
  console.error(`Automatch failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
