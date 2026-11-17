import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { staffRecommendations } from "@/realty/node/requests.ts";
import { staffLeads } from "@/realty/node/automatch-leads.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";
import { readWebhookStatus, webhookStatusLabel } from "@/realty/node/webhook-status.ts";
import { viewer } from "../viewer";
import { LeadCards } from "./lead-cards";
import { RecommendationsPanel } from "./recommendations-panel";
import { leadsSectionCopy, showFeedStatus } from "./copy";

/**
 * The staff desk: the home for signed-in staff. The login gate covers every /realty page, and the public demo redirects
 * them. Shortcuts: online search and the 1on1 CRM's agent portal (on 1on1realtors.com, in a new tab) for everyone; for owners
 * only (checked on the server, not just hidden), 1on1 CRM Automatch, Supply & Demand, All posts and the daily digest. Then "Automatch leads" (strong matches on the listings you hold; every card for an owner), then the "Top recommendations
 * for you" panel, where matches marked not a fit or closed are hidden unless "Show hidden" is on. Read only: nothing here
 * sends or writes. This is the landing page after sign-in (lib/gate.ts safeNext); the Bops chat app at / is one click away
 * in the nav ("Bops home").
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Staff desk · 1on1 Realtors", robots: { index: false, follow: false } };

type Params = Record<string, string | string[] | undefined>;

export default async function RealtyDesk({ searchParams }: { searchParams: Promise<Params> }) {
  const { email, owner } = await viewer();
  const showHidden = (await searchParams).hidden === "1";
  // Never throws out of the page: a failure is the panel's error state.
  const recs = await staffRecommendations({ email, showHidden }).catch(() => null);
  const leads = await staffLeads({ email, showHidden }).catch(() => null);
  const feedStatus = showFeedStatus(owner) ? webhookStatusLabel(readWebhookStatus(periskopeRoot())) : null;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <p className="rt-eyebrow">Staff only</p>
      <h1 className="mt-2 text-3xl font-semibold">1on1 Realtors staff desk</h1>
      <p className="rt-muted mt-3">Tools for the 1on1 Realtors team. Nothing on these pages sends a message or writes to the CRM.</p>
      {feedStatus ? <p className="rt-muted mt-1 text-sm">{feedStatus}</p> : null}

      <ul className={`mt-8 grid gap-4 ${owner ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        <Tile href="/realty/market" title="Online search" cta="Search online" tour="desk-search">
          Other agencies&apos; listings for an area, with filters. Read-only.
        </Tile>
        <Tile href="https://1on1realtors.com/agent/dashboard" external title="1on1 CRM · Agent portal" cta="Open the agent portal" tour="desk-portal">
          The 1on1 Realtors agent portal on 1on1realtors.com. Opens in a new tab.
        </Tile>
        {owner ? (
          <>
            <Tile href="/realty/automatch" title="1on1 CRM Automatch" cta="Open Automatch">
              Owners only. Buyer requests matched against the 1on1 CRM.
            </Tile>
            <Tile href="/realty/search" title="Supply & Demand" cta="Open Supply & Demand">
              Owners only. The WhatsApp supply and demand, and the online buyer-request feed. Read-only.
            </Tile>
            <Tile href="/realty/posts" title="All posts" cta="See all posts">
              Owners only. Stored WhatsApp group posts, with the original text next to what the desk parsed.
            </Tile>
            <Tile href="/realty/digest" title="Daily digest" cta="Open the digest">
              Owners only. The last day&apos;s WhatsApp requests and their matches, and a sample replay.
            </Tile>
          </>
        ) : null}
      </ul>

      <section className="mt-12" aria-labelledby="leads-heading" data-tour="desk-leads">
        <h2 id="leads-heading" className="text-2xl font-semibold">
          Automatch leads
        </h2>
        <p className="rt-muted mt-2 text-sm">
          {leadsSectionCopy(owner)}
        </p>
        <div className="mt-4">
          <LeadCards view={leads} owner={owner} showHidden={showHidden} toggleHref={showHidden ? "/realty/desk" : "/realty/desk?hidden=1"} />
        </div>
      </section>

      <section className="mt-12" aria-labelledby="recommendations-heading" data-tour="desk-recs">
        <h2 id="recommendations-heading" className="text-2xl font-semibold">
          Top recommendations for you
        </h2>
        <p className="rt-muted mt-2 text-sm">
          {showHidden ? "Showing matches marked not a fit or closed. " : "Matches marked not a fit or closed are hidden. "}
          <Link href={showHidden ? "/realty/desk" : "/realty/desk?hidden=1"} className="rt-link">
            {showHidden ? "Hide them" : "Show hidden"}
          </Link>
        </p>
        <RecommendationsPanel recs={recs} />
      </section>
    </main>
  );
}

function Tile({
  href,
  title,
  cta,
  external,
  tour,
  children,
}: {
  href: string;
  title: string;
  cta: string;
  external?: boolean;
  /** The guided tour's spotlight id, when the tour points at this tile. */
  tour?: string;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className="rt-tile-title">{title}</span>
      <span className="rt-muted mt-2 block text-sm">{children}</span>
      <span className="rt-tile-cta mt-4 block">{cta} {external ? "↗" : "→"}</span>
    </>
  );
  return (
    <li>
      {external ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="rt-card rt-tile h-full" data-tour={tour}>
          {body}
        </a>
      ) : (
        <Link href={href} className="rt-card rt-tile h-full" data-tour={tour}>
          {body}
        </Link>
      )}
    </li>
  );
}
