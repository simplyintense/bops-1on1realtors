import { createHash, timingSafeEqual } from "node:crypto";
import { areaKey } from "../flow/areas.ts";
import { publicBaseUrl } from "../flow/admin-digest.ts";
import type { DeskCriteria, DeskResult, PropertyType } from "../flow/market-desk.ts";
import { parseListingType } from "../flow/knowledge.ts";
import type { CoBrokeHit } from "../flow/market-search.ts";
import { staffMarketSearch } from "./market-desk.ts";
import { requestIdOf } from "./periskope-store.ts";
import { SearchInputError, searchInputFrom, withSearchStore, type Side, type SearchInput, type SearchRow } from "./search-store.ts";

/**
 * The read-only search the 1on1 Realtors staff MCP calls, server to server, so signed-in realtors can search the WhatsApp
 * supply and demand from ChatGPT. It is not behind the Google gate: it proves itself by a bearer token (BOPS_MCP_TOKEN) and
 * nothing else. Every signed-in 1on1 staff user gets the same data: the MCP does its own sign-in and role check, and this
 * endpoint does not look at X-1on1-Role, X-1on1-User or a full param. The routes (app/api/realty/agent-search/) are thin
 * wrappers over the handlers here.
 *
 * What an agent gets for a WhatsApp row: the allow-list below (sender name and phone, dates, the parsed fields, the notes
 * clipped, the firm) and deskUrl, the desk page of the original message. Never the original text, the group or group name,
 * the chat id, the message ids, the explanation, status, priority or category. Ignored and parked rows are never returned or
 * counted.
 *
 * Supply also carries other agencies' listings from the external-sites market search (staffMarketSearch, the same call the
 * staff market page makes), when source is "external" or "all". Those rows are asked for on the first page only, after the
 * WhatsApp rows, and carry the listing agent's contact.
 *
 * Nothing here is written, sent or logged. The token is compared in constant time and never echoed.
 */

export type Env = Record<string, string | undefined>;
export type AgentReply = { status: number; body: Record<string, unknown> };

export const AGENT_SEARCH_DEFAULT_LIMIT = 10;
export const AGENT_SEARCH_MAX_LIMIT = 50;
export const AGENT_NOTES_MAX = 280;
export const AGENT_SNAPSHOT_MAX_GROUPS = 100;

/** The fields a WhatsApp row carries from the store. Built by picking these keys, never by deleting others. */
export const AGENT_ROW_KEYS = [
  "id",
  "kind",
  "senderName",
  "senderPhone",
  "firstSentAt",
  "lastSentAt",
  "timesSeen",
  "area",
  "development",
  "price",
  "currency",
  "beds",
  "baths",
  "type",
  "listingType",
  "intent",
  "propertyClass",
  "notes",
  "firm",
] as const;

/** A WhatsApp row as the agent sees it: the picked fields, the source, and the link to the original message in the desk. */
export type AgentRow = Pick<SearchRow, (typeof AGENT_ROW_KEYS)[number]> & { source: "whatsapp"; deskUrl: string | null };

export type SnapshotGroup = {
  area: string;
  type: string | null;
  listingType: string | null;
  currency: string | null;
  count: number;
  minPrice: number | null;
  medianPrice: number | null;
  maxPrice: number | null;
};

/** The request parts the handlers read. Only the bearer header is passed in: nothing else of the request is touched. */
export type AgentRequest = { authorization: string | null; params: URLSearchParams };

/* ---------------- auth ---------------- */

