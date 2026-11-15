import type { ToolCaller } from "./areas.ts";
import { moneyLabel } from "./market-search.ts";

/**
 * The buyer-request feed for staff (app/realty/requests, and the desk's recommendations): co-broke buyer requests from the
 * market's search_market_requests tool, through MarketClient (market-search.ts). Read only.
 *
 * DESK_TOOLS is the whole list of market tools the staff desk may call. readOnlyCall refuses anything else, so
 * learn_area_alias, learn_area_neighbour and register_market_optout can't be reached from here, and nothing here writes.
 *
 * Privacy: a row is built from an allowlist of fields. Buyer and seller names, sender phone numbers, source_message_id,
 * group_ref and free-text notes are never copied into a row, so they can't reach a page. Rows are what the market returned;
 * nothing is invented, and zero hits is an honest empty state.
 *
 * Portable: no node:*, no next, no bare process.
 */

/** The only market tools the staff desk may call. Anything else is refused by readOnlyCall. */
export const DESK_TOOLS = ["search_market_requests", "match_buyer", "match_requests", "score_matches"] as const;
export type DeskTool = (typeof DESK_TOOLS)[number];

export async function readOnlyCall(caller: ToolCaller, name: DeskTool, args: Record<string, unknown>): Promise<unknown> {
  if (!(DESK_TOOLS as readonly string[]).includes(name)) throw new Error("not a read-only desk tool");
  return caller.callTool(name, args);
}

/* ---------------- Criteria (the page's query params) ---------------- */

export const STATUSES = ["open", "matched", "closed", "any"] as const;
export type RequestStatus = (typeof STATUSES)[number];
export type Intent = "buy" | "rent";

export type RequestCriteria = {
  query: string;
  intent: Intent | null;
  area: string;
  priceMin: number | null;
  priceMax: number | null;
  bedsMin: number | null;
  status: RequestStatus;
};

/** The feed's default: open requests only. */
export const OPEN_REQUESTS: RequestCriteria = { query: "", intent: null, area: "", priceMin: null, priceMax: null, bedsMin: null, status: "open" };

/** The most rows the market is asked for (the tool's cap). */
export const REQUEST_LIMIT = 20;

