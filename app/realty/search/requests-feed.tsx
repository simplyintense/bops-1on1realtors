import { budgetLabel, REQUEST_LIMIT, STATUSES, sortRequests, type BuyerRequest, type RequestCriteria, type RequestsResult, type Sort, type SortKey } from "@/realty/flow/requests.ts";
import { Notice } from "../notice";

/**
 * The online feed on Supply & Demand (?source=online): co-broke buyer requests from the market's search_market_requests
 * (realty/flow/requests.ts). The page runs the search on the server and passes the result here; sorting is done here on
 * the rows the market returned (up to 20, newest first from the market). The form is a GET back to /realty/search. Buyers'
 * names, phone numbers and message details are never read into a row, so they are never shown.
 */
export function RequestsFeed({ c, sort, params, result }: { c: RequestCriteria; sort: Sort; params: URLSearchParams; result: RequestsResult }) {
  return (
    <>
      <Filters c={c} sort={sort} />
      <section className="mt-8">
        <Results result={result} params={params} sort={sort} />
      </section>
    </>
  );
}

function Filters({ c, sort }: { c: RequestCriteria; sort: Sort }) {
  const field = "rt-field mt-1";
  return (
    <form action="/realty/search" method="get" className="rt-card mt-6 grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <input type="hidden" name="source" value="online" />
      <input type="hidden" name="sort" value={sort.key} />
      <input type="hidden" name="dir" value={sort.dir} />
      <label className="text-sm font-medium">
        Search
        <input name="q" defaultValue={c.query} placeholder="Any words in the request" className={field} />
      </label>
      <label className="text-sm font-medium">
        Area
        <input name="area" defaultValue={c.area} placeholder="e.g. Maraval" className={field} />
      </label>
      <label className="text-sm font-medium">
        Intent
        <select name="intent" defaultValue={c.intent ?? ""} className={field}>
          <option value="">Buy or rent</option>
          <option value="buy">Buy</option>
          <option value="rent">Rent</option>
        </select>
      </label>
      <label className="text-sm font-medium">
        Status
        <select name="status" defaultValue={c.status} className={field}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "open" ? "Open" : s === "any" ? "Any status" : s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="text-sm font-medium">
        <legend>Budget</legend>
        <div className="mt-1 flex gap-3">
          <input type="number" name="priceMin" min={0} step="any" placeholder="min" defaultValue={c.priceMin ?? ""} className={field} />
          <input type="number" name="priceMax" min={0} step="any" placeholder="max" defaultValue={c.priceMax ?? ""} className={field} />
        </div>
      </fieldset>
      <label className="text-sm font-medium">
        Beds (at least)
        <input type="number" name="bedsMin" min={0} step={1} defaultValue={c.bedsMin ?? ""} className={field} />
      </label>
      <div className="flex items-end">
        <button type="submit" className="rt-btn">
          Apply
        </button>
      </div>
      <p className="rt-muted text-xs sm:col-span-2 lg:col-span-4">
        Budgets are raw amounts, as the market compares them (TTD and USD are not converted). Every filter goes to the market before its limit.
      </p>
    </form>
  );
}

function Results({ result, params, sort }: { result: RequestsResult; params: URLSearchParams; sort: Sort }) {
  if (result.status === "owners-only") return <Notice>The buyer requests are for the owners.</Notice>;
  if (result.status === "not-configured") {
    return <Notice tone="warn">Online search isn&apos;t set up on this server, so buyer requests can&apos;t be loaded. Whoever runs the server can set it up.</Notice>;
  }
  if (result.status === "error") {
    return (
      <Notice tone="error">
        {result.reason === "timeout" ? "The market didn't answer in time." : "The market is unavailable right now."} Try again in a minute.
      </Notice>
    );
  }
  const rows = sortRequests(result.rows, sort);
  if (!rows.length) {
    return <Notice>There are no matching buyer requests right now. The WhatsApp and co-broke feed comes through the market, and none match these filters.</Notice>;
  }
  return (
    <>
      <p className="rt-muted mb-3 text-sm">
        {rows.length} request{rows.length === 1 ? "" : "s"} from the market. The market returns up to {REQUEST_LIMIT} at a time, so sorting only reorders these.
      </p>
      <div className="rt-table-wrap">
        <table className="min-w-full text-left text-sm">
          <thead className="rt-thead text-xs uppercase tracking-wider">
            <tr>
              <SortHeader label="Received" k="date" params={params} sort={sort} />
              <SortHeader label="Area" k="area" params={params} sort={sort} />
              <SortHeader label="Budget" k="budget" params={params} sort={sort} />
              <SortHeader label="Beds" k="beds" params={params} sort={sort} />
              <th scope="col" className="px-3 py-2 font-semibold">Intent</th>
              <th scope="col" className="px-3 py-2 font-semibold">Type</th>
              <th scope="col" className="px-3 py-2 font-semibold">Status</th>
              <th scope="col" className="px-3 py-2 font-semibold">Agency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Row key={`${r.ref ?? "row"}-${i}`} r={r} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Row({ r }: { r: BuyerRequest }) {
  return (
    <tr className="rt-row align-top">
      <td className="whitespace-nowrap px-3 py-2">{dateLabel(r.receivedAt)}</td>
      <td className="px-3 py-2">{r.area ?? "—"}</td>
      <td className="whitespace-nowrap px-3 py-2">{budgetLabel(r) ?? "—"}</td>
      <td className="px-3 py-2">{r.bedsMin ?? "—"}</td>
      <td className="px-3 py-2">{r.intent ?? "—"}</td>
      <td className="px-3 py-2">{r.propertyType ?? "—"}</td>
      <td className="px-3 py-2">{r.status ?? "—"}</td>
      <td className="px-3 py-2">{r.agency ?? "—"}</td>
    </tr>
  );
}

function SortHeader({ label, k, params, sort }: { label: string; k: SortKey; params: URLSearchParams; sort: Sort }) {
  const active = sort.key === k;
  const dir = active ? (sort.dir === "asc" ? "desc" : "asc") : k === "date" ? "desc" : "asc";
  const q = new URLSearchParams(params);
  q.set("sort", k);
  q.set("dir", dir);
  return (
    <th scope="col" className="px-3 py-2 font-semibold" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <a href={`/realty/search?${q}`} className="rt-th-link">
        {label}
        {active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
      </a>
    </th>
  );
}

/** The date in Port of Spain, day first (the desk's local day). */
function dateLabel(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: "America/Port_of_Spain", day: "numeric", month: "short", year: "numeric" });
}
