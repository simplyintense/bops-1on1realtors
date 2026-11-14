import type { ToolCaller } from "./areas.ts";
import { jsonBlock, numish } from "./requests.ts";

/**
 * The market-search page's stats strip: real totals from the read-only `market_stats` tool.
 * `listings` is `active` (the searchable market; `total` also counts inactive rows). `areas` is the number of
 * distinct named areas in `byArea`, leaving out the tool's "(none)" bucket. Sub-areas are not in the tool's
 * reply, so they are not on the strip. Nothing is invented: if `active` is missing, the strip is null.
 */

export const MARKET_STATS_TOOL = "market_stats";
export const MARKET_STRIP_TTL_MS = 10 * 60 * 1000;

export type MarketStrip = {
  listings: number;
  /** Distinct named areas on active listings, or null when byArea is missing. */
  areas: number | null;
};

export function stripFromStats(result: unknown): MarketStrip | null {
  const data = jsonBlock(result);
  if (!data) return null;
  const listings = numish(data.active);
  if (listings === null) return null;
  const byArea = data.byArea;
  if (!byArea || typeof byArea !== "object" || Array.isArray(byArea)) {
    return { listings, areas: null };
  }
  const areas = Object.keys(byArea).filter((k) => k !== "(none)").length;
  return { listings, areas };
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
