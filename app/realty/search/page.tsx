import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { dateAst } from "@/realty/node/group-posts.ts";
import { requestIdOf } from "@/realty/node/periskope-store.ts";
import { SearchInputError, searchInputFrom, withSearchStore, type SearchInput, type SearchRow, type Tab } from "@/realty/node/search-store.ts";
import { viewer } from "../viewer";
import { ExplainForm } from "./explain-form";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Search · 1on1 Realtors staff", robots: { index: false, follow: false } };

type Params = Record<string, string | string[] | undefined>;

const TABS: { tab: Tab; label: string }[] = [
  { tab: "supply", label: "Supply" },
  { tab: "demand", label: "Demand" },
  { tab: "vague", label: "Needs explanation" },
];

/** A link to this page with the same filters and one or more changed. */
function hrefWith(raw: Params, changes: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  const merged: Record<string, string | undefined> = { ...Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), ...changes };
  for (const [k, v] of Object.entries(merged)) {
    if (v) p.set(k, v);
  }
  const qs = p.toString();
  return `/realty/search${qs ? `?${qs}` : ""}`;
}

const money = (r: SearchRow) => (r.price == null ? "" : `${r.price.toLocaleString("en-US")}${r.currency ? ` ${r.currency}` : ""}`);
const snippet = (s: string | null) => {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 159)}…` : one;
};

/**
 * Owners only: search the WhatsApp supply, demand and needs-explanation queue. The filters are a plain GET form. Rows
 * link to the stored post (owners only), and needs-explanation rows take an explanation and an optional alias. Agents
 * never see this page.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { owner } = await viewer();
  if (!owner) redirect("/realty/desk");
  const raw = await searchParams;

  let input: SearchInput = { kind: "supply" };
  let error: string | null = null;
  try {
    input = searchInputFrom(raw);
  } catch (e) {
    if (!(e instanceof SearchInputError)) throw e;
    error = e.message;
  }
  const tab = input.kind ?? "supply";
  const result = error ? null : withSearchStore(periskopeRoot(), (store) => store.search(input));
  const val = (k: string) => {
    const v = raw[k];
    return Array.isArray(v) ? v[0] ?? "" : v ?? "";
  };
  const pageSize = input.limit ?? 100;

  return (
    <main className="mx-auto w-full max-w-7xl px-5 py-10">
      <p className="rt-eyebrow">Owners only · read-only</p>
      <h1 className="mt-2 text-3xl font-semibold">Search WhatsApp supply and demand</h1>
      <p className="rt-muted mt-3">
        Listings and buyer or renter requests from the allowlisted groups, de-duplicated across groups. Posts too vague to
        match wait in Needs explanation. Times are AST.{" "}
        <a className="rt-link" href="/api/realty/search/export">
          Download all tabs (JSON)
        </a>
      </p>

      <nav aria-label="Tabs" className="mt-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link key={t.tab} href={hrefWith(raw, { kind: t.tab, offset: undefined })} className="rt-chip" aria-pressed={tab === t.tab}>
            {t.label}
          </Link>
        ))}
      </nav>

      <form method="get" action="/realty/search" className="mt-6 grid gap-3 sm:grid-cols-4">
        <input type="hidden" name="kind" value={tab} />
        <input name="q" defaultValue={val("q")} placeholder="Keywords" className="rt-field" aria-label="Keywords" />
        <input name="area" defaultValue={val("area")} placeholder="Area" className="rt-field" aria-label="Area" />
        <input name="development" defaultValue={val("development")} placeholder="Development" className="rt-field" aria-label="Development" />
        <input name="agent" defaultValue={val("agent")} placeholder="Agent name or phone" className="rt-field" aria-label="Agent" />
        <input name="minPrice" defaultValue={val("minPrice")} inputMode="numeric" placeholder="Min price" className="rt-field" aria-label="Min price" />
        <input name="maxPrice" defaultValue={val("maxPrice")} inputMode="numeric" placeholder="Max price" className="rt-field" aria-label="Max price" />
        <input name="beds" defaultValue={val("beds")} inputMode="numeric" placeholder="Beds" className="rt-field" aria-label="Beds" />
        <input name="type" defaultValue={val("type")} placeholder="Type (house, apartment…)" className="rt-field" aria-label="Type" />
        <select name="listingType" defaultValue={val("listingType")} className="rt-field" aria-label="Sale or rent">
          <option value="">Sale or rent</option>
          <option value="sale">Sale</option>
          <option value="rent">Rent</option>
        </select>
        <input name="group" defaultValue={val("group")} placeholder="Group" className="rt-field" aria-label="Group" />
        <input name="from" defaultValue={val("from")} placeholder="From YYYY-MM-DD" className="rt-field" aria-label="From date" />
        <input name="to" defaultValue={val("to")} placeholder="To YYYY-MM-DD" className="rt-field" aria-label="To date" />
        <div className="flex gap-2">
          <button type="submit" className="rt-btn">
            Search
          </button>
          <Link href={`/realty/search?kind=${tab}`} className="rt-chip self-center">
            Clear
          </Link>
        </div>
      </form>

      {error ? <p className="rt-notice rt-notice-error mt-6">{error}</p> : null}

      {result ? (
        <>
          <p className="rt-muted mt-6 text-sm">
            {result.total} match{result.total === 1 ? "" : "es"}
            {result.total ? ` · showing ${result.offset + 1}–${Math.min(result.offset + result.rows.length, result.total)}` : ""}
          </p>
          <div className="rt-table-wrap mt-3">
            <table className="w-full text-sm">
              <thead className="rt-thead text-left">
                <tr>
                  <th className="px-2 py-2">Last seen</th>
                  <th className="px-2 py-2">Seen</th>
                  <th className="px-2 py-2">Group(s)</th>
                  <th className="px-2 py-2">Sender</th>
                  <th className="px-2 py-2">Phone</th>
                  <th className="px-2 py-2">Area / development</th>
                  <th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2">Sale / rent</th>
                  <th className="px-2 py-2">Beds</th>
                  <th className="px-2 py-2">Price</th>
                  <th className="px-2 py-2">Text</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <ResultRows key={r.id} r={r} tab={tab} />
                ))}
              </tbody>
            </table>
          </div>
          {result.total > result.offset + result.rows.length || result.offset > 0 ? (
            <nav aria-label="Pages" className="mt-4 flex gap-3 text-sm">
              {result.offset > 0 ? <Link className="rt-link" href={hrefWith(raw, { offset: String(Math.max(0, result.offset - pageSize)) })}>Previous</Link> : null}
              {result.total > result.offset + result.rows.length ? <Link className="rt-link" href={hrefWith(raw, { offset: String(result.offset + pageSize) })}>Next</Link> : null}
            </nav>
          ) : null}
        </>
      ) : null}
    </main>
  );
}

function ResultRows({ r, tab }: { r: SearchRow; tab: Tab }) {
  const place = [r.area, r.development].filter(Boolean).join(" / ");
  const post = r.messageIds[0] ? `/realty/posts/${requestIdOf(r.messageIds[0])}` : null;
  return (
    <>
      <tr className="rt-row align-top">
        <td className="px-2 py-2 whitespace-nowrap">{dateAst(r.lastSentAt)}</td>
        <td className="px-2 py-2">×{r.timesSeen}</td>
        <td className="px-2 py-2">{r.groups.join(", ")}</td>
        <td className="px-2 py-2">{r.senderName ?? ""}</td>
        <td className="px-2 py-2 whitespace-nowrap">{r.senderPhone}</td>
        <td className="px-2 py-2">{place}</td>
        <td className="px-2 py-2">{r.type ?? ""}</td>
        <td className="px-2 py-2">{r.listingType ?? ""}</td>
        <td className="px-2 py-2">{r.beds ?? ""}</td>
        <td className="px-2 py-2 whitespace-nowrap">{money(r)}</td>
        <td className="px-2 py-2">
          {post ? (
            <Link href={post} className="rt-link">
              {snippet(r.originalText)}
            </Link>
          ) : (
            snippet(r.originalText)
          )}
        </td>
      </tr>
      {tab === "vague" ? (
        <tr className="rt-row">
          <td colSpan={11} className="px-2">
            {r.explanation ? <p className="rt-muted py-1 text-xs">Explained {r.explainedAt ? dateAst(r.explainedAt) : ""}: {r.explanation}</p> : null}
            <ExplainForm id={r.id} />
          </td>
        </tr>
      ) : r.explanation ? (
        <tr className="rt-row">
          <td colSpan={11} className="px-2">
            <p className="rt-muted py-1 text-xs">Explained {r.explainedAt ? dateAst(r.explainedAt) : ""}: {r.explanation}</p>
          </td>
        </tr>
      ) : null}
    </>
  );
}
