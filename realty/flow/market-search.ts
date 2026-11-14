import type { ToolCaller } from "./areas.ts";
import { runtimeEnv } from "./env.ts";
/**
 * Co-broke candidates: other agencies' listings from the tt-market-search MCP server, through its
 * `search_market_listings` tool. Off unless ONEON1_MARKET_SEARCH_URL and ONEON1_MARKET_SEARCH_TOKEN are
 * both set. A failure, timeout or odd reply means no candidates and a note, never an error for the
 * flow. Our own listings (source "oneonone") are dropped here: the CRM already gives us those.
 *
 * Streamable HTTP JSON-RPC: initialize, notifications/initialized, then tools/call. The reply can be
 * plain JSON or an SSE stream (`data:` lines). The tool returns two text blocks: a spoken summary, then
 * JSON {total, hits:[…]}. The token is only ever sent in the Authorization header and never logged.
 */

export type MarketCriteria = {
  listingType: "sale" | "rent" | null;
  area: string | null;
  maxPrice: { amount: number; currency: string } | null;
  beds: number | null;
};

export type CoBrokeHit = {
  title: string;
  price: number | null;
  currency: string | null;
  area: string | null;
  beds: number | null;
  baths: number | null;
  listingType: string | null;
  /** The market's normalised class (house, apartment, townhouse, land, commercial) when it has one; the lead flow doesn't use it. */
  propertyClass: string | null;
  source: string;
  url: string | null;
  /** first_seen as YYYY-MM-DD when the hit carries a date; the lead flow doesn't use it. */
  firstSeen: string | null;
  /** last_seen as YYYY-MM-DD when the hit carries a date; the lead flow doesn't use it. */
  lastSeen: string | null;
  /** Main image URL from the source site (`photo`); http(s) only. The lead flow doesn't use it. */
  photo: string | null;
};

export type MarketConfig = { url: string; token: string; timeoutMs: number };

const PROTOCOL = "2025-03-26";
const TOOL = "search_market_listings";
const MAX_HITS = 5;

export function marketConfigFromEnv(env: Record<string, string | undefined> = runtimeEnv()): MarketConfig | null {
  const url = env.ONEON1_MARKET_SEARCH_URL?.trim();
  const token = env.ONEON1_MARKET_SEARCH_TOKEN?.trim();
  if (!url || !token) return null;
  const t = Number(env.ONEON1_MARKET_SEARCH_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(15000, Math.max(500, t)) : 4000;
  return { url, token, timeoutMs };
}

/** The JSON-RPC reply with this id, from a plain JSON body or an SSE stream. Throws if there's none or it's an error. */
export function rpcResult(body: string, id: number): unknown {
  const text = body.trim();
  const messages = text.startsWith("{") ? [JSON.parse(text)] : sseMessages(text);
  const msg = messages.find((m): m is { id: number; result?: unknown; error?: unknown } => typeof m === "object" && m !== null && (m as { id?: unknown }).id === id);
  if (!msg) throw new Error("no reply");
  if (msg.error) throw new Error("server error");
  return msg.result;
}

export function sseMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // A keep-alive or non-JSON event: skip it.
    }
  }
  return out;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const day = (v: unknown) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

/** The tool's second text block (JSON with `hits`) as co-broke candidates, our own listings dropped. At most `max` (five for the lead flow). */
export function hitsFromToolResult(result: unknown, max = MAX_HITS): CoBrokeHit[] {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];
  for (const block of content) {
    const text = (block as { text?: unknown })?.text;
    if (typeof text !== "string") continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const hits = (json as { hits?: unknown })?.hits;
    if (!Array.isArray(hits)) continue;
    return hits.map(toHit).filter((h): h is CoBrokeHit => h !== null).slice(0, max);
  }
  return [];
}

function toHit(h: unknown): CoBrokeHit | null {
  const o = (h ?? {}) as Record<string, unknown>;
  const title = str(o.title);
  const source = str(o.source);
  if (!title || !source || source.toLowerCase() === "oneonone") return null;
  const money = priceOf(o.price, o.currency);
  return {
    title,
    price: money.price,
    currency: money.currency,
    area: str(o.area),
    beds: num(o.beds),
    baths: num(o.baths),
    listingType: str(o.listing_type),
    propertyClass: str(o.property_class),
    source,
    url: httpUrl(o.url),
    firstSeen: day(o.first_seen),
    lastSeen: day(o.last_seen),
    photo: httpUrl(o.photo),
  };
}

