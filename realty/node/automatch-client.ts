import { dirname, join } from "node:path";
import { areaKey, CachedAreaResolver, type AreaResolver } from "../flow/areas.ts";
import { automatchPairs, FAIR, type AutomatchAsk, type AutomatchPair, type ScoreParts } from "../flow/automatch.ts";
import type { CrmListingsState, CrmSeam } from "../flow/crm-seam.ts";
import { fitsOurListing, type LiveRequest } from "../flow/live-match.ts";
import { listingTypeWord } from "../flow/listing-title.ts";
import type { AreaKnowledgeIndex } from "../flow/area-knowledge.ts";
import { sameSecret, type AgentReply, type Env } from "./agent-search.ts";
import { resolveAreaKnowledge } from "./area-knowledge-store.ts";
import { areasFromEnv, AreaStore } from "./area-store.ts";
import { crmSeamFromEnv } from "./crm-shared.ts";
import { periskopeRoot } from "./periskope-root.ts";

/**
 * POST /api/realty/automatch-client: the 1on1 CRM calls this when a client is added, and gets our active listings that match
 * the client's brief, scored by the existing Automatch scorer (flow/automatch.ts) with the live matching rules (flow/live-match.ts).
 * Server to server, proving itself by Authorization: Bearer <BOPS_AUTOMATCH_TOKEN> (sameSecret, constant time). Not behind the
 * Google gate (lib/gate.ts). Read only: nothing is written or sent, and the client's name and notes are not read.
 *
 * Only what the scorer already scores is used: the hard rules (status, sale or rent, the price band, beds within one) are
 * fitsOurListing's, and the area rules are automatchPairs'. Bathrooms are not scored anywhere: bathrooms_min is a hard floor
 * applied here, before the scorer. A listing matched through several locations is returned once, with its best score.
 */

export const AUTOMATCH_DEFAULT_LIMIT = 10;
export const AUTOMATCH_MAX_LIMIT = 50;

const NOT_SET: AgentReply = { status: 503, body: { error: "Client matching isn't set up on this server yet." } };
const LISTINGS_DOWN: AgentReply = { status: 503, body: { error: "Our listings couldn't be read just now. Try again in a minute." } };
const UNAUTHORIZED: AgentReply = { status: 401, body: { error: "Unauthorized." } };
const bad = (error: string): AgentReply => ({ status: 400, body: { error } });

export type AutomatchClientRequest = { authorization: string | null; body: string };
export type AutomatchClientOpts = {
  seam?: CrmSeam;
  areas?: AreaResolver;
  /** The area knowledge index for neighbour rules by coordinates. Default: the same file the Automatch page reads; null for none. */
  knowledge?: AreaKnowledgeIndex | null;
  fetcher?: typeof fetch;
  root?: string;
  now?: Date;
};

/** A validated brief. `locations` is never empty. The price band is fitsOurListing's (priceMin and priceMax); the scorer reads budget_max, else budget_min. */
type Brief = {
  clientId: string;
  propertyType: string | null;
  listingType: "sale" | "rent";
  locations: string[];
  priceMin: number | null;
  priceMax: number | null;
  currency: "TTD" | "USD";
  beds: number | null;
  bathsMin: number | null;
  limit: number;
};

/** Auth first (503 when the token is unset, 401 for a missing or wrong bearer), then the body. */
export async function automatchClient(req: AutomatchClientRequest, env: Env, o: AutomatchClientOpts = {}): Promise<AgentReply> {
  const want = (env.BOPS_AUTOMATCH_TOKEN ?? "").trim();
  if (!want) return NOT_SET;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.authorization ?? "");
  if (!m || !sameSecret(m[1], want)) return UNAUTHORIZED;

  let raw: unknown;
  try {
    raw = JSON.parse(req.body);
  } catch {
    return bad("The body must be JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("The body must be a JSON object.");
  const brief = briefOf(raw as Record<string, unknown>);
  if ("error" in brief) return bad(brief.error);

  let state: CrmListingsState;
  try {
    state = await (o.seam ?? crmSeamFromEnv(env, o.fetcher)).listings();
  } catch {
    return LISTINGS_DOWN;
  }
  if (state.status !== "ok") return LISTINGS_DOWN;

  const now = o.now ?? new Date();
  const root = o.root ?? periskopeRoot(env);
  const areas = o.areas ?? new CachedAreaResolver(areasFromEnv(new AreaStore(join(dirname(root), "areas")), env, o.fetcher));
  const knowledge = o.knowledge !== undefined ? o.knowledge : resolveAreaKnowledge(join(dirname(root), "area-knowledge.json"));

  const request = liveRequestOf(brief);
  const eligible = state.listings.filter((l) => l.status === "active" && fitsOurListing(request, l) && (brief.bathsMin == null || !(l.baths > 0 && l.baths < brief.bathsMin)));
  const asks: AutomatchAsk[] = brief.locations.map((area, i) => ({
    id: `${brief.clientId}#${i}`,
    area,
    beds: brief.beds,
    budget: brief.priceMax ?? brief.priceMin,
    currency: brief.currency,
    type: brief.propertyType,
    listingType: brief.listingType,
    lastSeenAt: now.toISOString(),
  }));
  const pairs = await automatchPairs(asks, eligible, areas, now, knowledge);

  // Best first, so the first pair of each listing is its best score across the locations.
  const best = new Map<string, AutomatchPair>();
  for (const p of pairs) if (!best.has(p.listing.id)) best.set(p.listing.id, p);
  const matches = [...best.values()]
    .filter((p) => p.score >= FAIR)
    .slice(0, brief.limit)
    .map(matchOf);

  return { status: 200, body: { ok: true, matches, meta: { total_candidates: eligible.length, scored_at: now.toISOString() } } };
}

/** The live matching request the eligibility rules read (the shape matchOurListings takes). fitsOurListing reads no area, so none is set. */
function liveRequestOf(b: Brief): LiveRequest {
  return { intent: b.listingType === "rent" ? "rent" : "buy", area: null, beds: b.beds, propertyType: b.propertyType, priceMin: b.priceMin, priceMax: b.priceMax, currency: b.currency, monthly: false };
}

const MATCHED_FIELDS: readonly { part: keyof ScoreParts; field: string }[] = [
  { part: "area", field: "location" },
  { part: "price", field: "price" },
  { part: "beds", field: "bedrooms" },
  { part: "saleRent", field: "listing_type" },
  { part: "kind", field: "property_type" },
];

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

/* ---------------- the brief ---------------- */

const NUMBER = /^\d+(\.\d+)?$/;

/** A non-negative number, or null when absent or blank. A numeric string is read as its number. undefined when it isn't a number. */
function numberOf(v: unknown): number | null | undefined {
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

/** "Chaguanas, Central" is "Chaguanas"; "Woodbrook, Port of Spain, Trinidad" is "Woodbrook". A text with no place before a region is unchanged. */
export function placeWithoutRegion(text: string): string {
  let place = text.trim();
  for (;;) {
    const comma = place.lastIndexOf(",");
    if (comma <= 0 || !REGION_SUFFIXES.has(areaKey(place.slice(comma + 1)))) return place;
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
  const bathsMin = numberOf(b.bathrooms_min);
  const limit = numberOf(b.limit);
  if (budgetMin === undefined) return { error: "budget_min must be a number." };
  if (budgetMax === undefined) return { error: "budget_max must be a number." };
  if (beds === undefined) return { error: "bedrooms_min must be a number." };
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
    bathsMin,
    limit: Math.min(limit ?? AUTOMATCH_DEFAULT_LIMIT, AUTOMATCH_MAX_LIMIT),
  };
}
