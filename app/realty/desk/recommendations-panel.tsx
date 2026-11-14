import type { ReactNode } from "react";
import { CRM_MISSING_TEXT, type BuyerMatch, type MatchItem, type Recommendations } from "@/realty/flow/recommendations.ts";
import { Notice } from "../notice";

/**
 * "Top recommendations for you" on the desk. It renders the view the flow built (realty/flow/recommendations.ts): match
 * reasons and listings, never a score or a grade (the view has none). Unassigned matches appear only when the view has
 * them, which is only for an owner. Nothing here is sent or written.
 */

export function RecommendationsPanel({ recs }: { recs: Recommendations | null }) {
  if (!recs) return <Notice tone="error">Recommendations couldn&apos;t load right now. The rest of the desk still works.</Notice>;
  return (
    <div className="mt-4 grid gap-8">
      <Block title="Suggested from our listings">
        {recs.listings.status === "missing" ? <Notice tone="warn">{CRM_MISSING_TEXT}</Notice> : null}
        {recs.listings.status === "not-configured" ? <Notice tone="warn">Market search isn&apos;t set up on this server, so requests can&apos;t be checked against listings.</Notice> : null}
        {recs.listings.status === "error" ? <Notice tone="error">Checking requests against our listings failed. Try again in a minute.</Notice> : null}
        {recs.listings.status === "ok" ? (
          recs.listings.items.length ? (
            <MatchList items={recs.listings.items} />
          ) : (
            <Notice>No suggestions from our listings right now.</Notice>
          )
        ) : null}
      </Block>

      <Block title="Live matches for the newest open requests">
        <BuyerMatches buyers={recs.buyers} />
      </Block>

      {recs.unassigned ? (
        <Block title="Unassigned matches">
          <p className="rt-muted text-sm">Matches nobody is routed to yet. Unassigned matches go to Wendy and Miles.</p>
          {recs.unassigned.length ? <MatchList items={recs.unassigned} /> : <Notice>No unassigned matches right now.</Notice>}
        </Block>
      ) : null}
    </div>
  );
}

function BuyerMatches({ buyers }: { buyers: Recommendations["buyers"] }) {
  if (buyers.status === "not-configured") return <Notice tone="warn">Market search isn&apos;t set up on this server, so live matches can&apos;t run.</Notice>;
  if (buyers.status === "error") {
    return (
      <Notice tone="error">
        {buyers.reason === "timeout" ? "The market search didn't answer in time." : "The market search is unavailable right now."} Try again in a minute.
      </Notice>
    );
  }
  if (buyers.status === "no-requests") return <Notice>No open buyer requests right now, so there&apos;s nothing to match.</Notice>;
  if (!buyers.matches.length) return <Notice>No live matches for the newest open requests yet.</Notice>;
  return <MatchList items={buyers.matches} />;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-lg font-semibold">{title}</h3>
      <div className="mt-3 grid gap-3">{children}</div>
    </section>
  );
}

function MatchList({ items }: { items: (MatchItem | BuyerMatch)[] }) {
  return (
    <ul className="grid gap-3">
      {items.map((m, i) => (
        <li key={`${m.url ?? m.title}-${i}`} className="rt-card p-4">
          <p className="font-medium">
            {m.url ? (
              <a href={m.url} target="_blank" rel="noopener noreferrer" className="rt-link">
                {m.title}
              </a>
            ) : (
              m.title
            )}
          </p>
          <p className="rt-muted mt-1 text-sm">
            {[m.area, m.price, m.beds !== null ? `${m.beds} bed` : null, m.source].filter(Boolean).join(" · ") || "Details not given"}
          </p>
          {m.reason ? <p className="mt-2 text-sm">{m.reason}</p> : null}
          {"forRequest" in m ? <ForRequest r={m.forRequest} /> : null}
        </li>
      ))}
    </ul>
  );
}

function ForRequest({ r }: { r: BuyerMatch["forRequest"] }) {
  const parts = [r.intent, r.area, r.budget, r.beds !== null ? `${r.beds}+ beds` : null, r.propertyType].filter(Boolean);
  if (!parts.length) return null;
  return <p className="rt-muted mt-2 text-xs">For a request: {parts.join(" · ")}</p>;
}
