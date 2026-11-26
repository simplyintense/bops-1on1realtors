import type { Metadata } from "next";
import Link from "next/link";
import { staffDigest } from "@/realty/node/requests.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";
import { readWebhookStatus, webhookStatusLabel } from "@/realty/node/webhook-status.ts";
import { Cards, portOfSpainTime } from "../desk/recommendations-panel";
import { Notice } from "../notice";
import { viewer } from "../viewer";
import { ReplayButton } from "./replay-button";

/**
 * The daily digest: the last 24 hours of buyer requests from the agents' WhatsApp group (Periskope intake), with every match and
 * its follow-up (who set it, and when). Read only for any signed-in staff member. The sample replay is the owners' (it's a dry
 * run, realty/node/replay.ts), so its button is shown to owners only. The follow-up buttons write Bops's own record and nothing else.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Daily digest · 1on1 Realtors", robots: { index: false, follow: false } };

export default async function RealtyDigest() {
  const { email } = await viewer();
  const view = await staffDigest({ email });
  if (!("digest" in view)) {
    return (
      <main className="mx-auto w-full max-w-5xl px-5 py-10">
        <Notice tone="error">Sign in to see the digest.</Notice>
      </main>
    );
  }
  const d = view.digest;
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <p className="rt-eyebrow">Read only</p>
      <h1 className="mt-2 text-3xl font-semibold">Daily digest</h1>
      <p className="rt-muted mt-3">
        Buyer requests from the agents&apos; WhatsApp group since {portOfSpainTime(d.since)}, matched against other agencies&apos; listings as they arrived. Nothing here
        sends a message.
      </p>

      <p className="rt-muted mt-4 text-sm">
        Jump to:{" "}
        <Link href="/realty/automatch" className="rt-link">
          Automatch
        </Link>
        {" · "}
        <Link href="/realty/search" className="rt-link">
          Message Search (WA)
        </Link>
        {" · "}
        <Link href="/realty/posts" className="rt-link">
          All posts
        </Link>
      </p>
      <p className="rt-muted mt-1 text-sm">{webhookStatusLabel(readWebhookStatus(periskopeRoot()))}</p>

      <ul className="mt-6 grid gap-4 md:grid-cols-4">
        <Stat label="Requests" value={d.requests} />
        <Stat label="With matches" value={d.withMatches} />
        <Stat label="Nothing fits yet" value={d.noMatches} />
        <Stat label="Not matched" value={d.notMatched} />
      </ul>

      {view.crmText ? (
        <div className="mt-6">
          <Notice tone="warn">{view.crmText}</Notice>
        </div>
      ) : null}

      <section className="mt-10" aria-labelledby="digest-requests" data-tour="digest-requests">
        <h2 id="digest-requests" className="text-2xl font-semibold">
          Last 24 hours
        </h2>
        <div className="mt-4">
          {d.cards.length ? (
            <Cards cards={d.cards} detail />
          ) : (
            <Notice>No WhatsApp buyer requests in the last 24 hours. Until the agents&apos; group is connected, the replay below shows it working.</Notice>
          )}
        </div>
      </section>

      {view.owner ? (
        <section className="mt-12" aria-labelledby="digest-replay" data-tour="digest-replay">
          <h2 id="digest-replay" className="text-2xl font-semibold">
            Replay sample messages
          </h2>
          <p className="rt-muted mt-2 mb-4 text-sm">
            A dry run: five made-up group messages go through the real intake (signature check, parsing, matching against the market and our CRM listings) into a throwaway store. Nothing is kept or sent, and the CRM is only read.
          </p>
          <ReplayButton />
        </section>
      ) : null}
    </main>
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
