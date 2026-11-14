import { parseAllowlist } from "../../lib/gate.ts";
import { runtimeEnv, type Env } from "../flow/env.ts";
import { MarketClient, marketConfigFromEnv } from "../flow/market-search.ts";
import { recommendationsFor, type DeskListing, type Recommendations } from "../flow/recommendations.ts";
import { OPEN_REQUESTS, REQUEST_LIMIT, searchRequests, type RequestCriteria, type RequestsResult } from "../flow/requests.ts";

/**
 * The staff buyer-request feed and the desk's recommendations, with this server's settings: the market config from
 * marketConfigFromEnv (as staffMarketSearch does) and BOPS_OWNER_EMAILS for the owner list. Read only; it writes nothing.
 * Never throws: a failure comes back as an error status for the page to show.
 */

type Opts = { env?: Env; fetcher?: typeof fetch };

/** How many open requests the desk reads (it only matches the newest three). */
const DESK_REQUESTS = 10;

function clientFrom(o: Opts): MarketClient | null {
  const cfg = marketConfigFromEnv(o.env ?? runtimeEnv());
  return cfg ? new MarketClient(cfg, o.fetcher) : null;
}

export async function staffRequests(c: RequestCriteria, o: Opts & { limit?: number } = {}): Promise<RequestsResult> {
  try {
    return await searchRequests(c, clientFrom(o), o.limit ?? REQUEST_LIMIT);
  } catch {
    return { status: "error", reason: "unavailable" };
  }
}

/** The desk's recommendations for the signed-in email (null when there's no session). */
export async function staffRecommendations(o: Opts & { email: string | null; listings?: DeskListing[] | null }): Promise<Recommendations> {
  const env = o.env ?? runtimeEnv();
  const caller = clientFrom({ env, fetcher: o.fetcher });
  const requests = await searchRequests(OPEN_REQUESTS, caller, DESK_REQUESTS).catch((): RequestsResult => ({ status: "error", reason: "unavailable" }));
  return recommendationsFor({
    email: o.email,
    owners: parseAllowlist(env.BOPS_OWNER_EMAILS ?? ""),
    listings: o.listings ?? null,
    requests,
    caller,
  });
}
