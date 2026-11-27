import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { areaKey, CachedAreaResolver, type AreaResolver, type ToolCaller } from "../flow/areas.ts";
import { automatchPairs, FAIR, widenSuggestions, type AutomatchAsk, type AutomatchPair, type ScoreParts } from "../flow/automatch.ts";
import type { CrmListingsState, CrmSeam } from "../flow/crm-seam.ts";
import { bedsFit, fitsOurListing, liveBuyerArgs, OUR_AGENCY, ourAreaContext, ourAreaRelation, type LiveRequest } from "../flow/live-match.ts";
import { listingTypeWord } from "../flow/listing-title.ts";
import { MarketClient, marketConfigFromEnv, priceOf } from "../flow/market-search.ts";
import { readsAsBuyerAsk } from "../flow/periskope.ts";
import { parseMatch } from "../flow/recommendations.ts";
import { jsonHits, readOnlyCall, timedOut } from "../flow/requests.ts";
import type { Listing } from "../flow/source.ts";
import { regionOfPlace, type AreaKnowledgeIndex } from "../flow/area-knowledge.ts";
import { knownPlaceName } from "../flow/observe.ts";
import { sameSecret, type AgentReply, type Env } from "./agent-search.ts";
import { areasFromEnv, AreaStore } from "./area-store.ts";
import { crmSeamFromEnv } from "./crm-shared.ts";
import { periskopeRoot } from "./periskope-root.ts";
import { PeriskopeStore } from "./periskope-store.ts";
import { matchingKnowledgeFrom, withSearchStore, type Side, type SearchRow } from "./search-store.ts";

/**
 * POST /api/realty/automatch-client: the 1on1 CRM calls this when a client is added, and gets matches for the client's brief
 * from the sources it asks for (`sources`, default ["crm"]):
 *   crm       our active CRM listings, scored by the existing Automatch scorer (flow/automatch.ts) with the live matching rules
 *             (flow/live-match.ts). Returned as `matches`. Not fetched when "crm" isn't asked for.
 *   whatsapp  our WhatsApp supply (offers, not asks) from the local search store, scored by the same rules. Returned as
 *             `whatsapp_matches`, with the poster's name and number and a link to the post, never a group name. A stored row
 *             that reads as a buyer's ask is left out, whichever side it was filed under (readsAsBuyerAsk).
 *   online    other agencies' listings, from the co-broke market's read-only match_buyer, one call per location. Returned as
 *             `online_matches`, each kept only where our own area rules place it in that location (placedIn), so the market's
 *             reading of a place is never the last word. A slow or missing market never fails the others: it is a plain-English
 *             warning in meta.
 * Server to server, proving itself by Authorization: Bearer <BOPS_AUTOMATCH_TOKEN> (sameSecret, constant time). Not behind the
 * Google gate (lib/gate.ts). Read only: nothing is written or sent, and the client's name and notes are not read or sent on.
 *
 * Only what the scorer already scores is used: the hard rules (status, sale or rent, the price band, the beds rule) are
 * fitsOurListing's, and the area rules are automatchPairs'. Bathrooms are not scored anywhere: bathrooms_min is a hard floor
 * applied here, before the scorer. A listing matched through several locations is returned once, with its best score.
 */

export const AUTOMATCH_DEFAULT_LIMIT = 10;
export const AUTOMATCH_MAX_LIMIT = 50;

export const SOURCES = ["crm", "whatsapp", "online"] as const;
export type Source = (typeof SOURCES)[number];
const DEFAULT_SOURCES: readonly Source[] = ["crm"];
/** The longest excerpt returned for a WhatsApp post, in characters (the ellipsis included). */
export const EXCERPT_MAX = 240;
/** The deadline for one location's market search when the market's own settings don't give one. */
const ONLINE_TIMEOUT_MS = 4000;
const DEFAULT_PUBLIC_URL = "https://bop.1on1realtors.com";

