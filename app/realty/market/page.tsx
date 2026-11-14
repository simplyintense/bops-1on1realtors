import type { Metadata } from "next";
import type { ReactNode } from "react";
import { criteriaFromParams, type DeskArea, type DeskCriteria, type DeskResult } from "@/realty/flow/market-desk.ts";
import type { CoBrokeHit } from "@/realty/flow/market-search.ts";
import { staffMarketSearch } from "@/realty/node/market-desk.ts";
import { StaffNav } from "../staff-nav";

/**
 * Market search for staff: other agencies' listings for an area, with filters (realty/flow/market-desk.ts). Read-only:
 * the form is a GET, the search runs on the server, and the market token never reaches the browser. The same search is
 * at /api/realty/market/search (staff only). Nothing here writes an alias, learns a neighbour, or sends anything.
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
  const result = ran ? await staffMarketSearch(c) : null;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10 text-neutral-900">
      <StaffNav current="market" />
      <p className="mt-8 text-xs font-semibold uppercase tracking-wider text-amber-700">Staff only · read-only</p>
      <h1 className="mt-2 text-3xl font-semibold">Market search</h1>
      <p className="mt-3 text-neutral-600">
        Other agencies&apos; listings from the market. Nothing is saved, sent or written to the CRM.
      </p>

      <Filters c={c} />

      <section className="mt-8">
        {!result ? <Notice>Nothing searched yet. Set the filters above and search.</Notice> : <Results result={result} c={c} />}
      </section>
    </main>
  );
}

function Filters({ c }: { c: DeskCriteria }) {
  const field = "mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm";
  return (
    <form action="/realty/market" method="get" className="mt-6 grid gap-4 rounded-lg border border-neutral-200 p-4 sm:grid-cols-2">
      <label className="text-sm font-medium sm:col-span-2">
        Area
        <input name="area" defaultValue={c.area} placeholder="e.g. Westmoorings" className={field} />
        <span className="mt-1 block font-normal text-neutral-500">Leave empty for all areas. Nicknames resolve to the canonical area.</span>
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="nearby" value="1" defaultChecked={c.nearby} />
        Include nearby areas (the area&apos;s neighbours, de-duplicated)
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
        <label className="mt-2 block font-normal text-neutral-500">
          Currency
          <select name="currency" defaultValue={c.currency} className={field}>
            <option value="TTD">TTD</option>
            <option value="USD">USD</option>
            <option value="any">Any</option>
          </select>
        </label>
      </fieldset>
      <p className="text-xs text-neutral-500 sm:col-span-2">
        Beds, price (min and max, raw amounts) and property type are sent to the market, which filters before its result limit. The market
        has no currency filter, so the currency choice doesn&apos;t change the search. Nothing is filtered here.
      </p>
      <div className="sm:col-span-2">
        <button type="submit" className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-700">
          Search
        </button>
      </div>
    </form>
  );
}

function Results({ result, c }: { result: DeskResult; c: DeskCriteria }) {
  if (result.status === "not-configured") {
    return (
      <Notice tone="amber">
        Market search is off on this server. It turns on once the server has ONEON1_MARKET_SEARCH_URL and ONEON1_MARKET_SEARCH_TOKEN set
        (whoever runs the server can set them). Until then nothing is searched.
      </Notice>
    );
  }
  if (result.status === "error") {
    const why = result.reason === "timeout" ? "didn't answer in time" : "is unavailable";
    return <Notice tone="red">The market search {why}. Try again in a minute.</Notice>;
  }
  return (
    <>
      <AreaNote area={result.area} nearby={c.nearby} />
      {result.failed > 0 ? (
        <Notice tone="amber">
          {result.failed} of the areas searched didn&apos;t answer, so these results may be incomplete.
        </Notice>
      ) : null}
      {result.listings.length === 0 ? (
        <Notice>No matching listings.</Notice>
      ) : (
        <>
          <p className="mb-3 text-sm text-neutral-600">
            {result.listings.length} listing{result.listings.length === 1 ? "" : "s"} from the market.
          </p>
          <div className="overflow-x-auto rounded-lg border border-neutral-200">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Title</th>
                  <th className="px-3 py-2 font-semibold">Property type</th>
                  <th className="px-3 py-2 font-semibold">Agency</th>
                  <th className="px-3 py-2 font-semibold">Area</th>
                  <th className="px-3 py-2 font-semibold">Beds</th>
                  <th className="px-3 py-2 font-semibold">Baths</th>
                  <th className="px-3 py-2 font-semibold">Price</th>
                  <th className="px-3 py-2 font-semibold">Last seen</th>
                  <th className="px-3 py-2 font-semibold">Listing</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {result.listings.map((h, i) => (
                  <Row key={`${h.url ?? h.title}-${i}`} h={h} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function Row({ h }: { h: CoBrokeHit }) {
  const price = h.price === null ? "—" : `${h.price.toLocaleString("en-US")}${h.currency ? ` ${h.currency}` : ""}`;
  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        {h.title}
        {h.listingType ? <span className="block text-xs text-neutral-500">{h.listingType}</span> : null}
      </td>
      <td className="px-3 py-2 text-neutral-600">{h.propertyClass ?? "—"}</td>
      <td className="px-3 py-2 text-neutral-600">{h.source}</td>
      <td className="px-3 py-2 text-neutral-600">{h.area ?? "—"}</td>
      <td className="px-3 py-2">{h.beds ?? "—"}</td>
      <td className="px-3 py-2">{h.baths ?? "—"}</td>
      <td className="whitespace-nowrap px-3 py-2">{price}</td>
      <td className="whitespace-nowrap px-3 py-2 text-neutral-600">{h.lastSeen ?? "—"}</td>
      <td className="px-3 py-2">
        {h.url ? (
          <a href={h.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">
            Open
          </a>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}

function AreaNote({ area, nearby }: { area: DeskArea | null; nearby: boolean }) {
  if (!area) return <p className="mb-4 text-sm text-neutral-600">Searched all areas.</p>;
  if (!area.mapped) {
    return <p className="mb-4 text-sm text-neutral-600">&ldquo;{area.typed}&rdquo; isn&apos;t a known area, so the search used the text as typed.</p>;
  }
  const extra = area.searched.slice(1);
  let nearbyText: string;
  if (!area.neighbours.length) nearbyText = "No nearby areas are known for it.";
  else if (nearby) nearbyText = extra.length ? `Searched nearby: ${extra.join(", ")}.` : "Nearby areas were already covered.";
  else nearbyText = `Nearby areas not searched (turn on “Include nearby areas”): ${area.neighbours.join(", ")}.`;
  return (
    <p className="mb-4 text-sm text-neutral-600">
      &ldquo;{area.typed}&rdquo; is <span className="font-medium text-neutral-900">{area.canonical}</span>. {nearbyText}
    </p>
  );
}

function Notice({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "amber" | "red" }) {
  const box = { neutral: "border-neutral-200 bg-neutral-50 text-neutral-700", amber: "border-amber-300 bg-amber-50 text-amber-900", red: "border-red-300 bg-red-50 text-red-900" }[tone];
  return <p className={`rounded-lg border px-4 py-3 text-sm ${box}`}>{children}</p>;
}
