import type { ReactNode } from "react";
import type { LiveCard, LiveDesk } from "@/realty/flow/live-match.ts";
import { listingKey, type FollowUp } from "@/realty/flow/match-status.ts";
import { CRM_MISSING_TEXT, type BuyerMatch, type MatchItem, type Recommendations } from "@/realty/flow/recommendations.ts";
import type { DeskView } from "@/realty/node/requests.ts";
import { Notice } from "../notice";
import { ContactBlock, hasContact } from "../contact-block";
import { FollowUpButtons } from "./follow-up-buttons";

/**
 * "Top recommendations for you" on the desk. It renders the view the server built (realty/node/requests.ts DeskView): the
 * signed-in agent's own WhatsApp requests with their live matches (other agencies' listings and ours from the 1on1 CRM),
 * WhatsApp requests that fit listings they hold, other agencies' open requests that fit listings they hold, and, for
 * owners only, the unassigned WhatsApp requests, matches on our listings with no agent, and every open market request. Match reasons and listings, never a score or a grade
 * (the view has none). The owner blocks are rendered only when the view has them, which is only for an owner. Each match on a
 * WhatsApp request has the follow-up buttons (Contacted, Not a fit, Closed), which save to Bops's own record only.
 */

export function RecommendationsPanel({ recs }: { recs: DeskView | null }) {
  if (!recs) return <Notice tone="error">Recommendations couldn&apos;t load right now. The rest of the desk still works.</Notice>;
  return (
    <div className="mt-4 grid gap-8">
      <Block title="Matches for your WhatsApp requests">
        <Yours yours={recs.live.yours} />
      </Block>

      {recs.live.onListings.length ? (
        <Block title="WhatsApp requests that fit your listings">
          <p className="rt-muted text-sm">Requests from the agents&apos; group that match a listing you hold in the 1on1 CRM.</p>
          <Cards cards={recs.live.onListings} oursOnly />
        </Block>
      ) : null}

      <Block title={recs.owner ? "Market requests that fit our listings" : "Market requests that fit your listings"}>
        {recs.crmText ? <Notice tone="warn">{recs.crmText}</Notice> : null}
        {recs.listings.status === "missing" && !recs.crmText ? <Notice tone="warn">{CRM_MISSING_TEXT}</Notice> : null}
        {recs.listings.status === "not-configured" ? <Notice tone="warn">Market search isn&apos;t set up on this server, so requests can&apos;t be checked against listings.</Notice> : null}
        {recs.listings.status === "error" ? <Notice tone="error">Checking requests against our listings failed. Try again in a minute.</Notice> : null}
        {recs.listings.status === "ok" ? (
          recs.listings.items.length ? (
            <MatchList items={recs.listings.items} />
          ) : (
            <Notice>{recs.owner ? "No open market request fits our listings right now." : "No open market request fits a listing you hold right now."}</Notice>
          )
        ) : null}
      </Block>

      {recs.live.unassigned ? (
        <Block title="Unassigned WhatsApp requests">
          <p className="rt-muted text-sm">Owners only. Requests from the agents&apos; group that aren&apos;t tied to one of our agents yet, with their live matches.</p>
          {recs.live.unassigned.length ? <Cards cards={recs.live.unassigned} /> : <Notice>No unassigned WhatsApp requests right now.</Notice>}
        </Block>
      ) : null}

      {recs.live.unheld?.length ? (
        <Block title="Matches on our listings with no agent">
          <p className="rt-muted text-sm">Owners only. WhatsApp requests that fit one of our listings that has no agent assigned in the CRM.</p>
          <Cards cards={recs.live.unheld} oursOnly />
        </Block>
      ) : null}

      {recs.owner ? (
        <Block title="Other agencies' open requests">
          <p className="rt-muted text-sm">Owners only. Live matches for the newest open co-broke requests in the market.</p>
          <BuyerMatches buyers={recs.buyers} />
          {recs.unassigned?.length ? (
            <>
              <h4 className="mt-2 font-medium">Unassigned matches</h4>
              <p className="rt-muted text-sm">Matches nobody is routed to yet. Unassigned matches go to Wendy and Miles.</p>
              <MatchList items={recs.unassigned} />
            </>
          ) : null}
        </Block>
      ) : null}
    </div>
  );
}

function Yours({ yours }: { yours: LiveDesk["yours"] }) {
  if (yours.status === "signed-out") return <Notice>Sign in to see the matches for your requests.</Notice>;
  if (yours.status === "no-agent") {
    return (
      <Notice tone="warn">
        Your sign-in email isn&apos;t on an agent in the 1on1 CRM (or the CRM can&apos;t be reached right now), so your requests&apos; matches can&apos;t show here yet.
      </Notice>
    );
  }
  if (!yours.phoneKnown) {
    return <Notice tone="warn">Your agent record in the 1on1 CRM has no phone number, so your WhatsApp requests can&apos;t be linked to you. Ask the office to add it.</Notice>;
  }
  if (!yours.cards.length) return <Notice>No requests from you in the agents&apos; WhatsApp group yet. Post one there and its matches show here.</Notice>;
  return <Cards cards={yours.cards} />;
}

