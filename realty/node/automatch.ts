import { dirname, join } from "node:path";
import { ownerAllowed } from "../../lib/gate.ts";
import { CachedAreaResolver, type AreaResolver } from "../flow/areas.ts";
import { askOf, automatchPairs, bandOf, dedupeCounts, FAIR, foldSameSenderPairs, type AutomatchAsk, type AutomatchGroup, type Band } from "../flow/automatch.ts";
import { CRM_UNREACHABLE_TEXT, type CrmListingsState, type CrmSeam, type SeamAgent } from "../flow/crm-seam.ts";
import { runtimeEnv, type Env } from "../flow/env.ts";
import { aliasesOf } from "../flow/knowledge.ts";
import { crmSeamFromEnv } from "./crm-shared.ts";
import { resolveAreaKnowledge } from "./area-knowledge-store.ts";
import { withTaught } from "../flow/taught-areas.ts";
import { areasFromEnv, AreaStore } from "./area-store.ts";
import { requestIdOf } from "./periskope-store.ts";
import { periskopeRoot } from "./periskope-root.ts";
import { withSearchStore, type SearchRow } from "./search-store.ts";
import type { KnownTerm } from "../flow/knowledge.ts";

/**
 * 1on1 CRM Automatch (app/realty/automatch, realty/cli/automatch.ts): WhatsApp demand from the search store matched against
 * our active CRM listings, with the scored pairs at 50 and above. Read only. The store is the search store (all groups, already
 * merged), the listings and agents come from the read-only CRM seam, and the rules are live matching's (flow/automatch.ts).
 * Nothing is sent, and nothing is written to the CRM. Never throws on a CRM failure: it's the honest notice and no pairs.
 */

export type AutomatchAskRow = AutomatchAsk & {
  senderName: string | null;
  senderPhone: string;
  /** The stored post's id for /realty/posts/[messageId] (requestIdOf), or null. */
  postId: string | null;
};

export type AutomatchRow = {
  score: number;
  band: Band;
  reason: string;
  ask: AutomatchAskRow;
  listing: {
    title: string;
    /** The listing's own page when the CRM gives an http(s) url (the same rule as the desk's matches), else null. */
    url: string | null;
    area: string | null;
    price: number | null;
    currency: string;
    /** The CRM's TTD equivalent (price_ttd_equiv), or null. Shown next to a USD price. */
    ttdEquiv: number | null;
    beds: number | null;
    /** The holding agent's name; "agent #id" when the id is known but not named; null when unassigned. */
    agentName: string | null;
  };
  /** Posts this row stands for: the sender's near-identical asks on this listing, folded (the sum of their sightings). */
  posts: number;
};

export type AutomatchResult = {
  /** Demand records considered: all groups, minus parked and ignored. */
  demand: number;
  /** Of those, the asks that have a place and sale or rent (the only ones that can match). */
  asks: number;
  /** Active CRM listings read (0 when the CRM isn't connected or can't be reached). */
  listings: number;
  /** The honest CRM notice when our listings weren't read, else null. */
  crmText: string | null;
  /** Rows at 75 and above, after folding one sender's near-identical asks. */
  strong: number;
  /** Rows at 50 to 74, after folding. */
  fair: number;
  /** Pairs in each band before and after folding (the CLI prints both). */
  dedupe: { strong: { before: number; after: number }; fair: { before: number; after: number } };
  /** Rows at FAIR (50) and above, best first, one per ask record and listing (near-identical asks folded). */
  pairs: AutomatchRow[];
};

type Opts = { env?: Env; root?: string; seam?: CrmSeam; fetcher?: typeof fetch; areas?: AreaResolver; now?: Date };

/**
 * The matching itself, with no owner check (the CLI is run on the server by its operator). Reads the demand, the active
 * listings and the agents, then pairs them. Nothing is written except what the search store's sync always does.
 */
