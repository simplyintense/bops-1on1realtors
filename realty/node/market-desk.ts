import { runtimeEnv, type Env } from "../flow/env.ts";
import { marketDeskSearch, type DeskCriteria, type DeskResult } from "../flow/market-desk.ts";
import { marketConfigFromEnv } from "../flow/market-search.ts";
import { areasFromEnv, AreaStore, defaultAreasRoot } from "./area-store.ts";

/**
 * The staff market search with this server's settings: the area resolver (local aliases, then the market's
 * resolve_area, then exact text, as in areasFromEnv) and the market config. The page and the API both call this.
 * Reads the alias file; writes nothing.
 */
export async function staffMarketSearch(c: DeskCriteria, o: { env?: Env; fetcher?: typeof fetch; areasRoot?: string } = {}): Promise<DeskResult> {
  const env = o.env ?? runtimeEnv();
  const resolver = areasFromEnv(new AreaStore(o.areasRoot ?? defaultAreasRoot()), env, o.fetcher);
  return marketDeskSearch(c, { config: marketConfigFromEnv(env), resolver, fetcher: o.fetcher });
}
