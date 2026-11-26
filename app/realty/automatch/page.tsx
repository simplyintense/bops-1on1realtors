import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { askBudgetLabel } from "@/realty/flow/automatch.ts";
import { listingPriceLabel } from "@/realty/flow/live-match.ts";
import { dateAst } from "@/realty/node/group-posts.ts";
import { staffAutomatch, type AutomatchRow } from "@/realty/node/automatch.ts";
import { staffLeads } from "@/realty/node/automatch-leads.ts";
import { Notice } from "../notice";
import { LeadCards } from "../desk/lead-cards";
import { viewer } from "../viewer";

/**
 * 1on1 CRM Automatch: WhatsApp buyer and renter demand (the Supply & Demand store) matched against our active CRM listings,
 * each pair scored 0–100 (realty/flow/automatch.ts). Owners only: anyone else is sent to the desk before any data is read.
 * Read only: nothing is sent, and nothing is written to the CRM. The default shows 75 and above; ?band=all adds 50 to 74.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "1on1 CRM Automatch · 1on1 Realtors staff", robots: { index: false, follow: false } };

const beds = (n: number | null) => (n == null ? null : `${n} bed${n === 1 ? "" : "s"}`);

export default async function Automatch({ searchParams }: { searchParams: Promise<{ band?: string | string[]; hidden?: string | string[] }> }) {
  const { email } = await viewer();
  const view = await staffAutomatch({ email });
  if (!view.owner) redirect("/realty/desk");
  const raw = await searchParams;
  const all = (Array.isArray(raw.band) ? raw.band[0] : raw.band) === "all";
  const showHidden = (Array.isArray(raw.hidden) ? raw.hidden[0] : raw.hidden) === "1";
  // Never throws out of the page: a failure is the section's error state.
  const leads = await staffLeads({ email, showHidden }).catch(() => null);
  const shown = all ? view.pairs : view.pairs.filter((p) => p.band === "strong");

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-10">
      <p className="rt-eyebrow">Owners only · read-only</p>
      <h1 className="mt-2 text-3xl font-semibold">1on1 CRM Automatch</h1>
      <p className="rt-muted mt-3">
        WhatsApp buyer and renter requests matched against our active CRM listings, each pair scored 0–100. Read only: nothing here is
        sent, and nothing is written to the CRM.
      </p>
      <p className="rt-muted mt-4 text-sm">
        Jump to:{" "}
        <Link href="/realty/digest" className="rt-link">
          Daily digest
        </Link>
        {" · "}
        <Link href="/realty/search" className="rt-link">
          Market Search
        </Link>
      </p>

      <ul className="mt-6 grid gap-4 md:grid-cols-4">
        <Stat label="Score 75 and above" value={view.strong} />
        <Stat label="Score 50 to 74" value={view.fair} />
        <Stat label="Active CRM listings" value={view.listings} />
        <Stat label="Demand considered" value={view.demand} />
      </ul>

      <nav aria-label="Score bands" className="mt-6 flex flex-wrap gap-2">
        <Link href="/realty/automatch" className="rt-chip" aria-pressed={!all}>
          75 and above
        </Link>
        <Link href="/realty/automatch?band=all" className="rt-chip" aria-pressed={all}>
          50 and above
        </Link>
      </nav>

      {view.crmText ? (
        <div className="mt-6">
          <Notice tone="warn">{view.crmText}</Notice>
        </div>
      ) : null}

      <section className="mt-8" aria-labelledby="lead-cards-heading" data-tour="automatch-leads">
        <h2 id="lead-cards-heading" className="text-2xl font-semibold">
          Lead cards
        </h2>
        <p className="rt-muted mt-2 text-sm">
          Every strong match (75 and above): who asked, the listing and its agent (or the office), a suggested message, and the outcome buttons.
        </p>
        <div className="mt-4">
          <LeadCards view={leads} owner showHidden={showHidden} toggleHref={showHidden ? "/realty/automatch" : "/realty/automatch?hidden=1"} />
        </div>
      </section>

      <section className="mt-8" aria-label="Pairs" data-tour="automatch-pairs">
        {shown.length ? (
          <ol className="grid gap-4">
            {shown.map((r, i) => (
              <PairCard key={i} r={r} />
            ))}
          </ol>
        ) : view.crmText ? null : (
          <Notice>{all ? "No pairs at 50 and above right now." : "No pairs at 75 and above right now. Try the 50 and above view."}</Notice>
        )}
      </section>
    </main>
  );
}

function PairCard({ r }: { r: AutomatchRow }) {
  const a = r.ask;
  const l = r.listing;
  const askLine = [a.area, beds(a.beds), a.type].filter(Boolean).join(" · ");
  const listingLine = [l.area, listingPriceLabel(l) ?? "No price listed", beds(l.beds)].filter(Boolean).join(" · ");
  return (
    <li className="rt-card grid gap-4 p-4 md:grid-cols-[1fr_1fr_auto]">
      <div>
        <p className="rt-eyebrow">Asked · {a.listingType === "rent" ? "for rent" : "for sale"}</p>
        <p className="mt-1 font-medium">{askLine}</p>
        <p className="rt-muted text-sm">
          {a.budget != null ? askBudgetLabel(a.budget, a.currency) : "No budget given"} · last seen {dateAst(a.lastSeenAt)}
        </p>
        <p className="rt-muted text-sm">
          From {a.senderName ?? "unnamed"} · {a.senderPhone}
        </p>
        {a.postId ? (
          <Link href={`/realty/posts/${a.postId}`} className="rt-link text-sm">
            Stored post
          </Link>
        ) : null}
      </div>
      <div>
        <p className="rt-eyebrow">Our listing</p>
        <p className="mt-1 font-medium">
          {l.url ? (
            <a href={l.url} className="rt-link" target="_blank" rel="noopener noreferrer">
              {l.title}
            </a>
          ) : (
            l.title
          )}
        </p>
        <p className="rt-muted text-sm">{listingLine}</p>
        <p className="rt-muted text-sm">Agent: {l.agentName ?? "Unassigned → office"}</p>
      </div>
      <div className="md:text-right">
        <p className="text-3xl font-semibold">{r.score}</p>
        <p className="rt-muted text-xs">{r.band === "strong" ? "75 and above" : "50 to 74"}</p>
        <p className="rt-muted text-xs">{r.posts === 1 ? "1 post" : `${r.posts} posts`}</p>
      </div>
      <p className="rt-muted text-sm md:col-span-3">{r.reason}</p>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <li className="rt-card p-4">
      <span className="rt-muted block text-sm">{label}</span>
      <span className="mt-1 block text-3xl font-semibold">{value}</span>
    </li>
  );
}
