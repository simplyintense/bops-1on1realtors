import type { Metadata } from "next";
import { cookies } from "next/headers";
import { GATE_COOKIE, gateConfig, readSession } from "@/lib/gate";
import { staffDigest } from "@/realty/node/requests.ts";
import { Cards, portOfSpainTime } from "../desk/recommendations-panel";
import { Notice } from "../notice";
import { ReplayButton } from "./replay-button";

/**
 * The owners' daily digest: the last 24 hours of buyer requests from the agents' WhatsApp group (Periskope intake), with
 * their live matches, and the sample replay. Owners only (BOPS_OWNER_EMAILS); anyone else gets a notice and no data. Read
 * only: nothing here sends a message or writes to the CRM. The replay is a dry run (realty/node/replay.ts).
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Daily digest · 1on1 Realtors", robots: { index: false, follow: false } };

async function signedInEmail(): Promise<string | null> {
  try {
    const cfg = gateConfig();
    if (!cfg || cfg === "misconfigured") return null;
    return await readSession((await cookies()).get(GATE_COOKIE)?.value, cfg);
  } catch {
    return null;
  }
}

export default async function RealtyDigest() {
  const view = await staffDigest({ email: await signedInEmail() });
  if (!view.owner) {
    return (
      <main className="mx-auto w-full max-w-5xl px-5 py-10">
        <h1 className="text-3xl font-semibold">Daily digest</h1>
        <div className="mt-6">
          <Notice>The daily digest is for the owners. Your own requests&apos; matches are on the desk.</Notice>
        </div>
      </main>
    );
  }
  const d = view.digest;
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <p className="rt-eyebrow">Owners only</p>
      <h1 className="mt-2 text-3xl font-semibold">Daily digest</h1>
      <p className="rt-muted mt-3">
        Buyer requests from the agents&apos; WhatsApp group since {portOfSpainTime(d.since)}, matched against other agencies&apos; listings as they arrived. Nothing here
        sends a message.
      </p>

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

      <section className="mt-10" aria-labelledby="digest-requests">
        <h2 id="digest-requests" className="text-2xl font-semibold">
          Last 24 hours
        </h2>
        <div className="mt-4">
          {d.cards.length ? (
            <Cards cards={d.cards} />
          ) : (
            <Notice>No WhatsApp buyer requests in the last 24 hours. Until the agents&apos; group is connected, the replay below shows it working.</Notice>
          )}
        </div>
      </section>

      <section className="mt-12" aria-labelledby="digest-replay">
        <h2 id="digest-replay" className="text-2xl font-semibold">
          Replay sample messages
        </h2>
        <p className="rt-muted mt-2 mb-4 text-sm">
          A dry run: five made-up group messages go through the real intake (signature check, parsing, matching against the market and our CRM listings) into a throwaway store. Nothing is kept or sent, and the CRM is only read.
        </p>
        <ReplayButton />
      </section>
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