/**
 * `oursOnly` shows just the matches on our own listings (for a holder, or the owners' "no agent" list). `detail` adds who set
 * each follow-up and when (the digest; the desk shows only the status).
 */
export function Cards({ cards, oursOnly = false, detail = false }: { cards: LiveCard[]; oursOnly?: boolean; detail?: boolean }) {
  return (
    <ul className="grid gap-4">
      {cards.map((c, i) => (
        <li key={`${c.receivedAt}-${i}`} className="rt-card p-4">
          <p className="font-medium">{c.label}</p>
          <p className="rt-muted mt-1 text-xs">
            Posted {portOfSpainTime(c.receivedAt)}
            {oursOnly ? ` · ${count(c.ours.length)} on our listings` : c.status === "matched" ? ` · ${count(c.matches.length + c.ours.length)}` : ` · ${c.statusText}`}
          </p>
          {!oursOnly && c.ours.length ? (
            <div className="mt-3">
              <h4 className="text-sm font-medium">From our listings</h4>
              <MatchList items={c.ours} follow={followOf(c, detail)} />
            </div>
          ) : null}
          {oursOnly ? (
            <div className="mt-3">
              <MatchList items={c.ours} follow={followOf(c, detail)} />
            </div>
          ) : null}
          {!oursOnly && c.status === "matched" && !c.matches.length ? <p className="rt-muted mt-2 text-sm">No listing at other agencies fits this request yet.</p> : null}
          {!oursOnly && c.matches.length ? (
            <div className="mt-3">
              {c.ours.length ? <h4 className="text-sm font-medium">Other agencies</h4> : null}
              <MatchList items={c.matches} follow={followOf(c, detail)} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function followOf(c: LiveCard, detail: boolean): Follow {
  return { requestId: c.requestId, statuses: c.follow, detail };
}

/** The status buttons for a request's matches: the request's id, each listing's current follow-up, and the digest's note. */
type Follow = { requestId: string; statuses: Record<string, FollowUp>; detail: boolean };

function followNote(f: FollowUp | undefined): string | null {
  return f ? `${f.by ?? "Signed in"} · ${portOfSpainTime(f.at)}` : null;
}

function count(n: number): string {
  return `${n} ${n === 1 ? "match" : "matches"}`;
}

/** The time in Port of Spain (AST), e.g. "Nov 13, 9:05 PM AST". */
export function portOfSpainTime(iso: string): string {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "at an unknown time";
  return `${t.toLocaleString("en-US", { timeZone: "America/Port_of_Spain", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} AST`;
}

function BuyerMatches({ buyers }: { buyers: Recommendations["buyers"] }) {
  if (buyers.status === "owners-only") return null;
  if (buyers.status === "not-configured") return <Notice tone="warn">Market search isn&apos;t set up on this server, so live matches can&apos;t run.</Notice>;
  if (buyers.status === "error") {
    return (
      <Notice tone="error">
        {buyers.reason === "timeout" ? "The market search didn't answer in time." : "The market search is unavailable right now."} Try again in a minute.
      </Notice>
    );
  }
  if (buyers.status === "no-requests") return <Notice>No open buyer requests right now, so there&apos;s nothing to match.</Notice>;
  if (!buyers.matches.length) return <Notice>No routed matches for the newest open requests.</Notice>;
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

/** `follow` is set only on a WhatsApp request's matches; the market's own matches (the request feed) have no buttons. */
function MatchList({ items, follow }: { items: (MatchItem | BuyerMatch)[]; follow?: Follow }) {
  return (
    <ul className="grid gap-3">
      {items.map((m, i) => {
        const key = listingKey(m);
        const contact = { ...m, agency: m.agency ?? m.source };
        return (
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
              {[m.area, m.price, m.beds !== null ? `${m.beds} bed` : null, m.listingType, m.propertyClass].filter(Boolean).join(" · ") || "Details not given"}
            </p>
            {m.reason ? <p className="mt-2 text-sm">{m.reason}</p> : null}
            {hasContact(contact) ? <ContactBlock c={contact} listing={{ title: m.title, url: m.url }} /> : null}
            {"forRequest" in m ? <ForRequest r={m.forRequest} /> : null}
            {follow ? (
              <FollowUpButtons
                requestId={follow.requestId}
                listingKey={key}
                current={follow.statuses[key] ?? null}
                note={follow.detail ? followNote(follow.statuses[key]) : null}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ForRequest({ r }: { r: BuyerMatch["forRequest"] }) {
  const parts = [r.intent, r.area, r.budget, r.beds !== null ? `${r.beds}+ beds` : null, r.propertyType].filter(Boolean);
  if (!parts.length) return null;
  return <p className="rt-muted mt-2 text-xs">For a request: {parts.join(" · ")}</p>;
}
