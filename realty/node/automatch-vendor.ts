import type { AreaKnowledgeIndex } from "../flow/area-knowledge.ts";
import type { AreaResolver } from "../flow/areas.ts";
import { askOf, automatchPairs, FAIR, foldSameSenderPairs, requestOf, type AutomatchAsk, type AutomatchPair } from "../flow/automatch.ts";
import { fitsOurListing, type LiveRequest } from "../flow/live-match.ts";
import { propertyKindFromCrm } from "../flow/taxonomy.ts";
import type { Listing } from "../flow/source.ts";
import type { CrmClientDemand } from "../crm.ts";
import type { AgentReply, Env } from "./agent-search.ts";
import { AUTOMATCH_MAX_LIMIT, automatchAuthReply, excerptOf, isRegionWord, numberOf, placeWithoutRegion, publicUrlOf, scoringContext, storedRows, type ScoringContext } from "./automatch-client.ts";
import { sharedCrmSource } from "./crm-shared.ts";
import { periskopeRoot } from "./periskope-root.ts";
import type { SearchRow } from "./search-store.ts";

/**
 * POST /api/realty/automatch-vendor: a Vendor or Landlord offers a property, and this scores who it could suit: the active buyers
 * and tenants on the CRM (sources "crm_clients") and the WhatsApp requests in our demand tab ("whatsapp_requests"). The inverse of
 * automatch-client: the offered property is the one listing, and each buyer or request is an ask scored against it. The same rules
 * as everywhere: fitsOurListing decides who is eligible, automatchPairs scores the place and the rest, and FAIR is the cut.
 * Server to server, proving itself by Authorization: Bearer <BOPS_AUTOMATCH_TOKEN> (automatchAuthReply). Not behind the Google gate
 * (lib/gate.ts). Read only: nothing is written or sent. Client contact details and notes are never read.
 */

const VENDOR_DEFAULT_LIMIT = 15;
export const VENDOR_SOURCES = ["crm_clients", "whatsapp_requests"] as const;
export type VendorSource = (typeof VENDOR_SOURCES)[number];

const CLIENTS_DOWN: AgentReply = { status: 503, body: { error: "Our CRM clients couldn't be read just now. Try again in a minute." } };
const DEMAND_DOWN: AgentReply = { status: 503, body: { error: "The WhatsApp requests couldn't be read just now. Try again in a minute." } };
const CLIENTS_DOWN_WARNING = "Our CRM clients couldn't be read just now, so the client matches are empty.";
const DEMAND_DOWN_WARNING = "The WhatsApp requests couldn't be read just now, so the whatsapp matches are empty.";
const bad = (error: string): AgentReply => ({ status: 400, body: { error } });

export type AutomatchVendorRequest = { authorization: string | null; body: string };
export type AutomatchVendorOpts = {
  /** The CRM's buyers and tenants. Default: read through the shared read-only CRM; none when the CRM isn't set up. Tests pass rows. */
  clients?: CrmClientDemand[];
  /** The WhatsApp demand rows (the search store's demand tab). Default: read from the store at `root`. Tests pass rows. */
  demand?: SearchRow[];
  areas?: AreaResolver;
  /** The area knowledge index for neighbour rules by coordinates. Default: the same file the Automatch page reads; null for none. */
  knowledge?: AreaKnowledgeIndex | null;
  fetcher?: typeof fetch;
  root?: string;
  now?: Date;
};

/** The property being offered, as the one Listing the scorer reads, and how many matches to return. */
type Offer = { listing: Listing; limit: number };

/** A buyer or tenant on the CRM who could take the offered property: their intent and the places they asked for. */
type Lead = { client: CrmClientDemand; intent: "sale" | "rent"; places: string[] };

