import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { staffRecommendations } from "@/realty/node/requests.ts";
import { viewer } from "../viewer";
import { RecommendationsPanel } from "./recommendations-panel";

/**
 * The staff desk: the home for signed-in staff. The login gate covers every /realty page, and the public demo redirects
 * them. Shortcuts: market search and the 1on1 CRM's agent portal (on 1on1realtors.com, in a new tab); the buyer requests
 * feed and the daily digest are for owners only (checked on the server, not just hidden). Then the "Top recommendations
 * for you" panel, where matches marked not a fit or closed are hidden unless "Show hidden" is on. Read only: nothing here
 * sends or writes. The Bops chat app at / is unchanged, and so is the post-login redirect.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Staff desk · 1on1 Realtors", robots: { index: false, follow: false } };

type Params = Record<string, string | string[] | undefined>;

export default async function RealtyDesk({ searchParams }: { searchParams: Promise<Params> }) {
  const { email, owner } = await viewer();
  const showHidden = (await searchParams).hidden === "1";
  // Never throws out of the page: a failure is the panel's error state.
  const recs = await staffRecommendations({ email, showHidden }).catch(() => null);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <p className="rt-eyebrow">Staff only</p>
      <h1 className="mt-2 text-3xl font-semibold">1on1 Realtors staff desk</h1>
      <p className="rt-muted mt-3">Tools for the 1on1 Realtors team. Nothing on these pages sends a message or writes to the CRM.</p>

      <ul className={`mt-8 grid gap-4 ${owner ? "md:grid-cols-4" : "md:grid-cols-2"}`}>
        <Tile href="/realty/market" title="Market search" cta="Search the market">
          Other agencies&apos; listings for an area, with filters. Read-only.
        </Tile>
        <Tile href="https://1on1realtors.com/agent/dashboard" external title="1on1 CRM · Agent portal" cta="Open the agent portal">
          The 1on1 Realtors agent portal on 1on1realtors.com. Opens in a new tab.
        </Tile>
        {owner ? (
          <>
            <Tile href="/realty/requests" title="Buyer requests" cta="See the requests">
              Co-broke buyer requests from the WhatsApp and email feed, through the market. Owners only. Read-only.
            </Tile>
            <Tile href="/realty/digest" title="Daily digest" cta="Open the digest">
              Owners only. The last day&apos;s WhatsApp requests and their matches, and a sample replay.
            </Tile>
          </>
        ) : null}
      </ul>

      <section className="mt-12" aria-labelledby="recommendations-heading">
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
  children,
}: {
  href: string;
  title: string;
  cta: string;
  external?: boolean;
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
        <a href={href} target="_blank" rel="noopener noreferrer" className="rt-card rt-tile h-full">
          {body}
        </a>
      ) : (
        <Link href={href} className="rt-card rt-tile h-full">
          {body}
        </Link>
      )}
    </li>
  );
}