const NOT_SET: AgentReply = { status: 503, body: { error: "Client matching isn't set up on this server yet." } };
const LISTINGS_DOWN: AgentReply = { status: 503, body: { error: "Our listings couldn't be read just now. Try again in a minute." } };
const UNAUTHORIZED: AgentReply = { status: 401, body: { error: "Unauthorized." } };
const bad = (error: string): AgentReply => ({ status: 400, body: { error } });

const CRM_DOWN_WARNING = "Our CRM listings couldn't be read just now, so the crm matches are empty. Try again in a minute.";
const WHATSAPP_DOWN_WARNING = "The WhatsApp listings couldn't be read just now, so the whatsapp matches are empty.";
const ONLINE_OFF_WARNING = "The other agencies' listings search isn't set up on this server, so the online matches are empty.";

export type AutomatchClientRequest = { authorization: string | null; body: string };
export type AutomatchClientOpts = {
  seam?: CrmSeam;
  areas?: AreaResolver;
  /** The area knowledge index for neighbour rules by coordinates. Default: the same file the Automatch page reads; null for none. */
  knowledge?: AreaKnowledgeIndex | null;
  fetcher?: typeof fetch;
  root?: string;
  now?: Date;
  /** The WhatsApp supply rows to score (the search store's supply tab). Default: read from the store at `root`. Tests pass rows. */
  supply?: SearchRow[];
  /** The market's tool caller for the online source. Default: a MarketClient for the market settings in env; null for none (online is off). */
  market?: ToolCaller | null;
  /** The deadline for one location's market search, in ms. Default: the market's own timeout, else 4000. */
  marketTimeoutMs?: number;
};

/**
 * A validated brief. `locations` is never empty. priceMin and priceMax are budget_min and budget_max: a range when both are given (fitsOurListing,
 * scorePair), else a single budget. beds and bedsMax are bedrooms_min and bedrooms_max: a range when both are given, else a single figure.
 */
type Brief = {
  clientId: string;
  propertyType: string | null;
  listingType: "sale" | "rent";
  locations: string[];
  priceMin: number | null;
  priceMax: number | null;
  currency: "TTD" | "USD";
  beds: number | null;
  bedsMax: number | null;
  bathsMin: number | null;
  limit: number;
};

/** The bearer check the CRM's endpoints share: 503 when the token is unset (even with a bearer sent), 401 for a missing or wrong bearer, else null. */
export function automatchAuthReply(authorization: string | null, env: Env): AgentReply | null {
  const want = (env.BOPS_AUTOMATCH_TOKEN ?? "").trim();
  if (!want) return NOT_SET;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  if (!m || !sameSecret(m[1], want)) return UNAUTHORIZED;
  return null;
}