const clean = (v: string | null | undefined, max: number) => (v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const amount = (v: string | null): number | null => {
  const t = (v ?? "").trim();
  const n = Number(t);
  return t && Number.isFinite(n) && n >= 0 ? n : null;
};

/** The criteria from a query string. Anything unreadable is "not set"; the status defaults to open. */
export function requestCriteriaFromParams(p: URLSearchParams): RequestCriteria {
  const intent = p.get("intent");
  const beds = amount(p.get("bedsMin"));
  return {
    query: clean(p.get("q"), 80),
    intent: intent === "buy" || intent === "rent" ? intent : null,
    area: clean(p.get("area"), 80),
    priceMin: amount(p.get("priceMin")),
    priceMax: amount(p.get("priceMax")),
    bedsMin: beds === null ? null : Math.floor(beds),
    status: STATUSES.find((s) => s === p.get("status")) ?? "open",
  };
}

/** The arguments for search_market_requests. Only the filters that are set are sent. */
const clampLimit = (n: number) => Math.min(REQUEST_LIMIT, Math.max(1, Math.floor(n)));

export function requestArgs(c: RequestCriteria, limit = REQUEST_LIMIT): Record<string, unknown> {
  const args: Record<string, unknown> = { status: c.status, limit: clampLimit(limit) };
  if (c.query) args.query = c.query;
  if (c.intent) args.intent = c.intent;
  if (c.area) args.area = c.area;
  if (c.priceMin !== null) args.price_min = c.priceMin;
  if (c.priceMax !== null) args.price_max = c.priceMax;
  if (c.bedsMin !== null) args.beds_min = c.bedsMin;
  return args;
}

/* ---------------- Rows ---------------- */

export type BuyerRequest = {
  /** The market's request id, the ref for match_buyer. Not shown on a page. */
  ref: string | null;
  /** received_at (or created_at) as an ISO instant. */
  receivedAt: string | null;
  intent: Intent | null;
  area: string | null;
  propertyType: string | null;
  bedsMin: number | null;
  bathsMin: number | null;
  priceMin: number | null;
  priceMax: number | null;
  /** TTD or USD as the market gives it, or null. */
  currency: string | null;
  status: string | null;
  /** The agency that sent the request. */
  agency: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A number, or a numeric string (the market may send decimals as text). */
export function numish(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

const instant = (v: unknown): string | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** One hit as a row, from the allowlist of fields only. null if the hit has nothing to show. */
export function requestRow(h: unknown): BuyerRequest | null {
  const o = (h ?? {}) as Record<string, unknown>;
  const ref = str(o.id) ?? (typeof o.id === "number" ? String(o.id) : null);
  const receivedAt = instant(o.received_at) ?? instant(o.created_at);
  const intent = o.intent === "buy" || o.intent === "rent" ? o.intent : null;
  const area = str(o.area);
  if (!ref && !receivedAt && !intent && !area) return null;
  return {
    ref,
    receivedAt,
    intent,
    area,
    propertyType: str(o.property_type),
    bedsMin: numish(o.beds_min),
    bathsMin: numish(o.baths_min),
    priceMin: numish(o.price_min),
    priceMax: numish(o.price_max),
    currency: str(o.currency)?.toUpperCase() ?? null,
    status: str(o.status),
    agency: str(o.sender_agency),
  };
}

/** The first JSON object in a tools/call text block, or null. Used for market_stats (no hits array) and for match tools. */
export function jsonBlock(result: unknown): Record<string, unknown> | null {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const text = (block as { text?: unknown } | null)?.text;
    if (typeof text !== "string") continue;
    try {
      const json = JSON.parse(text) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) return json as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The rows in a tools/call result. search_market_requests uses `hits`; match_buyer and score_matches use `matches`;
 * match_requests uses `requests[].matches`. null if none of those is present.
 */
export function jsonHits(result: unknown): unknown[] | null {
  const data = jsonBlock(result);
  if (!data) return null;
  if (Array.isArray(data.hits)) return data.hits;
  if (Array.isArray(data.matches)) return data.matches;
  if (Array.isArray(data.requests)) {
    const rows: unknown[] = [];
    for (const r of data.requests) {
      const matches = r && typeof r === "object" && !Array.isArray(r) ? (r as { matches?: unknown }).matches : null;
      if (Array.isArray(matches)) rows.push(...matches);
    }
    return rows;
  }
  return null;
}

/** The budget: the top of the range, or the bottom if that's all there is. Raw amounts (the market compares raw amounts too). */
export function budgetOf(r: BuyerRequest): number | null {
  return r.priceMax ?? r.priceMin;
}

/** "TT$1,000,000 – TT$1,500,000", "up to TT$1,500,000", "from TT$1,000,000", or null when there's no budget. */
export function budgetLabel(r: BuyerRequest): string | null {
  const label = (n: number) => moneyLabel(n, r.currency) ?? String(n);
  const lo = r.priceMin;
  const hi = r.priceMax;
  if (lo !== null && hi !== null) return lo === hi ? label(lo) : `${label(lo)} – ${label(hi)}`;
  if (hi !== null) return `up to ${label(hi)}`;
  if (lo !== null) return `from ${label(lo)}`;
  return null;
}

/* ---------------- Sorting ---------------- */

export const SORT_KEYS = ["date", "area", "budget", "beds"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";
export type Sort = { key: SortKey; dir: SortDir };

/** sort and dir from the query string. The default is the date, newest first. */
export function sortFromParams(p: URLSearchParams): Sort {
  const key = SORT_KEYS.find((k) => k === p.get("sort")) ?? "date";
  const d = p.get("dir");
  const dir: SortDir = d === "asc" || d === "desc" ? d : key === "date" ? "desc" : "asc";
  return { key, dir };
}

function sortValue(r: BuyerRequest, key: SortKey): number | string | null {
  switch (key) {
    case "date":
      return r.receivedAt ? Date.parse(r.receivedAt) : null;
    case "area":
      return r.area ? r.area.toLowerCase() : null;
    case "budget":
      return budgetOf(r);
    case "beds":
      return r.bedsMin;
  }
}

function compare(a: number | string, b: number | string): number {
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
}

/** Sorts the rows given. Rows with no value for the key go last in either direction; ties keep the market's order. */
export function sortRequests(rows: BuyerRequest[], s: Sort): BuyerRequest[] {
  const sign = s.dir === "asc" ? 1 : -1;
  return rows
    .map((r, i) => ({ r, i, v: sortValue(r, s.key) }))
    .sort((a, b) => {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      const c = compare(a.v, b.v) * sign;
      return c !== 0 ? c : a.i - b.i;
    })
    .map((x) => x.r);
}

/* ---------------- Search ---------------- */

export type RequestsResult =
  | { status: "owners-only" }
  | { status: "not-configured" }
  | { status: "error"; reason: "timeout" | "unavailable" }
  | { status: "ok"; rows: BuyerRequest[] };

/** A timeout from the fetch (TimeoutError from AbortSignal.timeout, or AbortError). */
export const timedOut = (err: unknown): boolean => {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
};

/**
 * The buyer requests, read from the market. Never throws: no caller is "not-configured"; a failed call, a tool error or an
 * unreadable reply is an error. Zero hits is "ok" with no rows, which the page says honestly.
 */
export async function searchRequests(c: RequestCriteria, caller: ToolCaller | null, limit = REQUEST_LIMIT): Promise<RequestsResult> {
  if (!caller) return { status: "not-configured" };
  let result: unknown;
  try {
    result = await readOnlyCall(caller, "search_market_requests", requestArgs(c, limit));
  } catch (err) {
    return { status: "error", reason: timedOut(err) ? "timeout" : "unavailable" };
  }
  const hits = jsonHits(result);
  if (!hits) return { status: "error", reason: "unavailable" };
  const rows = hits.slice(0, clampLimit(limit)).flatMap((h) => {
    const r = requestRow(h);
    return r ? [r] : [];
  });
  return { status: "ok", rows };
}