/** Auth first (503 when the token is unset, 401 for a missing or wrong bearer), then the body. */
export async function automatchVendor(req: AutomatchVendorRequest, env: Env, o: AutomatchVendorOpts = {}): Promise<AgentReply> {
  const refused = automatchAuthReply(req.authorization, env);
  if (refused) return refused;

  let raw: unknown;
  try {
    raw = JSON.parse(req.body);
  } catch {
    return bad("The body must be JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("The body must be a JSON object.");
  const b = raw as Record<string, unknown>;
  const offer = offerOf(b);
  if ("error" in offer) return bad(offer.error);
  const sources = sourcesOf(b.sources);
  if ("error" in sources) return bad(sources.error);

  const { listing, limit } = offer;
  const solo = sources.list.length === 1;
  const warnings: string[] = [];
  const now = o.now ?? new Date();
  const root = o.root ?? periskopeRoot(env);
  const ctx = scoringContext(o, env, root);

  // CRM clients: read only when asked for. A failed read is a 503 when it's the only source, else a warning and no client matches.
  let clientMatches: ReturnType<typeof clientMatchOf>[] = [];
  let crmCandidates = 0;
  if (sources.list.includes("crm_clients")) {
    let clients: CrmClientDemand[] | null = null;
    try {
      clients = await clientsOf(env, o);
    } catch {
      clients = null;
    }
    if (clients === null) {
      if (solo) return CLIENTS_DOWN;
      warnings.push(CLIENTS_DOWN_WARNING);
    } else {
      const r = await matchClients(clients, listing, ctx, now);
      crmCandidates = r.candidates;
      clientMatches = r.ranked.slice(0, limit).map(clientMatchOf);
    }
  }

  // WhatsApp requests: the store's own failure is a warning (a 503 when it's the only source), never a failed request.
  let demandMatches: ReturnType<typeof demandMatchOf>[] = [];
  let whatsappCandidates = 0;
  if (sources.list.includes("whatsapp_requests")) {
    let rows: SearchRow[] | null = null;
    try {
      rows = o.demand ?? storedRows(root, "demand");
    } catch {
      rows = null;
    }
    if (rows === null) {
      if (solo) return DEMAND_DOWN;
      warnings.push(DEMAND_DOWN_WARNING);
    } else {
      const r = await matchDemand(rows, listing, ctx, now);
      whatsappCandidates = r.candidates;
      const publicUrl = publicUrlOf(env);
      demandMatches = r.ranked.slice(0, limit).map((m) => demandMatchOf(m, publicUrl));
    }
  }

  const meta: Record<string, unknown> = {
    crm_candidates: crmCandidates,
    whatsapp_candidates: whatsappCandidates,
    scored_at: now.toISOString(),
    sources: sources.list,
    ...(warnings.length ? { warnings } : {}),
  };
  return { status: 200, body: { ok: true, client_matches: clientMatches, whatsapp_requests: demandMatches, meta } };
}

/** The CRM's buyers and tenants: the injected rows in tests, else read through the shared read-only CRM. null when the CRM isn't set up. Throws when the read fails. */
async function clientsOf(env: Env, o: AutomatchVendorOpts): Promise<CrmClientDemand[] | null> {
  if (o.clients) return o.clients;
  const source = sharedCrmSource(env, o.fetcher);
  return source ? source.clientDemand() : null;
}

/* ---------------- the offered property ---------------- */

/** "sale", "buy", "for-sale" are sale; "rent", "for-rent", "lease" are rent; anything else is null. */
function listingTypeOf(v: unknown): "sale" | "rent" | null {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (["sale", "for-sale", "buy"].includes(t)) return "sale";
  if (["rent", "for-rent", "lease"].includes(t)) return "rent";
  return null;
}

/** TTD or USD in any case. Absent or null is TTD; anything else is null. */
function currencyOf(v: unknown): "TTD" | "USD" | null {
  if (v == null) return "TTD";
  const c = typeof v === "string" ? v.trim().toUpperCase() : "";
  return c === "TTD" || c === "USD" ? c : null;
}

/**
 * The offered property as one Listing. The area is the first location that isn't only a region or island word (else the first).
 * Every location name, and the optional title, go on the title, so the island and compound-name rules can read them.
 */
function offerOf(b: Record<string, unknown>): Offer | { error: string } {
  const listingType = listingTypeOf(b.listing_type);
  if (!listingType) return { error: 'listing_type must be "sale" or "rent".' };

  const list = typeof b.location === "string" ? [b.location] : Array.isArray(b.location) ? (b.location as unknown[]) : null;
  if (!list || list.some((s) => typeof s !== "string")) return { error: "location must be a string or a list of strings." };
  const names = [...new Set((list as string[]).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean))];
  if (!names.length) return { error: "location is required." };

  const price = numberOf(b.price);
  const beds = numberOf(b.bedrooms);
  const baths = numberOf(b.bathrooms);
  const limit = numberOf(b.limit);
  const currency = currencyOf(b.currency);
  if (price === undefined) return { error: "price must be a number." };
  if (beds === undefined) return { error: "bedrooms must be a number." };
  if (baths === undefined) return { error: "bathrooms must be a number." };
  if (limit === undefined || (limit !== null && (!Number.isInteger(limit) || limit < 1))) return { error: "limit must be a whole number, 1 or more." };
  if (!currency) return { error: 'currency must be "TTD" or "USD".' };
  if (b.property_type != null && typeof b.property_type !== "string") return { error: "property_type must be a string." };
  if (b.title != null && typeof b.title !== "string") return { error: "title must be a string." };
  const title = typeof b.title === "string" && b.title.trim() ? b.title.trim() : null;
  const propertyType = typeof b.property_type === "string" && b.property_type.trim() ? b.property_type.trim() : null;

  return {
    limit: Math.min(limit ?? VENDOR_DEFAULT_LIMIT, AUTOMATCH_MAX_LIMIT),
    listing: {
      id: "vendor",
      title: [title, ...names].filter(Boolean).join(", "),
      listingType,
      area: names.find((n) => !isRegionWord(n)) ?? names[0],
      price: price ?? 0,
      currency,
      beds: beds ?? 0,
      baths: baths ?? 0,
      agentId: 0,
      status: "active",
      url: "",
      propertyKind: propertyKindFromCrm(listingType, propertyType) ?? undefined,
    },
  };
}

/* ---------------- the CRM's buyers and tenants ---------------- */

/** The places a client asked for, in order: each element's value, else city, else region; a plain string is itself. Blank and repeated names are dropped. */
function placesOf(raw: readonly unknown[]): string[] {
  const names = raw.map((e) => {
    if (typeof e === "string") return placeWithoutRegion(e);
    const o = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
    const name = [o.value, o.city, o.region].find((v) => typeof v === "string" && v.trim());
    return typeof name === "string" ? placeWithoutRegion(name) : "";
  });
  return [...new Set(names.filter(Boolean))];
}

const propertyTypeOf = (c: CrmClientDemand): string | null => (c.propertyTypes[0] ?? "").trim().toLowerCase() || null;

/**
 * A client who could take the property: active, a buyer or tenant (not a vendor), with an intent that matches the property's
 * (sale for buyers, rent for tenants), at least one place, fitsOurListing, and the bathrooms floor (a listing with a known count
 * below the client's minimum is out; an unknown count passes, as elsewhere).
 */
function leadOf(c: CrmClientDemand, listing: Listing): Lead | null {
  const intent = listingTypeOf(c.listingType);
  const places = placesOf(c.preferredLocations);
  if (!intent || intent !== listing.listingType || c.status?.trim().toLowerCase() !== "active" || !c.isPurchaser || c.isVendor || !places.length) return null;
  const request: LiveRequest = {
    intent: intent === "rent" ? "rent" : "buy",
    area: null,
    beds: c.bedroomsMin,
    propertyType: propertyTypeOf(c),
    priceMin: c.budgetMin,
    priceMax: c.budgetMax,
    currency: currencyOf(c.budgetCurrency) ?? "TTD",
    monthly: false,
  };
  if (!fitsOurListing(request, listing)) return null;
  if (c.bathroomsMin != null && listing.baths > 0 && listing.baths < c.bathroomsMin) return null;
  return { client: c, intent, places };
}

/** One ask per place a client asked for: the budget range as the scorer reads it, the client's kind and beds, and the last update as the date seen. */
function askOfLead(lead: Lead, place: string, i: number): AutomatchAsk {
  const c = lead.client;
  return {
    id: `${c.id}#${i}`,
    area: place,
    beds: c.bedroomsMin,
    budget: c.budgetMax,
    budgetMin: c.budgetMin,
    currency: currencyOf(c.budgetCurrency) ?? "TTD",
    type: propertyTypeOf(c),
    listingType: lead.intent,
    lastSeenAt: c.updatedAt ?? "",
  };
}

/** The clients who could take the property (candidates), and the best place per client at FAIR or above, best first. */
async function matchClients(clients: CrmClientDemand[], listing: Listing, ctx: ScoringContext, now: Date): Promise<{ candidates: number; ranked: { pair: AutomatchPair; lead: Lead }[] }> {
  const leads = clients.flatMap((c) => {
    const lead = leadOf(c, listing);
    return lead ? [lead] : [];
  });
  const owner = new Map<string, Lead>();
  const asks = leads.flatMap((lead) =>
    lead.places.map((place, i) => {
      const ask = askOfLead(lead, place, i);
      owner.set(ask.id, lead);
      return ask;
    }),
  );
  const pairs = await automatchPairs(asks, [listing], ctx.areas, now, ctx.knowledge);
  // Best first, so the first pair of each client is its best score across its places.
  const best = new Map<string, { pair: AutomatchPair; lead: Lead }>();
  for (const pair of pairs) {
    const lead = owner.get(pair.ask.id);
    if (lead && !best.has(lead.client.id) && pair.score >= FAIR) best.set(lead.client.id, { pair, lead });
  }
  return { candidates: leads.length, ranked: [...best.values()] };
}

function clientMatchOf({ pair, lead }: { pair: AutomatchPair; lead: Lead }) {
  const c = lead.client;
  return {
    client_id: c.id,
    name: c.name,
    client_type: lead.intent === "sale" ? "buyer" : "tenant",
    intent: lead.intent === "sale" ? "buy" : "rent",
    locations: lead.places,
    budget_min: c.budgetMin,
    budget_max: c.budgetMax,
    currency: currencyOf(c.budgetCurrency) ?? "TTD",
    bedrooms_min: c.bedroomsMin,
    property_type: propertyTypeOf(c),
    score: pair.score,
    reasons: [pair.reason],
    agent_id: c.agentId == null ? null : String(c.agentId),
    status: c.status,
  };
}

/* ---------------- WhatsApp requests ---------------- */

/**
 * The demand rows that could take the property (candidates), and the best row per sender's near-identical asks at FAIR or above,
 * best first. A row with no sale or rent, or no place, is not an ask (askOf), and parked or ignored rows are left out there too.
 */
async function matchDemand(rows: SearchRow[], listing: Listing, ctx: ScoringContext, now: Date): Promise<{ candidates: number; ranked: { pair: AutomatchPair; row: SearchRow }[] }> {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const asks = rows.flatMap((r) => {
    const ask = askOf(r);
    return ask ? [ask] : [];
  });
  const eligible = asks.filter((a) => fitsOurListing(requestOf(a), listing));
  const pairs = await automatchPairs(eligible, [listing], ctx.areas, now, ctx.knowledge);
  const ranked = foldSameSenderPairs(pairs).filter((p) => p.score >= FAIR);
  return {
    candidates: eligible.length,
    ranked: ranked.flatMap((pair) => {
      const row = byId.get(pair.ask.id);
      return row ? [{ pair, row }] : [];
    }),
  };
}

/** A request's title: its beds and kind ("3 bed house"). No group name and no internal word: only the row's own facts. */
const titleOf = (row: SearchRow): string => [row.beds != null ? `${row.beds} bed` : null, row.type].filter(Boolean).join(" ") || "Request";

function demandMatchOf({ pair, row }: { pair: AutomatchPair; row: SearchRow }, publicUrl: string) {
  return {
    id: row.id,
    title: titleOf(row),
    location: row.area || row.development || null,
    budget_min: null,
    budget_max: row.price,
    currency: row.currency === "USD" ? "USD" : "TTD",
    listing_type: row.listingType === "sale" || row.listingType === "rent" ? row.listingType : null,
    property_type: row.type,
    bedrooms: row.beds,
    score: pair.score,
    reasons: [pair.reason],
    sender_name: row.senderName,
    sender_phone: row.senderPhone || null,
    posted_at: row.firstSentAt || row.lastSentAt || null,
    excerpt: excerptOf(row.originalText, row.groups),
    post_url: row.id ? `${publicUrl}/realty/posts/${encodeURIComponent(row.id)}` : null,
  };
}

/* ---------------- sources ---------------- */

const isVendorSource = (s: string): s is VendorSource => (VENDOR_SOURCES as readonly string[]).includes(s);

/** The requested sources, trimmed, lower-cased, de-duplicated in the order given. Absent (or null) is both. An empty list, or one with an unknown source, is a 400. */
function sourcesOf(raw: unknown): { list: VendorSource[] } | { error: string } {
  if (raw === undefined || raw === null) return { list: [...VENDOR_SOURCES] };
  const badSources = { error: 'sources must be a non-empty list of "crm_clients" or "whatsapp_requests".' };
  if (!Array.isArray(raw) || raw.length === 0) return badSources;
  const list: VendorSource[] = [];
  for (const s of raw) {
    const k = typeof s === "string" ? s.trim().toLowerCase() : "";
    if (!isVendorSource(k)) return badSources;
    if (!list.includes(k)) list.push(k);
  }
  return { list };
}
