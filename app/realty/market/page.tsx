import type { Metadata } from "next";
import { criteriaFromParams, type DeskArea, type DeskCriteria, type DeskResult } from "@/realty/flow/market-desk.ts";
import { staffMarketSearch } from "@/realty/node/market-desk.ts";
import { staffMarketStrip } from "@/realty/node/market-stats.ts";
import { Notice } from "../notice";
import { ListingTable } from "./listing-table";
import { StatsStrip } from "./stats-strip";

/**
 * Market search for staff: other agencies' listings for an area, with filters (realty/flow/market-desk.ts). Read-only:
 * the form is a GET, the search runs on the server, and the market token never reaches the browser. The same search is
 * at /api/realty/market/search (staff only). Nothing here writes an alias, learns a neighbour, or sends anything.
 * The page sits in the realty layout (the theme, the header and the nav).
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Market search · 1on1 Realtors staff", robots: { index: false, follow: false } };

type Params = Record<string, string | string[] | undefined>;

export default async function MarketSearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (one !== undefined) params.set(k, one);
  }
  const ran = params.size > 0;
  const c = criteriaFromParams(params);
  const [result, strip] = await Promise.all([
    ran ? staffMarketSearch(c) : Promise.resolve(null),
    staffMarketStrip(),
  ]);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <p className="rt-eyebrow">Staff only · read-only</p>
      <h1 className="mt-2 text-3xl font-semibold">Search Full Online Market</h1>
      <p className="rt-muted mt-3">Other agencies&apos; listings from the market. Nothing is saved, sent or written to the CRM.</p>

      {strip ? <StatsStrip listings={strip.listings} areas={strip.areas} /> : null}

      <Filters c={c} />

      <section className="mt-8">
        {!result ? <Notice>Nothing searched yet. Set the filters above and search.</Notice> : <Results result={result} c={c} />}
      </section>
    </main>
  );
}

function Filters({ c }: { c: DeskCriteria }) {
  const field = "rt-field mt-1";
  return (
    <form action="/realty/market" method="get" className="rt-card mt-6 grid gap-4 p-4 sm:grid-cols-2">
      <label className="text-sm font-medium sm:col-span-2">
        Area
        <input name="area" defaultValue={c.area} placeholder="e.g. Westmoorings" className={field} />
        <span className="rt-muted mt-1 block font-normal">Leave empty for all areas. Nicknames resolve to the canonical area.</span>
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="nearby" value="1" defaultChecked={c.nearby} />
        Include nearby areas
      </label>
      <label className="text-sm font-medium">
        Listing type
        <select name="type" defaultValue={c.listingType ?? ""} className={field}>
          <option value="">Sale or rent</option>
          <option value="sale">Sale</option>
          <option value="rent">Rent</option>
        </select>
      </label>
      <label className="text-sm font-medium">
        Property type
        <select name="propertyType" defaultValue={c.propertyType ?? ""} className={field}>
          <option value="">Any type</option>
          <option value="house">House</option>
          <option value="apartment">Apartment</option>
          <option value="townhouse">Townhouse</option>
          <option value="land">Land</option>
          <option value="commercial">Commercial</option>
        </select>
      </label>
      <fieldset className="text-sm font-medium">
        <legend>Beds</legend>
        <div className="mt-1 flex gap-3">
          <input type="number" name="bedsMin" min={0} step={1} placeholder="min" defaultValue={c.bedsMin ?? ""} className={field} />
          <input type="number" name="bedsMax" min={0} step={1} placeholder="max" defaultValue={c.bedsMax ?? ""} className={field} />
        </div>
      </fieldset>
      <fieldset className="text-sm font-medium">
        <legend>Price</legend>
        <div className="mt-1 flex gap-3">
          <input type="number" name="priceMin" min={0} step="any" placeholder="min" defaultValue={c.priceMin ?? ""} className={field} />
          <input type="number" name="priceMax" min={0} step="any" placeholder="max" defaultValue={c.priceMax ?? ""} className={field} />
        </div>
        <label className="rt-muted mt-2 block font-normal">
          Currency
          <select name="currency" defaultValue={c.currency} className={field}>
            <option value="TTD">TTD</option>
            <option value="USD">USD</option>
            <option value="any">Any</option>
          </select>
        </label>
      </fieldset>
      <p className="rt-muted text-xs sm:col-span-2">
        Beds, price (min and max, raw amounts) and property type are sent to the market, which filters before its result limit. The market
        has no currency filter, so the currency choice doesn&apos;t change the search. Nothing is filtered here.
      </p>
      <div className="sm:col-span-2">
        <button type="submit" className="rt-btn">
          Search
        </button>
      </div>
    </form>
  );
}

function Results({ result, c }: { result: DeskResult; c: DeskCriteria }) {
  if (result.status === "not-configured") {
    return (
      <Notice tone="warn">
        Market search is off on this server. It turns on once the server has ONEON1_MARKET_SEARCH_URL and ONEON1_MARKET_SEARCH_TOKEN set
        (whoever runs the server can set them). Until then nothing is searched.
      </Notice>
    );
  }
  if (result.status === "error") {
    const why = result.reason === "timeout" ? "didn't answer in time" : "is unavailable";
    return <Notice tone="error">The market search {why}. Try again in a minute.</Notice>;
  }
  return (
    <>
      <AreaNote area={result.area} nearby={c.nearby} />
      {result.failed > 0 ? (
        <Notice tone="warn">
          {result.failed} of the areas searched didn&apos;t answer, so these results may be incomplete.
        </Notice>
      ) : null}
      {result.listings.length === 0 ? (
        <Notice>No matching listings.</Notice>
      ) : (
        <>
          <p className="rt-muted mb-3 text-sm">
            {result.listings.length} listing{result.listings.length === 1 ? "" : "s"} from the market.
          </p>
          <ListingTable listings={result.listings} />
        </>
      )}
    </>
  );
}

function AreaNote({ area, nearby }: { area: DeskArea | null; nearby: boolean }) {
  if (!area) return <p className="rt-muted mb-4 text-sm">Searched all areas.</p>;
  if (!area.mapped) {
    return <p className="rt-muted mb-4 text-sm">&ldquo;{area.typed}&rdquo; isn&apos;t a known area, so the search used the text as typed.</p>;
  }
  let nearbyText: string;
  if (!area.neighbours.length) nearbyText = "No nearby areas are known for it.";
  else if (nearby) nearbyText = `Including nearby areas: ${area.neighbours.join(", ")}.`;
  else nearbyText = `Nearby areas not included (turn on “Include nearby areas”): ${area.neighbours.join(", ")}.`;
  return (
    <p className="rt-muted mb-4 text-sm">
      &ldquo;{area.typed}&rdquo; is <span className="font-medium">{area.canonical}</span>. {nearbyText}
    </p>
  );
}