export async function loadAutomatch(o: Opts = {}): Promise<AutomatchResult> {
  const env = o.env ?? runtimeEnv();
  const root = o.root ?? periskopeRoot(env);
  const seam = o.seam ?? crmSeamFromEnv(env, o.fetcher);
  const [crm, agents] = await Promise.all([
    seam.listings().catch((): CrmListingsState => ({ status: "not-connected", text: CRM_UNREACHABLE_TEXT })),
    seam.agents().catch((): SeamAgent[] => []),
  ]);
  const { demand, taught, areaTaught } = withSearchStore(root, (store) => ({ demand: store.allRows("demand"), taught: store.knownTerms(), areaTaught: store.taughtAreas() }));
  const usable = demand.filter((d) => d.status !== "ignored" && d.status !== "parked");
  const byId = new Map<string, SearchRow>(usable.map((d) => [d.id, d]));
  const asks = usable.flatMap((d) => {
    const a = askOf(d);
    return a ? [a] : [];
  });
  const none = { strong: { before: 0, after: 0 }, fair: { before: 0, after: 0 } };
  if (crm.status !== "ok") return { demand: usable.length, asks: asks.length, listings: 0, crmText: crm.text, strong: 0, fair: 0, dedupe: none, pairs: [] };

  const active = crm.listings.filter((l) => l.status === "active");
  const areas = o.areas ?? areasOf(root, env, o.fetcher, taught);
  const knowledge = withTaught(resolveAreaKnowledge(join(dirname(root), "area-knowledge.json")), areaTaught);
  const scored = await automatchPairs(asks, active, areas, o.now ?? new Date(), knowledge);
  const names = new Map<number, string>(agents.flatMap((a) => (a.name ? [[a.id, a.name] as const] : [])));
  const groups = foldSameSenderPairs(scored);
  const dedupe = dedupeCounts(scored);
  const pairs = groups.filter((p) => p.score >= FAIR).map((p) => rowOf(p, byId.get(p.ask.id), names));
  return { demand: usable.length, asks: asks.length, listings: active.length, crmText: null, strong: dedupe.strong.after, fair: dedupe.fair.after, dedupe, pairs };
}

/** The area resolver, kept for ten minutes as the intake keeps its own (periskope-intake.ts oursAreas), so a page load doesn't look the same areas up again. */
let areaCache: { at: number; resolver: AreaResolver } | null = null;
const AREA_CACHE_MS = 10 * 60_000;

function areasOf(root: string, env: Env, fetcher: typeof fetch | undefined, taught: KnownTerm[]): AreaResolver {
  if (!areaCache || Date.now() - areaCache.at > AREA_CACHE_MS) {
    areaCache = { at: Date.now(), resolver: new CachedAreaResolver(areasFromEnv(new AreaStore(join(dirname(root), "areas")), env, fetcher, aliasesOf(taught))) };
  }
  return areaCache.resolver;
}

function rowOf(p: AutomatchGroup, d: SearchRow | undefined, names: Map<number, string>): AutomatchRow {
  const holder = p.listing.agentId > 0 ? p.listing.agentId : null;
  return {
    score: p.score,
    posts: p.posts,
    band: bandOf(p.score) ?? "fair",
    reason: p.reason,
    ask: {
      ...p.ask,
      senderName: d?.senderName ?? null,
      senderPhone: d?.senderPhone ?? "",
      postId: d?.messageIds[0] ? requestIdOf(d.messageIds[0]) : null,
    },
    listing: {
      title: p.listing.title || "Listing",
      url: /^https?:\/\//i.test(p.listing.url) ? p.listing.url : null,
      area: p.listing.area || null,
      price: p.listing.price || null,
      currency: p.listing.currency,
      ttdEquiv: p.listing.ttdEquiv ?? null,
      beds: p.listing.beds || null,
      agentName: holder == null ? null : (names.get(holder) ?? `agent #${holder}`),
    },
  };
}

/**
 * The owners' Automatch (app/realty/automatch). Anyone who isn't an owner (ownerAllowed) gets { owner: false }, and nothing is
 * read: not the store, not the CRM.
 */
export async function staffAutomatch(o: Opts & { email: string | null }): Promise<{ owner: false } | ({ owner: true } & AutomatchResult)> {
  const env = o.env ?? runtimeEnv();
  if (!ownerAllowed(o.email, env)) return { owner: false };
  return { owner: true, ...(await loadAutomatch({ ...o, env })) };
}
