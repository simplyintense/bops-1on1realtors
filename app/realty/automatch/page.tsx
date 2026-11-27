import type { Metadata } from "next";
import Link from "next/link";
import { askBudgetLabel } from "@/realty/flow/automatch.ts";
import { parseOwnerAgentFilter, type AgentAssignmentCount } from "@/realty/flow/automatch-scope.ts";
import { listingPriceLabel } from "@/realty/flow/live-match.ts";
import { dateAst } from "@/realty/node/group-posts.ts";
import { type AutomatchRow } from "@/realty/node/automatch.ts";
import { staffAutomatchWithLeads } from "@/realty/node/automatch-leads.ts";
import { CARD_PAGE_SIZE, firstParam, hrefWithParams, pageWindow, slicePage, type QueryParams } from "@/realty/flow/pagination.ts";
import { PaginationBar } from "../pagination-bar";
import { Notice } from "../notice";
import { LeadCards } from "../desk/lead-cards";
import { viewer } from "../viewer";

/**
 * 1on1 CRM Automatch: WhatsApp buyer and renter demand (the Supply & Demand store) matched against our active CRM listings,
 * each pair scored 0–100 (realty/flow/automatch.ts). Read only for any signed-in staff member: nothing is sent, and nothing is
 * written to the CRM. The lead cards' follow-up buttons follow the same rules as the desk (leadAccess). The default shows 75
 * and above; ?band=all adds 50 to 74.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Automatch · 1on1 Realtors staff", robots: { index: false, follow: false } };

const beds = (n: number | null) => (n == null ? null : `${n} bed${n === 1 ? "" : "s"}`);

export default async function Automatch({ searchParams }: { searchParams: Promise<QueryParams> }) {
  const { email } = await viewer();
  const raw = await searchParams;
  const showHidden = (Array.isArray(raw.hidden) ? raw.hidden[0] : raw.hidden) === "1";
  const view = await staffAutomatchWithLeads({ email, showHidden, agentFilter: firstParam(raw, "agent") });
  if (!("pairs" in view)) {
    return (
      <main className="mx-auto w-full max-w-6xl px-5 py-10">
        <Notice tone="error">Sign in to see Automatch.</Notice>
      </main>
    );
  }
  const all = (Array.isArray(raw.band) ? raw.band[0] : raw.band) === "all";
  const leads = view.leads;
  const shown = all ? view.pairs : view.pairs.filter((p) => p.band === "strong");
  const leadWindow = pageWindow({ page: raw.leadsPage, pageSize: CARD_PAGE_SIZE, total: leads.cards.length });
  const pairWindow = pageWindow({ page: raw.page, pageSize: CARD_PAGE_SIZE, total: shown.length });
  const leadView = { ...leads, cards: slicePage(leads.cards, leadWindow) };
  const pagePairs = slicePage(shown, pairWindow);
  const hiddenToggle = hrefWithParams("/realty/automatch", raw, { hidden: showHidden ? undefined : "1", leadsPage: undefined });
  const strongHref = hrefWithParams("/realty/automatch", raw, { band: undefined, page: undefined, leadsPage: undefined });
  const allHref = hrefWithParams("/realty/automatch", raw, { band: "all", page: undefined, leadsPage: undefined });
  const agentChips = view.owner ? agentChipsOf(view.agentCounts ?? [], all, parseOwnerAgentFilter(true, firstParam(raw, "agent"))) : null;

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-10">
      <p className="rt-eyebrow">Read only</p>
      <h1 className="mt-2 text-3xl font-semibold">Automatch</h1>
      <p className="rt-muted mt-3">
        {view.owner
          ? "WhatsApp buyer and renter requests matched against our active CRM listings, each pair scored 0–100. Read only: nothing here is sent, and nothing is written to the CRM."
          : "Matches for the listings you hold: WhatsApp buyer and renter requests matched against our active CRM listings, each pair scored 0–100. Read only: nothing here is sent, and nothing is written to the CRM."}
      </p>
      <p className="rt-muted mt-4 text-sm">
        Jump to:{" "}
        <Link href="/realty/digest" className="rt-link">
          Daily digest
        </Link>
        {" · "}
        <Link href="/realty/search" className="rt-link">
          Message Search (WA)
        </Link>
      </p>

      <ul className="mt-6 grid gap-4 md:grid-cols-4">
        <Stat label="Score 75 and above" value={view.strong} />
        <Stat label="Score 50 to 74" value={view.fair} />
        <Stat label="Active CRM listings" value={view.listings} />
        <Stat label="Demand considered" value={view.demand} />
      </ul>

      <nav aria-label="Score bands" className="mt-6 flex flex-wrap gap-2">
        <Link href={strongHref} className="rt-chip" aria-pressed={!all}>
          75 and above
        </Link>
        <Link href={allHref} className="rt-chip" aria-pressed={all}>
          50 and above
        </Link>
      </nav>

      {agentChips ? (
        <nav aria-label="Assigned to agents" className="mt-4 flex flex-wrap gap-2">
          <span className="rt-muted self-center text-sm">Assigned to agents:</span>
          {agentChips.map((c) => (
            <Link key={c.key} href={hrefWithParams("/realty/automatch", raw, { agent: c.value, page: undefined, leadsPage: undefined })} className="rt-chip" aria-pressed={c.active}>
              {c.label} · {c.count}
            </Link>
          ))}
        </nav>
      ) : null}

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
          {view.owner
            ? "Every strong match (75 and above): who asked, the listing and its agent (or the office), a suggested message, and the outcome buttons."
            : "Strong matches (75 and above) on the listings you hold: who asked, the listing, a suggested message, and the outcome buttons."}
        </p>
        <div className="mt-4">
          <LeadCards view={leadView} owner={view.owner} showHidden={showHidden} toggleHref={hiddenToggle} />
          {leadWindow.total ? <PaginationBar path="/realty/automatch" raw={raw} window={leadWindow} param="leadsPage" /> : null}
        </div>
      </section>

      <section className="mt-8" aria-label="Pairs" data-tour="automatch-pairs">
        {pagePairs.length ? (
          <>
            <ol className="grid gap-4">
              {pagePairs.map((r, i) => (
                <PairCard key={`${r.ask.postId ?? "ask"}-${r.listingKey}-${pairWindow.offset + i}`} r={r} />
              ))}
            </ol>
            <PaginationBar path="/realty/automatch" raw={raw} window={pairWindow} />
          </>
        ) : view.crmText ? null : (
          <Notice>
            {view.owner
              ? all
                ? "No pairs at 50 and above right now."
                : "No pairs at 75 and above right now. Try the 50 and above view."
              : all
                ? "No matches at 50 and above for your listings right now."
                : "No matches at 75 and above for your listings right now. Try the 50 and above view."}
          </Notice>
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

/**
 * The owner's agent chips for the current band: All (every agent's count together), then each assigned agent and Unassigned,
 * showing only those with a count in this band (the chip that's on stays even at 0). Counts are strong, or total when all bands.
 */
function agentChipsOf(counts: readonly AgentAssignmentCount[], all: boolean, filter: number | "unassigned" | null) {
  const countOf = (c: AgentAssignmentCount) => (all ? c.total : c.strong);
  const chips = [
    { key: "all", label: "All", value: undefined, count: counts.reduce((n, c) => n + countOf(c), 0), active: filter == null },
    ...counts.map((c) => {
      const active = c.agentId == null ? filter === "unassigned" : filter === c.agentId;
      return { key: c.agentId == null ? "unassigned" : `agent-${c.agentId}`, label: c.name, value: c.agentId == null ? "unassigned" : String(c.agentId), count: countOf(c), active };
    }),
  ];
  return chips.filter((c) => c.key === "all" || c.count > 0 || c.active);
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <li className="rt-card p-4">
      <span className="rt-muted block text-sm">{label}</span>
      <span className="mt-1 block text-3xl font-semibold">{value}</span>
    </li>
  );
}
