import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { GATE_COOKIE, gateConfig, readSession } from "@/lib/gate";
import { staffRecommendations } from "@/realty/node/requests.ts";
import { RecommendationsPanel } from "./recommendations-panel";

/**
 * The staff desk: the home for signed-in staff. The login gate covers every /realty page, and the public demo redirects
 * them. Three shortcuts (market search; the 1on1 CRM's agent portal on 1on1realtors.com, in a new tab; the buyer requests
 * feed), a fourth for owners only (the daily digest), then the "Top recommendations for you" panel. Read only: nothing here
 * sends or writes. The Bops chat app at /
 * is unchanged, and so is the post-login redirect.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Staff desk · 1on1 Realtors", robots: { index: false, follow: false } };

/** The signed-in email from the gate's session, or null (gate off, misconfigured, or signed out). Used for the owner check only; never rendered. */
async function signedInEmail(): Promise<string | null> {
  try {
    const cfg = gateConfig();
    if (!cfg || cfg === "misconfigured") return null;
    return await readSession((await cookies()).get(GATE_COOKIE)?.value, cfg);
  } catch {
    return null;
  }
}

export default async function RealtyDesk() {
  const email = await signedInEmail();
  // Never throws out of the page: a failure is the panel's error state.
  const recs = await staffRecommendations({ email }).catch(() => null);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <p className="rt-eyebrow">Staff only</p>
      <h1 className="mt-2 text-3xl font-semibold">1on1 Realtors staff desk</h1>
      <p className="rt-muted mt-3">Tools for the 1on1 Realtors team. Nothing on these pages sends a message or writes to the CRM.</p>

      <ul className={`mt-8 grid gap-4 ${recs?.owner ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
        <Tile href="/realty/market" title="Market search" cta="Search the market">
          Other agencies&apos; listings for an area, with filters. Read-only.
        </Tile>
        <Tile href="https://1on1realtors.com/agent/dashboard" external title="1on1 CRM · Agent portal" cta="Open the agent portal">
          The 1on1 Realtors agent portal on 1on1realtors.com. Opens in a new tab.
        </Tile>
        <Tile href="/realty/requests" title="Buyer requests" cta="See the requests">
          Co-broke buyer requests from the WhatsApp and email feed, through the market. Read-only.
        </Tile>
        {recs?.owner ? (
          <Tile href="/realty/digest" title="Daily digest" cta="Open the digest">
            Owners only. The last day&apos;s WhatsApp requests and their matches, and a sample replay.
          </Tile>
        ) : null}
      </ul>

      <section className="mt-12" aria-labelledby="recommendations-heading">
        <h2 id="recommendations-heading" className="text-2xl font-semibold">
          Top recommendations for you
        </h2>
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