/** Equal secrets, in constant time. Both sides are hashed first, so a different length is just a mismatch, never a throw. */
export function sameSecret(got: string, want: string): boolean {
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>` against BOPS_MCP_TOKEN. A missing or blank env var never matches. */
export function bearerOk(authorization: string | null, env: Env): boolean {
  const want = (env.BOPS_MCP_TOKEN ?? "").trim();
  if (!want) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return !!m && sameSecret(m[1], want);
}

const UNAUTHORIZED: AgentReply = { status: 401, body: { error: "Unauthorized." } };

/* ---------------- rows ---------------- */

function clipNotes(s: string | null): string | null {
  if (s == null) return null;
  return s.length > AGENT_NOTES_MAX ? `${s.slice(0, AGENT_NOTES_MAX - 1)}…` : s;
}

/**
 * The desk page of a WhatsApp record's original message: the existing per-post page (app/realty/posts/[messageId]), by the
 * same requestIdOf the Supply & Demand page links with. A record seen in several messages links to its first. Null when the
 * record has no message. The page itself is owners-only today (see the route's doc).
 */
export function deskPostUrl(base: string, messageIds: readonly string[]): string | null {
  const first = messageIds[0];
  return first ? `${base}/realty/posts/${requestIdOf(first)}` : null;
}

/** The WhatsApp row: exactly AGENT_ROW_KEYS, the notes clipped, and the source and deskUrl. Never the text, group or chat. */
export function agentRow(row: SearchRow, base: string): AgentRow {
  const out = {} as Record<(typeof AGENT_ROW_KEYS)[number], unknown>;
  for (const key of AGENT_ROW_KEYS) out[key] = row[key];
  out.notes = clipNotes(row.notes);
  return { ...out, source: "whatsapp", deskUrl: deskPostUrl(base, row.messageIds) } as AgentRow;
}

/* ---------------- parameters ---------------- */

/** The people filters search by phone, name or group: not on this endpoint. Present and non-blank is a 400. */
function peopleFilter(params: URLSearchParams): string | null {
  for (const k of ["agent", "group"]) if (params.get(k)?.trim()) return k;
  return null;
}

function kindParam(params: URLSearchParams): Side | null {
  const raw = params.get("kind")?.trim() || "supply";
  return raw === "supply" || raw === "demand" ? raw : null;
}

function limitParam(params: URLSearchParams): number | null {
  const raw = params.get("limit")?.trim();
  if (!raw) return AGENT_SEARCH_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, AGENT_SEARCH_MAX_LIMIT);
}

const bad = (error: string): AgentReply => ({ status: 400, body: { error } });

/* ---------------- external listings (the market search) ---------------- */

export type ExternalStatus = "ok" | "not-configured" | "error" | "skipped";
export type ExternalSource = "whatsapp" | "external" | "all";
export const AGENT_PROPERTY_TYPES: readonly PropertyType[] = ["house", "apartment", "townhouse", "land", "commercial"];
const PRICE_TOLERANCE = 0.02;

/** A market hit in the supply row shape: the listing's own fields, the site and url, and the listing agent's contact. */
export type ExternalAgentRow = {
  id: string;
  kind: "supply";
  area: string | null;
  development: null;
  price: number | null;
  currency: string | null;
  beds: number | null;
  baths: number | null;
  type: string | null;
  listingType: string | null;
  intent: null;
  propertyClass: string | null;
  notes: string | null;
  firstSentAt: string | null;
  lastSentAt: string | null;
  timesSeen: 1;
  firm: string | null;
  source: "external";
  site: string;
  url: string | null;
  photo: string | null;
  agent: string | null;
  agentPhone: string | null;
  agentWhatsapp: string | null;
  agentEmail: string | null;
  /** External listings have no desk page: there is no WhatsApp message to show. */
  deskUrl: null;
};

export type AlsoListedOn = { site: string; url: string | null };
/** A WhatsApp row on the page; alsoListedOn is set when an external listing matches it (mergeExternal). */
export type DeskRow = AgentRow & { alsoListedOn?: AlsoListedOn[] };

/** The fields two listings are compared on. */
export type ListingKey = { area: string | null; listingType: string | null; beds: number | null; price: number | null; currency: string | null };

/** The market hit as a supply row, with its title as the notes (clipped like the WhatsApp notes). */
export function externalRow(h: CoBrokeHit): ExternalAgentRow {
  return {
    id: `ext:${createHash("sha256").update(h.url ?? `${h.source}\n${h.title}`).digest("hex").slice(0, 16)}`,
    kind: "supply",
    area: h.area,
    development: null,
    price: h.price,
    currency: h.currency,
    beds: h.beds,
    baths: h.baths,
    type: h.propertyClass,
    listingType: h.listingType,
    intent: null,
    propertyClass: h.propertyClass,
    notes: clipNotes(h.title),
    firstSentAt: h.firstSeen,
    lastSentAt: h.lastSeen,
    timesSeen: 1,
    firm: h.agency ?? null,
    source: "external",
    site: h.source,
    url: h.url,
    photo: h.photo,
    agent: h.agent ?? null,
    agentPhone: h.agentPhone ?? null,
    agentWhatsapp: h.agentWhatsapp ?? null,
    agentEmail: h.agentEmail ?? null,
    deskUrl: null,
  };
}

/**
 * The market request for a supply search, or the reason there isn't one. Only the market's own filters are sent (area or
 * development, price, beds, type, listing type). `q` is not one of them, so it is applied to the hits here. Dates have no
 * market meaning, shortlet isn't on the market, and an unknown type can't be asked for: those skip. With no area and no
 * other market filter the market would be searched with nothing, so that skips too.
 */
export function externalPlan(input: SearchInput): { criteria: DeskCriteria; words: string[] } | { skip: string } {
  if (input.from || input.to) return { skip: "Date filters do not apply to external listings." };
  if (input.listingType === "shortlet") return { skip: "Shortlet listings are not on the market search." };
  let propertyType: PropertyType | null = null;
  if (input.type) {
    propertyType = AGENT_PROPERTY_TYPES.find((t) => t === input.type!.toLowerCase()) ?? null;
    if (!propertyType) return { skip: "That property type is not on the market search." };
  }
  const area = (input.area || input.development || "").trim();
  const otherFilter = [input.minPrice, input.maxPrice, input.beds, input.type, input.listingType].some((v) => v !== undefined && v !== null);
  if (!area && !otherFilter) return { skip: "Give an area or a development (or a price, beds, type or listing type) to search external listings." };
  return {
    criteria: {
      area,
      nearby: false,
      listingType: input.listingType === "sale" || input.listingType === "rent" ? input.listingType : null,
      bedsMin: input.beds ?? null,
      bedsMax: null,
      priceMin: input.minPrice ?? null,
      priceMax: input.maxPrice ?? null,
      propertyType,
      currency: "any",
    },
    words: (input.q ?? "").toLowerCase().split(/\s+/).filter(Boolean),
  };
}

/** Every q word is in the hit's title or area, case-insensitively. */
export function matchesWords(h: CoBrokeHit, words: string[]): boolean {
  const hay = `${h.title} ${h.area ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

const lc = (s: string | null) => (s == null ? null : s.trim().toLowerCase() || null);

/**
 * The same listing, for dedupe: the same normalized area, listing type and beds (or both no beds), and a price within 2% in
 * the same currency. Either side without an area or a price is never the same. Site is not compared.
 */
export function sameListing(a: ListingKey, b: ListingKey): boolean {
  const areaA = a.area ? areaKey(a.area) : "";
  if (!areaA || areaA !== (b.area ? areaKey(b.area) : "")) return false;
  if (lc(a.listingType) !== lc(b.listingType)) return false;
  if ((a.beds ?? null) !== (b.beds ?? null)) return false;
  if (a.price == null || b.price == null) return false;
  if ((lc(a.currency) ?? "") !== (lc(b.currency) ?? "")) return false;
  return Math.abs(a.price - b.price) <= PRICE_TOLERANCE * Math.max(Math.abs(a.price), Math.abs(b.price));
}

/**
 * Drops the external hits the page already has. An external hit that matches a WhatsApp row on the page is dropped and
 * recorded on that row as alsoListedOn (site and url, once each). Among the external hits, the first of a match is kept:
 * the same url, or the same listing as sameListing. Pure: the inputs are not changed.
 */
export function mergeExternal<T extends ListingKey & { alsoListedOn?: AlsoListedOn[] }>(
  desk: T[],
  external: ExternalAgentRow[],
): { desk: T[]; external: ExternalAgentRow[] } {
  const out = desk.map((r) => ({ ...r }));
  const kept: ExternalAgentRow[] = [];
  for (const ext of external) {
    const match = out.find((d) => sameListing(d, ext));
    if (match) {
      const list = match.alsoListedOn ?? [];
      if (!list.some((x) => x.site === ext.site && x.url === ext.url)) match.alsoListedOn = [...list, { site: ext.site, url: ext.url }];
      continue;
    }
    if (kept.some((k) => (ext.url !== null && k.url === ext.url) || sameListing(k, ext))) continue;
    kept.push(ext);
  }
  return { desk: out, external: kept };
}

/** What the market search is asked through. The default is staffMarketSearch with this server's settings; tests pass a fake. */
export type AgentDeps = { market?: (c: DeskCriteria) => Promise<DeskResult> };

function sourceParam(params: URLSearchParams): ExternalSource | null {
  const raw = params.get("source")?.trim() || "all";
  return raw === "whatsapp" || raw === "external" || raw === "all" ? raw : null;
}

/** The market hits for this request, with the status the response reports. Never throws: a failure is a status, not an error. */
async function externalListings(input: SearchInput, offset: number, deps: AgentDeps, env: Env): Promise<{ status: ExternalStatus; reason?: string; hits: CoBrokeHit[] }> {
  if (offset > 0) return { status: "skipped", reason: "External listings are only on the first page.", hits: [] };
  const plan = externalPlan(input);
  if ("skip" in plan) return { status: "skipped", reason: plan.skip, hits: [] };
  const market = deps.market ?? ((c: DeskCriteria) => staffMarketSearch(c, { env }));
  let res: DeskResult;
  try {
    res = await market(plan.criteria);
  } catch {
    return { status: "error", reason: "The market search failed.", hits: [] };
  }
  if (res.status === "not-configured") return { status: "not-configured", reason: "The market search is not set up on this server.", hits: [] };
  if (res.status === "error") return { status: "error", reason: res.reason === "timeout" ? "The market search timed out." : "The market search is unavailable.", hits: [] };
  const hits = plan.words.length ? res.listings.filter((h) => matchesWords(h, plan.words)) : res.listings;
  return { status: "ok", reason: res.failed > 0 ? "Some area searches failed; the listings shown may be incomplete." : undefined, hits };
}

/* ---------------- GET /api/realty/agent-search ---------------- */

/**
 * source: whatsapp (the WhatsApp rows only), external (market listings only) or all (default). Only supply has external
 * listings: kind=demand with source=external is a 400, and demand ignores them. external and totals are in the reply for
 * supply unless source=whatsapp. total stays the WhatsApp total, for paging. A `full` param is ignored, as are the
 * X-1on1-Role and X-1on1-User headers: every signed-in staff user gets the same rows.
 */
export async function agentSearch(req: AgentRequest, root: string, env: Env, deps: AgentDeps = {}): Promise<AgentReply> {
  if (!bearerOk(req.authorization, env)) return UNAUTHORIZED;
  const { params } = req;
  const base = publicBaseUrl(env);

  const kind = kindParam(params);
  if (!kind) return bad("kind must be supply or demand.");
  if (peopleFilter(params)) return bad("The agent and group filters are not available on this search.");
  const limit = limitParam(params);
  if (limit == null) return bad("limit must be a whole number.");
  const source = sourceParam(params);
  if (!source) return bad("source must be whatsapp, external or all.");
  if (kind === "demand" && source === "external") return bad("External listings are supply only: use kind=supply.");

  // searchInputFrom reads the shared filters (and validates them); limit, offset and the flags are set here, so the
  // endpoint's own caps (and the default) apply. A copy, so the request's params are left as they came.
  const shared = new URLSearchParams(params);
  for (const k of ["kind", "limit", "agent", "group", "full", "source"]) shared.delete(k);
  let input: SearchInput;
  try {
    input = searchInputFrom(shared);
  } catch (e) {
    if (e instanceof SearchInputError) return bad(e.message);
    throw e;
  }
  const offset = input.offset ?? 0;
  const result = withSearchStore(root, (store) => store.search({ ...input, kind, limit, offset, excludeStatus: true }));
  const desk: DeskRow[] = source === "external" ? [] : result.rows.map((r) => agentRow(r, base));

  if (kind !== "supply" || source === "whatsapp") {
    return { status: 200, body: { kind, total: result.total, limit, offset, rows: desk } };
  }

  const ext = await externalListings(input, offset, deps, env);
  const merged = mergeExternal(desk, ext.hits.map(externalRow));
  const extRows = merged.external.slice(0, Math.max(0, limit - merged.desk.length));
  const external: Record<string, unknown> = { status: ext.status, returned: extRows.length };
  if (ext.reason) external.reason = ext.reason;
  return {
    status: 200,
    body: {
      kind,
      total: result.total,
      limit,
      offset,
      rows: [...merged.desk, ...extRows],
      totals: { whatsapp: result.total, external: merged.external.length },
      external,
    },
  };
}

/* ---------------- GET /api/realty/agent-search/snapshot ---------------- */

/**
 * Aggregates rows into market groups: by area, type, listing type and currency. Rows with no area are left out, as are rows
 * the caller has already dropped (ignored, parked). Prices come only from rows that have one; count counts every row in
 * the group. Largest count first, then a fixed order, so the same data always gives the same list.
 */
export function snapshotGroups(
  rows: { area: string | null; type: string | null; listingType: string | null; currency: string | null; price: number | null }[],
  limit = AGENT_SNAPSHOT_MAX_GROUPS,
): SnapshotGroup[] {
  const groups = new Map<string, { area: string; type: string | null; listingType: string | null; currency: string | null; count: number; prices: number[] }>();
  for (const r of rows) {
    const area = r.area?.trim();
    if (!area) continue;
    const type = r.type ?? null;
    const listingType = r.listingType ?? null;
    const currency = r.currency ?? null;
    const key = JSON.stringify([area, type, listingType, currency]);
    let g = groups.get(key);
    if (!g) {
      g = { area, type, listingType, currency, count: 0, prices: [] };
      groups.set(key, g);
    }
    g.count++;
    if (r.price != null && Number.isFinite(r.price)) g.prices.push(r.price);
  }
  const out = [...groups.values()].map((g): SnapshotGroup => {
    const prices = g.prices.sort((a, b) => a - b);
    const n = prices.length;
    const medianPrice = n === 0 ? null : n % 2 === 1 ? prices[(n - 1) / 2] : (prices[n / 2 - 1] + prices[n / 2]) / 2;
    return {
      area: g.area,
      type: g.type,
      listingType: g.listingType,
      currency: g.currency,
      count: g.count,
      minPrice: n ? prices[0] : null,
      medianPrice,
      maxPrice: n ? prices[n - 1] : null,
    };
  });
  const cmp = (a: string | null, b: string | null) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0);
  out.sort((a, b) => b.count - a.count || cmp(a.area, b.area) || cmp(a.type, b.type) || cmp(a.listingType, b.listingType) || cmp(a.currency, b.currency));
  return out.slice(0, limit);
}

export function agentSnapshot(req: AgentRequest, root: string, env: Env): AgentReply {
  if (!bearerOk(req.authorization, env)) return UNAUTHORIZED;
  const { params } = req;

  const kind = kindParam(params);
  if (!kind) return bad("kind must be supply or demand.");
  if (peopleFilter(params)) return bad("The agent and group filters are not available on this search.");

  // The same date and listing-type rules as the search (searchInputFrom), on the three filters this endpoint takes.
  const shared = new URLSearchParams();
  for (const k of ["from", "to", "listingType", "area"]) {
    const v = params.get(k);
    if (v !== null) shared.set(k, v);
  }
  if (params.get("listingType")?.trim() && parseListingType(params.get("listingType")) == null) return bad("listingType must be sale, rent or shortlet.");
  let input: SearchInput;
  try {
    input = searchInputFrom(shared);
  } catch (e) {
    if (e instanceof SearchInputError) return bad(e.message);
    throw e;
  }
  const rows = withSearchStore(root, (store) => store.snapshotRows({ kind, area: input.area, listingType: input.listingType, from: input.from, to: input.to }));
  return { status: 200, body: { kind, groups: snapshotGroups(rows) } };
}
