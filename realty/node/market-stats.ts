import { runtimeEnv, type Env } from "../flow/env.ts";
import { MarketClient, marketConfigFromEnv } from "../flow/market-search.ts";
import { MarketStripCache, type MarketStrip } from "../flow/market-stats.ts";

/**
 * The market page's stats strip for this server: marketConfigFromEnv and a 10-minute in-process cache.
 * Read only; market_stats is the only tool called. Never throws: a failure is a null strip (the page hides it).
 */

type Opts = { env?: Env; fetcher?: typeof fetch; now?: number; cache?: MarketStripCache };

const cache = new MarketStripCache();

export function clearStaffMarketStripCache(): void {
  cache.clear();
}

export async function staffMarketStrip(o: Opts = {}): Promise<MarketStrip | null> {
  const cfg = marketConfigFromEnv(o.env ?? runtimeEnv());
  const caller = cfg ? new MarketClient(cfg, o.fetcher) : null;
  return (o.cache ?? cache).read(caller, o.now);
}
