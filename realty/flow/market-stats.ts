import type { ToolCaller } from "./areas.ts";
import { jsonBlock, numish } from "./requests.ts";

/**
 * The market-search page's stats strip: real totals from the read-only `market_stats` tool.
 * `listings` is `active` (the searchable market; `total` also counts inactive rows).
 * When the tool returns `areaCounts`, `areas` and `subAreas` are the official mapped totals
 * (`areaCounts.areas` / `areaCounts.subAreas`), and the with-listings figures follow the
 * filters passed to the tool. If `areaCounts` is missing, `areas` falls back to the number of
 * distinct named areas in `byArea` (leaving out "(none)") and the sub-areas tile is omitted.
 * Nothing is invented: if `active` is missing, the strip is null; a missing count is null, not 0.
 */

export const MARKET_STATS_TOOL = "market_stats";
export const MARKET_STRIP_TTL_MS = 10 * 60 * 1000;

export type MarketStrip = {
  listings: number;
  /** Official mapped areas, or the named byArea count when areaCounts is missing. */
  areas: number | null;
  /** Official mapped sub-areas from areaCounts.subAreas. Null when areaCounts is missing. */
  subAreas: number | null;
  areasWithListings: number | null;
  subAreasWithListings: number | null;
};

function namedByAreaCount(data: Record<string, unknown>): number | null {
  const byArea = data.byArea;
  if (!byArea || typeof byArea !== "object" || Array.isArray(byArea)) return null;
  return Object.keys(byArea).filter((k) => k !== "(none)").length;
}

function fromAreaCounts(raw: unknown): Omit<MarketStrip, "listings"> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const areas = numish(o.areas);
  if (areas === null) return null;
  return {
    areas,
    subAreas: numish(o.subAreas),
    areasWithListings: numish(o.areasWithListings),
    subAreasWithListings: numish(o.subAreasWithListings),
  };
}

export function stripFromStats(result: unknown): MarketStrip | null {
  const data = jsonBlock(result);
  if (!data) return null;
  const listings = numish(data.active);
  if (listings === null) return null;
  const counted = fromAreaCounts(data.areaCounts);
  if (counted) return { listings, ...counted };
  return {
    listings,
    areas: namedByAreaCount(data),
    subAreas: null,
    areasWithListings: null,
    subAreasWithListings: null,
  };
}

async function fetchStrip(caller: ToolCaller): Promise<MarketStrip | null> {
  const result = await caller.callTool(MARKET_STATS_TOOL, {});
  return stripFromStats(result);
}

/** A 10-minute cache for a successful strip. Failures do not overwrite a still-fresh value, and are not cached. */
export class MarketStripCache {
  private slot: { at: number; value: MarketStrip } | null = null;
  private readonly ttlMs: number;

  constructor(ttlMs = MARKET_STRIP_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  async read(caller: ToolCaller | null, now = Date.now()): Promise<MarketStrip | null> {
    if (this.slot && now - this.slot.at < this.ttlMs) return this.slot.value;
    if (!caller) return null;
    try {
      const value = await fetchStrip(caller);
      if (value) this.slot = { at: now, value };
      else if (this.slot) return this.slot.value;
      return value;
    } catch {
      return this.slot ? this.slot.value : null;
    }
  }

  clear(): void {
    this.slot = null;
  }
}