/** Auth first (503 when the token is unset, 401 for a missing or wrong bearer), then the body. */
export async function automatchClient(req: AutomatchClientRequest, env: Env, o: AutomatchClientOpts = {}): Promise<AgentReply> {
  const refused = automatchAuthReply(req.authorization, env);
  if (refused) return refused;

  let raw: unknown;
  try {
    raw = JSON.parse(req.body);
  } catch {
    return bad("The body must be JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("The body must be a JSON object.");
  const brief = briefOf(raw as Record<string, unknown>);
  if ("error" in brief) return bad(brief.error);
  const sources = sourcesOf((raw as Record<string, unknown>).sources);
  if ("error" in sources) return bad(sources.error);

  const wantCrm = sources.list.includes("crm");
  const wantWhatsapp = sources.list.includes("whatsapp");
  const wantOnline = sources.list.includes("online");
  const warnings: string[] = [];
  const now = o.now ?? new Date();
  const request = liveRequestOf(brief);
  // The place names this request carries: the brief's, and each scored listing's area (for the unknown-places note).
  const placeNames: string[] = [...brief.locations];

  // CRM: read only when asked for. A failed read is a 503 when it's the only source, else a warning and no CRM matches.
  let crmListings: Listing[] | null = null;
  if (wantCrm) {
    try {
      const state: CrmListingsState = await (o.seam ?? crmSeamFromEnv(env, o.fetcher)).listings();
      if (state.status === "ok") crmListings = state.listings;
    } catch {
      crmListings = null;
    }
    if (crmListings === null && sources.list.length === 1) return LISTINGS_DOWN;
    if (crmListings === null) warnings.push(CRM_DOWN_WARNING);
  }

  const root = o.root ?? periskopeRoot(env);
  const asks: AutomatchAsk[] = asksOf(brief, now);
  const scoring = crmListings !== null || wantWhatsapp || wantOnline ? scoringContext(o, env, root) : null;

  let matches: ReturnType<typeof matchOf>[] = [];
  let totalCandidates = 0;
  if (crmListings !== null && scoring) {
    const { eligible, ranked } = await scoreAgainst(asks, crmListings, brief, request, scoring, now);
    totalCandidates = eligible.length;
    placeNames.push(...eligible.map((l) => placeWithoutRegion(l.area)));
    matches = ranked.slice(0, brief.limit).map(matchOf);
  }

  // WhatsApp supply: the store's own failure is a warning, never a failed request.
  let whatsappMatches: ReturnType<typeof supplyMatchOf>[] = [];
  let whatsappCandidates = 0;
  if (wantWhatsapp && scoring) {
    try {
      // A stored supply row that reads as a buyer's ask is left out, whatever side it was filed under (older rows may be misfiled).
      const rows = (o.supply ?? storedRows(root, "supply")).filter(isLive).filter((row) => !readsAsBuyerAsk(row.originalText ?? ""));
      const pairs = rows.flatMap((row) => {
        const listing = supplyListingOf(row);
        return listing ? [{ row, listing }] : [];
      });
      const byId = new Map(pairs.map((p) => [p.listing.id, p.row] as const));
      const { eligible, ranked } = await scoreAgainst(asks, pairs.map((p) => p.listing), brief, request, scoring, now);
      whatsappCandidates = eligible.length;
      placeNames.push(...eligible.map((l) => l.area));
      whatsappMatches = ranked.slice(0, brief.limit).flatMap((p) => {
        const row = byId.get(p.listing.id);
        return row ? [supplyMatchOf(p, row, publicUrlOf(env))] : [];
      });
    } catch {
      warnings.push(WHATSAPP_DOWN_WARNING);
    }
  }

  // Other agencies' listings: each location asked in parallel, each with a deadline; a failure is a warning.
  let onlineMatches: OnlineItem[] = [];
  if (wantOnline && scoring) {
    const r = await onlineSearch(brief, request, marketFor(env, o), now, scoring);
    onlineMatches = r.items;
    warnings.push(...r.warnings);
    placeNames.push(...onlineMatches.map((m) => m.location).filter((n): n is string => !!n));
  }
  if (scoring) noteUnknownPlaces(root, placeNames, scoring.knowledge, now);

  const body: Record<string, unknown> = { ok: true, matches };
  if (wantWhatsapp) body.whatsapp_matches = whatsappMatches;
  if (wantOnline) body.online_matches = onlineMatches;
  const meta: Record<string, unknown> = {
    total_candidates: totalCandidates,
    scored_at: now.toISOString(),
    sources: sources.list,
    ...(wantWhatsapp ? { whatsapp_candidates: whatsappCandidates } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
  const widen = widenSuggestions({
    sources: sources.list,
    locations: brief.locations,
    budgetMax: brief.priceMax,
    currency: brief.currency,
    bedrooms: brief.beds,
    scores: [...matches, ...whatsappMatches, ...onlineMatches].map((m) => m.score),
    regionOf: (place) => regionOfPlace(scoring?.knowledge ?? null, place),
  });
  if (widen) meta.widen_suggestions = widen;
  body.meta = meta;
  return { status: 200, body };
}

/**
 * Place names the matcher doesn't know yet are counted in the unknown-places file, for Teach. Local and quick: nothing is looked up
 * and no listing is dropped for it. Names only. A failed write never fails the request.
 */
function noteUnknownPlaces(root: string, names: readonly string[], knowledge: AreaKnowledgeIndex | null, now: Date): void {
  const unknown = [...new Set(names.map((n) => n.trim()))].filter((n) => n && n.length <= 40 && !knownPlaceName(n, knowledge));
  try {
    new PeriskopeStore(root).noteUnknownPlaces(unknown, now.toISOString());
  } catch {
    // The count is a note for Teach: a full disk or a locked file must not fail the match.
  }
}

/** The asks, one per location: the scorer reads each as a buyer's ask in that area, with the brief's budget and bedroom range (or single figure). */
function asksOf(brief: Brief, now: Date): AutomatchAsk[] {
  return brief.locations.map((area, i) => ({
    id: `${brief.clientId}#${i}`,
    area,
    beds: brief.beds,
    bedsMax: brief.bedsMax,
    budget: brief.priceMax,
    budgetMin: brief.priceMin,
    currency: brief.currency,
    type: brief.propertyType,
    listingType: brief.listingType,
    lastSeenAt: now.toISOString(),
  }));
}

/** The area resolver and the knowledge index, shared by the CRM and the WhatsApp scoring. */
export type ScoringContext = { areas: AreaResolver; knowledge: AreaKnowledgeIndex | null };

export function scoringContext(o: Pick<AutomatchClientOpts, "areas" | "knowledge" | "fetcher">, env: Env, root: string): ScoringContext {
  const areas = o.areas ?? new CachedAreaResolver(areasFromEnv(new AreaStore(join(dirname(root), "areas")), env, o.fetcher));
  const knowledge = o.knowledge !== undefined ? o.knowledge : matchingKnowledgeFrom(root);
  return { areas, knowledge };
}

/**
 * The eligible listings (fitsOurListing, the bathrooms floor) and the best pair per listing at FAIR or above, best first.
 * `eligible` is before the score cut: its length is what the meta counts.
 */
async function scoreAgainst(
  asks: AutomatchAsk[],
  listings: readonly Listing[],
  brief: Brief,
  request: LiveRequest,
  ctx: ScoringContext,
  now: Date,
): Promise<{ eligible: Listing[]; ranked: AutomatchPair[] }> {
  const eligible = listings.filter((l) => l.status === "active" && fitsOurListing(request, l) && (brief.bathsMin == null || !(l.baths > 0 && l.baths < brief.bathsMin)));
  const pairs = await automatchPairs(asks, eligible, ctx.areas, now, ctx.knowledge);
  // Best first, so the first pair of each listing is its best score across the locations.
  const best = new Map<string, AutomatchPair>();
  for (const p of pairs) if (!best.has(p.listing.id)) best.set(p.listing.id, p);
  return { eligible, ranked: [...best.values()].filter((p) => p.score >= FAIR) };
}

/** The live matching request the eligibility rules read (the shape matchOurListings takes). fitsOurListing reads no area, so none is set. */
function liveRequestOf(b: Brief): LiveRequest {
  return { intent: b.listingType === "rent" ? "rent" : "buy", area: null, beds: b.beds, bedsMax: b.bedsMax, propertyType: b.propertyType, priceMin: b.priceMin, priceMax: b.priceMax, currency: b.currency, monthly: false };
}

const MATCHED_FIELDS: readonly { part: keyof ScoreParts; field: string }[] = [
  { part: "area", field: "location" },
  { part: "price", field: "price" },
  { part: "beds", field: "bedrooms" },
  { part: "saleRent", field: "listing_type" },
  { part: "kind", field: "property_type" },
];

/** Our CRM listing, as the CRM matches have always returned it. */
function matchOf(p: AutomatchPair) {
  const l = p.listing;
  return {
    property_id: l.id,
    title: l.title || null,
    location: l.area || null,
    price: l.price || null,
    currency: l.currency,
    listing_type: l.listingType,
    property_type: listingTypeWord(l.title, l.propertyKind),
    bedrooms: l.beds || null,
    bathrooms: l.baths || null,
    score: p.score,
    reasons: [p.reason],
    matched_fields: MATCHED_FIELDS.filter((f) => p.parts[f.part] > 0).map((f) => f.field),
  };
}

/* ---------------- WhatsApp supply ---------------- */

/** The stored rows of one tab, read from the search store. Nothing is created when the store has no files yet. */
export function storedRows(root: string, tab: Side): SearchRow[] {
  if (!existsSync(join(root, "supply.jsonl")) && !existsSync(join(root, "demand.jsonl"))) return [];
  return withSearchStore(root, (s) => s.allRows(tab));
}

/** A supply row that can still be offered: not ignored or parked (the store's hidden states, as loadAutomatch reads them). */
const isLive = (row: SearchRow): boolean => row.status !== "ignored" && row.status !== "parked";

/**
 * A supply row as a Listing for the scorer. Only sale or rent rows count: a shortlet or an unknown kind can't meet a sale or
 * rent ask. The area goes through placeWithoutRegion, as the CRM's area does. No CRM agent, url or status beyond "active".
 * The title carries the beds and type only, never the area, so a place name can't steer the category rule.
 */
export function supplyListingOf(row: SearchRow): Listing | null {
  if (row.listingType !== "sale" && row.listingType !== "rent") return null;
  const place = placeWithoutRegion(row.area ?? row.development ?? "");
  const kind = row.type ?? "property";
  return {
    id: row.id,
    title: row.beds != null ? `${row.beds} bed ${kind}` : kind,
    listingType: row.listingType,
    area: place,
    price: row.price ?? 0,
    currency: row.currency === "USD" ? "USD" : "TTD",
    beds: row.beds ?? 0,
    baths: row.baths ?? 0,
    agentId: 0,
    status: "active",
    url: "",
  };
}

/** Whole-word, case-insensitive: the group names and the product names are taken out of the text before it is cut. */
const wordRe = (term: string) => new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");
const INTERNAL_NAMES = /(?<![\p{L}\p{N}])(periskope|bops)(?![\p{L}\p{N}])/giu;

/**
 * The post's plain excerpt: whitespace collapsed, the WhatsApp group names and the internal product names taken out, and at
 * most EXCERPT_MAX characters. null when no text is left.
 */
export function excerptOf(text: string | null, groups: readonly string[] = []): string | null {
  let t = (text ?? "").replace(/\s+/g, " ").trim();
  for (const g of groups.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).sort((a, b) => b.length - a.length)) t = t.replace(wordRe(g), " ");
  t = t.replace(INTERNAL_NAMES, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : t;
}

/** The public site's address for a link: BOPS_PUBLIC_URL without a trailing slash, else the hosted default. */
export function publicUrlOf(env: Env): string {
  return (env.BOPS_PUBLIC_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_PUBLIC_URL;
}

/** A WhatsApp match. No group name, and nothing that names the internal tools: the reasons are the scorer's own words. */
function supplyMatchOf(p: AutomatchPair, row: SearchRow, publicUrl: string) {
  return {
    id: row.id,
    title: p.listing.title,
    location: p.listing.area || null,
    price: p.listing.price || null,
    currency: row.currency,
    listing_type: row.listingType === "sale" || row.listingType === "rent" ? row.listingType : null,
    property_type: row.type,
    bedrooms: row.beds,
    bathrooms: row.baths,
    score: p.score,
    reasons: [p.reason],
    sender_name: row.senderName,
    sender_phone: row.senderPhone || null,
    posted_at: row.lastSentAt || null,
    excerpt: excerptOf(row.originalText, row.groups),
    post_url: row.id ? `${publicUrl}/realty/posts/${encodeURIComponent(row.id)}` : null,
  };
}

/* ---------------- Other agencies' listings (the co-broke market) ---------------- */

export type OnlineItem = {
  id: string | null;
  title: string | null;
  location: string | null;
  price: number | null;
  currency: string | null;
  listing_type: "sale" | "rent" | null;
  property_type: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  score: number | null;
  reasons: string[];
  source_site: string | null;
  url: string | null;
};

type MarketSource = { caller: ToolCaller; timeoutMs: number } | null;

/** The market for the online source: the injected caller in tests, else the market settings in env. null when it isn't set up. */
function marketFor(env: Env, o: AutomatchClientOpts): MarketSource {
  if (o.market !== undefined) return o.market ? { caller: o.market, timeoutMs: o.marketTimeoutMs ?? ONLINE_TIMEOUT_MS } : null;
  const cfg = marketConfigFromEnv(env);
  return cfg ? { caller: new MarketClient(cfg, o.fetcher), timeoutMs: o.marketTimeoutMs ?? cfg.timeoutMs } : null;
}

type LocationOutcome = { status: "ok"; items: OnlineItem[] } | { status: "timeout" | "unavailable" };

/** Every location asked in parallel, each with its own deadline. Never throws. */
async function onlineSearch(brief: Brief, request: LiveRequest, market: MarketSource, now: Date, ctx: ScoringContext): Promise<{ items: OnlineItem[]; warnings: string[] }> {
  if (!market) return { items: [], warnings: [ONLINE_OFF_WARNING] };
  const postedAt = now.toISOString();
  const outcomes = await Promise.all(brief.locations.map((area, i) => onlineOne(market, { ...request, area }, `automatch-${i + 1}`, postedAt, brief.limit, ctx)));
  const warnings: string[] = [];
  const failed = outcomes.filter((r) => r.status !== "ok");
  if (failed.length === outcomes.length) {
    const timedOutAll = failed.every((r) => r.status === "timeout");
    warnings.push(`The other agencies' listings search ${timedOutAll ? "timed out" : "is unavailable right now"}, so the online matches are empty.`);
  } else if (failed.length) {
    warnings.push(`The other agencies' listings search didn't answer for ${failed.length} of ${outcomes.length} areas, so some online matches may be missing.`);
  }
  const items = outcomes.flatMap((r) => (r.status === "ok" ? r.items : []));
  return { items: rankOnline(items, brief.limit), warnings };
}

/** One location's match_buyer call, read only, with a deadline. A failure is a status, never a throw. */
async function onlineOne(market: { caller: ToolCaller; timeoutMs: number }, r: LiveRequest, ref: string, postedAt: string, limit: number, ctx: ScoringContext): Promise<LocationOutcome> {
  try {
    const args = { ...liveBuyerArgs(r, ref, postedAt), limit };
    const hits = jsonHits(await withDeadline(readOnlyCall(market.caller, "match_buyer", args), market.timeoutMs));
    if (!hits) return { status: "unavailable" };
    const items = hits.flatMap((h) => {
      const item = onlineItemOf(h);
      return item && bedsFit(r, item.bedrooms ?? 0) ? [item] : [];
    });
    return { status: "ok", items: await placedIn(items, r.area ?? "", ctx) };
  } catch (err) {
    return { status: timedOut(err) ? "timeout" : "unavailable" };
  }
}

/**
 * The market's items that our own area rules place in the location asked: the same tiers as our listings (ourAreaRelation). The market
 * answers on its own reading of the place, so an item is kept only when we place it there too. A Tobago location never keeps a Trinidad
 * item, and an item whose place we can't work out is left out.
 */
async function placedIn(items: OnlineItem[], area: string, ctx: ScoringContext): Promise<OnlineItem[]> {
  if (!area || !items.length) return [];
  const listings = items.map(onlineListingOf);
  const actx = await ourAreaContext(area, listings, ctx.areas, ctx.knowledge);
  return items.filter((_, i) => ourAreaRelation(actx, listings[i]) !== null);
}

/** An online item as a Listing, for the area rules only: its place and its title (the other fields are not read by the area rules). */
function onlineListingOf(it: OnlineItem): Listing {
  return {
    id: it.id ?? "",
    title: it.title ?? "",
    listingType: it.listing_type ?? "sale",
    area: it.location ?? "",
    price: it.price ?? 0,
    currency: it.currency === "USD" ? "USD" : "TTD",
    beds: it.bedrooms ?? 0,
    baths: it.bathrooms ?? 0,
    agentId: 0,
    status: "active",
    url: "",
  };
}

/** Rejects with a TimeoutError when `ms` passes first. The call itself is left to finish (or fail) on its own. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("The market search timed out."), { name: "TimeoutError" })), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * One match_buyer hit as an online match. parseMatch reads the listing and drops contact details from its reason. Our own
 * listings (the market's "oneonone" source, or our agency's name) are dropped: the CRM already gives us those.
 */
function onlineItemOf(h: unknown): OnlineItem | null {
  const parsed = parseMatch(h);
  if (!parsed) return null;
  const item = parsed.item;
  if (item.source?.trim().toLowerCase() === "oneonone" || item.agency?.trim().toLowerCase() === OUR_AGENCY.toLowerCase()) return null;
  const o = h as Record<string, unknown>;
  const l = objectOf(o.listing);
  const money = priceOf(l.price ?? o.price, l.currency ?? o.currency);
  const lt = item.listingType?.trim().toLowerCase();
  return {
    id: idOf(l.id) ?? idOf(o.listing_ref) ?? idOf(o.id),
    title: item.title,
    location: item.area,
    price: money.price,
    currency: money.currency,
    listing_type: lt === "sale" || lt === "rent" ? lt : null,
    property_type: item.propertyClass ?? null,
    bedrooms: item.beds,
    bathrooms: numberOf(l.baths ?? o.baths) ?? null,
    score: scoreOf(o.score ?? l.score),
    reasons: item.reason ? [item.reason] : [],
    source_site: item.agency ?? item.source ?? null,
    url: item.url,
  };
}

/** Best first (a null score last), one per listing (its url, or its title, place and price), at most `limit`. */
function rankOnline(items: OnlineItem[], limit: number): OnlineItem[] {
  const seen = new Map<string, OnlineItem>();
  for (const it of items) {
    const key = it.url ?? `${it.title}|${it.location}|${it.price}|${it.currency}`.toLowerCase();
    const prev = seen.get(key);
    if (!prev || (it.score ?? -1) > (prev.score ?? -1)) seen.set(key, it);
  }
  return [...seen.values()].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, limit);
}

/**
 * The market's own score as 0 to 100. The market has sent 0 to 1 (a 0.91 is 91), and some 0 to 100; anything else is null.
 * Market scores are the market's, not ours: they are not comparable with the CRM's score, and only the online matches carry them.
 */
function scoreOf(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  if (v <= 1) return Math.round(v * 100);
  return v <= 100 ? Math.round(v) : null;
}

const objectOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const idOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

/* ---------------- sources ---------------- */

const isSource = (s: string): s is Source => (SOURCES as readonly string[]).includes(s);

/**
 * The requested sources, trimmed, lower-cased, de-duplicated in the order given. Absent (or null) is ["crm"]. A list with a
 * value that isn't a source, or an empty list, is a 400.
 */
function sourcesOf(raw: unknown): { list: Source[] } | { error: string } {
  if (raw === undefined || raw === null) return { list: [...DEFAULT_SOURCES] };
  const badSources = { error: 'sources must be a non-empty list of "crm", "whatsapp" or "online".' };
  if (!Array.isArray(raw) || raw.length === 0) return badSources;
  const list: Source[] = [];
  for (const s of raw) {
    const k = typeof s === "string" ? s.trim().toLowerCase() : "";
    if (!isSource(k)) return badSources;
    if (!list.includes(k)) list.push(k);
  }
  return { list };
}

/* ---------------- the brief ---------------- */

const NUMBER = /^\d+(\.\d+)?$/;

/** A non-negative number, or null when absent or blank. A numeric string is read as its number. undefined when it isn't a number. */
export function numberOf(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    if (!NUMBER.test(t)) return undefined;
    return Number(t);
  }
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Trinidad & Tobago region names a 1on1 CRM location can end with ("Chaguanas, Central"). Read as region names only: a place
 * name before the comma is what matches, so the region is dropped.
 */
const REGION_SUFFIXES = new Set(
  ["Central", "North West", "North East", "East", "South", "Tobago", "East-West Corridor", "Port of Spain", "Trinidad", "Trinidad & Tobago"].map(areaKey),
);

/** A region or island name on its own ("Tobago", "North West", "Trinidad"), not a place. */
export const isRegionWord = (text: string): boolean => REGION_SUFFIXES.has(areaKey(text));

/** "Chaguanas, Central" is "Chaguanas"; "Woodbrook, Port of Spain, Trinidad" is "Woodbrook". A text with no place before a region is unchanged. */
export function placeWithoutRegion(text: string): string {
  let place = text.trim();
  for (;;) {
    const comma = place.lastIndexOf(",");
    if (comma <= 0 || !isRegionWord(place.slice(comma + 1))) return place;
    place = place.slice(0, comma).trim();
  }
}

/** A brief from the body, or the 400 message. Name and notes are not read. */
function briefOf(b: Record<string, unknown>): Brief | { error: string } {
  const listingType = typeof b.listing_type === "string" ? b.listing_type.trim().toLowerCase() : "";
  if (listingType !== "sale" && listingType !== "rent") return { error: 'listing_type must be "sale" or "rent".' };

  const rawLocation = b.location;
  const list = typeof rawLocation === "string" ? [rawLocation] : Array.isArray(rawLocation) ? rawLocation : null;
  if (!list || list.some((s) => typeof s !== "string")) return { error: "location must be a string or a list of strings." };
  const locations = [...new Set((list as string[]).map((s) => placeWithoutRegion(s)).filter(Boolean))];
  if (!locations.length) return { error: "location is required." };

  if (b.client_id != null && typeof b.client_id !== "string" && typeof b.client_id !== "number") return { error: "client_id must be a string or a number." };
  const clientId = b.client_id == null ? "client" : String(b.client_id);

  if (b.property_type != null && typeof b.property_type !== "string") return { error: "property_type must be a string." };
  const propertyType = typeof b.property_type === "string" && b.property_type.trim() ? b.property_type.trim() : null;

  const budgetMin = numberOf(b.budget_min);
  const budgetMax = numberOf(b.budget_max);
  const beds = numberOf(b.bedrooms_min);
  const bedsMax = numberOf(b.bedrooms_max);
  const bathsMin = numberOf(b.bathrooms_min);
  const limit = numberOf(b.limit);
  if (budgetMin === undefined) return { error: "budget_min must be a number." };
  if (budgetMax === undefined) return { error: "budget_max must be a number." };
  if (beds === undefined) return { error: "bedrooms_min must be a number." };
  if (bedsMax === undefined) return { error: "bedrooms_max must be a number." };
  if (bedsMax !== null && beds === null) return { error: "bedrooms_max needs bedrooms_min." };
  if (beds !== null && bedsMax !== null && beds > bedsMax) return { error: "bedrooms_min is more than bedrooms_max." };
  if (bathsMin === undefined) return { error: "bathrooms_min must be a number." };
  if (limit === undefined || (limit !== null && (!Number.isInteger(limit) || limit < 1))) return { error: "limit must be a whole number, 1 or more." };
  if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) return { error: "budget_min is more than budget_max." };

  return {
    clientId,
    propertyType,
    listingType,
    locations,
    priceMin: budgetMin,
    priceMax: budgetMax,
    currency: typeof b.currency === "string" && b.currency.trim().toUpperCase() === "USD" ? "USD" : "TTD",
    beds,
    bedsMax,
    bathsMin,
    limit: Math.min(limit ?? AUTOMATCH_DEFAULT_LIMIT, AUTOMATCH_MAX_LIMIT),
  };
}