/** An http(s) URL, or null. Other schemes (javascript:, data:) are dropped. */
export function httpUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

/** A numeric price and currency, from a number or a string like "TTD 2,425,000" or "USD 1,000/month". */
export function priceOf(price: unknown, currency?: unknown): { price: number | null; currency: string | null } {
  const stated = str(currency);
  if (typeof price === "number" && Number.isFinite(price)) return { price, currency: stated };
  if (typeof price === "string") {
    const m = price.trim().match(/^([A-Za-z]{3})?\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/);
    if (!m) return { price: null, currency: stated };
    const amount = Number(m[2].replace(/,/g, ""));
    const fromText = m[1] ? m[1].toUpperCase() : null;
    return { price: Number.isFinite(amount) ? amount : null, currency: fromText ?? stated };
  }
  return { price: null, currency: stated };
}

/** TT$ / US$ when the currency is known; otherwise the raw amount (and code, if any). */
export function moneyLabel(price: number | null, currency: string | null): string | null {
  if (price === null) return null;
  const n = price.toLocaleString("en-US");
  const c = (currency ?? "").toUpperCase();
  if (c === "TTD") return `TT$${n}`;
  if (c === "USD") return `US$${n}`;
  return c ? `${c} ${n}` : n;
}

/** The server's schema: optional listing_type, area, price_max, beds_min, limit. Prices there mix TTD and USD, so only a TTD budget caps price. */
export function toolArguments(c: MarketCriteria): Record<string, string | number> {
  const args: Record<string, string | number> = { limit: MAX_HITS * 2 };
  if (c.listingType) args.listing_type = c.listingType;
  if (c.area) args.area = c.area;
  if (c.maxPrice && c.maxPrice.currency === "TTD") args.price_max = c.maxPrice.amount;
  if (c.beds) args.beds_min = c.beds;
  return args;
}

/**
 * The Streamable HTTP JSON-RPC client for tt-market-search. One callTool(name, args) is initialize, the
 * initialized notice, then tools/call. Failures (HTTP, JSON-RPC, a tool error, a timeout) throw; the callers
 * decide what that means (MarketSearch: a note; the area resolver: fall back to exact text). Used for
 * search_market_listings and resolve_area (the lead flow and the market search page), for market_stats on the
 * market page strip (realty/flow/market-stats.ts), and for the staff desk's read-only tools: search_market_requests,
 * match_buyer, match_requests and score_matches (realty/flow/requests.ts DESK_TOOLS, which refuses any other name).
 * Those only read: none of them writes. Never called from here:
 * learn_area_alias, learn_area_neighbour and register_market_optout. Staff aliases go to market-ingest (periskope.ts),
 * and neighbour learning stays local (area-learning.ts); neither is a call from here.
 */
export class MarketClient implements ToolCaller {
  private readonly cfg: MarketConfig;
  private readonly fetcher: typeof fetch;

  constructor(cfg: MarketConfig, fetcher: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetcher = fetcher;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const init = await this.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "1on1-lead-flow", version: "1" } } }, null);
    rpcResult(init.text, 1);
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
    const call = await this.post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, init.session);
    const result = rpcResult(call.text, 2) as { isError?: boolean } | undefined;
    if (result?.isError) throw new Error("tool error");
    return result;
  }

  private async post(body: object, session: string | null): Promise<{ text: string; session: string | null }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL,
    };
    if (session) headers["mcp-session-id"] = session;
    const r = await this.fetcher(this.cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { text: await r.text(), session: r.headers.get("mcp-session-id") ?? session };
  }
}

export class MarketSearch {
  private readonly client: MarketClient;

  constructor(cfg: MarketConfig, fetcher: typeof fetch = fetch) {
    this.client = new MarketClient(cfg, fetcher);
  }

  /** Never throws. Returns the candidates and a one-line note for the agent's alert. */
  async search(c: MarketCriteria): Promise<{ hits: CoBrokeHit[]; note: string }> {
    try {
      const hits = hitsFromToolResult(await this.client.callTool(TOOL, toolArguments(c)));
      return { hits, note: hits.length ? `${hits.length} from other agencies` : "none found at other agencies" };
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
      return { hits: [], note: `other agencies not checked (${timedOut ? "timed out" : "unavailable"})` };
    }
  }
}
