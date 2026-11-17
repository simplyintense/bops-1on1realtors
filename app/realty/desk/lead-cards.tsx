import { leadCardId, type LeadCardView, type LeadsView } from "@/realty/flow/automatch-leads.ts";
import { phoneLabel, telHref } from "@/realty/flow/listing-contact.ts";
import { REASON_LABEL } from "@/realty/flow/match-status.ts";
import { dateAst } from "@/realty/node/group-posts.ts";
import { Notice } from "../notice";
import { FollowUpButtons } from "./follow-up-buttons";
import { leadLabel } from "./copy";

/**
 * Automatch lead cards (realty/flow/automatch-leads.ts): one per strong match (75 and above) that this person may see. Shared by
 * the desk (an agent's own listings, or every card for an owner) and /realty/automatch. Each card carries the ask, who asked (name,
 * firm and number as the store has them), why it fits, the 1on1 listing, a suggested opening message from Miles, an "Open in
 * WhatsApp" link (a plain anchor, opened in the agent's own browser; nothing is sent from here), and the outcome buttons (saved to
 * Bops's own record only), with an optional reason and note once an outcome is set. A card with no outcome two hours after its
 * match is labelled Stale.
 *
 * Each card has an id (leadCardId), so a link to /realty/desk#<id> (the admin digest's feedback links) opens the page at that card:
 * the browser scrolls to it natively, and scroll-margin keeps it clear of the top bar.
 */

export function LeadCards({ view, owner, showHidden, toggleHref, error }: { view: LeadsView | null; owner: boolean; showHidden: boolean; toggleHref: string; error?: string }) {
  if (!view) return <Notice tone="error">{error ?? "Lead cards couldn't load right now. The rest of the page still works."}</Notice>;
  return (
    <div className="grid gap-3">
      <p className="rt-muted text-sm">
        {showHidden ? "Showing cards marked not a fit or closed. " : view.hidden ? `${view.hidden} marked not a fit or closed are hidden. ` : ""}
        <a href={toggleHref} className="rt-link">
          {showHidden ? "Hide them" : "Show hidden"}
        </a>
      </p>
      {view.cards.length ? (
        <ol className="grid gap-4">
          {view.cards.map((c) => (
            <LeadCard key={`${c.requestId}-${c.listingKey}`} c={c} owner={owner} />
          ))}
        </ol>
      ) : (
        <Notice>No lead cards right now.</Notice>
      )}
    </div>
  );
}

function LeadCard({ c, owner }: { c: LeadCardView; owner: boolean }) {
  return (
    <li id={leadCardId(c.requestId, c.listingKey)} className="rt-card grid scroll-mt-24 gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rt-eyebrow">{leadLabel(owner, c.score)}</span>
        {c.stale ? <span className="rt-chip" aria-label="No outcome two hours after the match">Stale</span> : null}
        <span className="rt-muted text-xs">Matched {dateAst(c.matchedAt)}</span>
      </div>

      <p className="font-medium">{c.ask}</p>

      <p className="rt-muted text-sm">
        From {c.sender.name ?? "unnamed"}
        {c.sender.firm ? ` · ${c.sender.firm}` : ""}
        {c.sender.phone ? ` · ${c.sender.phone}` : ""}
      </p>

      <div>
        <p className="text-sm">
          <span className="rt-muted">Our listing: </span>
          {c.listing.url ? (
            <a href={c.listing.url} className="rt-link" target="_blank" rel="noopener noreferrer">
              {c.listing.title}
            </a>
          ) : (
            c.listing.title
          )}
          {c.listing.price ? ` · ${c.listing.price}` : ""}
        </p>
        <p className="rt-muted text-sm">Agent: {c.listing.agent}</p>
      </div>

      {c.reason ? <p className="text-sm">{c.reason}</p> : null}

      <div>
        <p className="rt-eyebrow">Suggested opening message</p>
        <p className="mt-1 whitespace-pre-line text-sm">{c.message}</p>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {telHref(c.sender.phone) && phoneLabel(c.sender.phone) ? (
            <a href={telHref(c.sender.phone) ?? undefined} className="rt-link">
              Call {phoneLabel(c.sender.phone)}
            </a>
          ) : null}
          {c.waUrl ? (
            <a href={c.waUrl} target="_blank" rel="noopener" className="rt-link">
              Open in WhatsApp
            </a>
          ) : (
            <span className="rt-muted">No usable WhatsApp number on this ask, so there&apos;s no link.</span>
          )}
        </p>
      </div>

      <FollowUpButtons requestId={c.requestId} listingKey={c.listingKey} current={c.follow} feedback note={c.follow ? `${c.follow.by ?? "Signed in"} · ${dateAst(c.follow.at)}` : null} />
      {c.follow?.reason || c.follow?.note ? (
        <p className="rt-muted text-xs">
          {c.follow.reason ? `Reason: ${REASON_LABEL[c.follow.reason]}` : ""}
          {c.follow.reason && c.follow.note ? " · " : ""}
          {c.follow.note ?? ""}
        </p>
      ) : null}
    </li>
  );
}
