import { join } from "node:path";
import { emailAllowed, parseAllowlist } from "../../lib/gate.ts";
import { crmSeam, type CrmListingsState, type CrmSeam } from "../flow/crm-seam.ts";
import { digestOf, liveDesk, type Digest, type LiveDesk } from "../flow/live-match.ts";
import { runtimeEnv, type Env } from "../flow/env.ts";
import { MarketClient, marketConfigFromEnv } from "../flow/market-search.ts";
import { recommendationsFor, type DeskListing, type Recommendations } from "../flow/recommendations.ts";
import { PeriskopeStore } from "./periskope-store.ts";
import { OPEN_REQUESTS, REQUEST_LIMIT, searchRequests, type RequestCriteria, type RequestsResult } from "../flow/requests.ts";

/**
 * The staff buyer-request feed and the desk's recommendations, with this server's settings: the market config from
 * marketConfigFromEnv (as staffMarketSearch does) and BOPS_OWNER_EMAILS for the owner list. Read only; it writes nothing.
 * Never throws: a failure comes back as an error status for the page to show.
 */

type Opts = { env?: Env; fetcher?: typeof fetch };

/** Where the Periskope intake keeps its files (realty/node/periskope-intake.ts uses the same default). */
export const defaultIntakeRoot = () => join(process.cwd(), ".data", "realty", "periskope");

/** The desk: the market-side recommendations, the live WhatsApp side, and what the CRM seam said about our listings. */
export type DeskView = Recommendations & { live: LiveDesk; crm: CrmListingsState["status"] };

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

/**
 * The desk's recommendations for the signed-in email (null when there's no session). Owners get the market side (other
 * agencies' requests); everyone gets their own WhatsApp requests' live matches once the CRM seam knows their number.
 * Our listings come from the CRM seam (not connected yet). `intakeRoot` and `seam` are for tests.
 */
export async function staffRecommendations(o: Opts & { email: string | null; listings?: DeskListing[] | null; intakeRoot?: string; seam?: CrmSeam }): Promise<DeskView> {
  const env = o.env ?? runtimeEnv();
  const seam = o.seam ?? crmSeam();
  const crm = await seam.listings().catch((): CrmListingsState => ({ status: "not-connected", text: "" }));
  const owners = parseAllowlist(env.BOPS_OWNER_EMAILS ?? "");
  const caller = clientFrom({ env, fetcher: o.fetcher });
  // Only an owner gets the market side, so only an owner's desk reads the market's requests.
  const owner = !!o.email && emailAllowed(o.email, owners);
  const requests: RequestsResult = owner
    ? await searchRequests(OPEN_REQUESTS, caller, DESK_REQUESTS).catch((): RequestsResult => ({ status: "error", reason: "unavailable" }))
    : { status: "ok", rows: [] };
  const recs = await recommendationsFor({
    email: o.email,
    owners,
    listings: o.listings ?? (crm.status === "ok" ? crm.listings : null),
    requests,
    caller,
  });
  const rows = new PeriskopeStore(o.intakeRoot ?? defaultIntakeRoot()).live();
  const agents = await seam.agents().catch(() => []);
  return { ...recs, live: liveDesk({ email: o.email, owner: recs.owner, agents, rows }), crm: crm.status };
}

/** The owners' daily digest (app/realty/digest). Anyone who isn't an owner gets { owner: false } and no data. */
export function staffDigest(o: { email: string | null; env?: Env; intakeRoot?: string; now?: Date }): { owner: false } | { owner: true; digest: Digest; crm: "not-connected" | "ok" } {
  const env = o.env ?? runtimeEnv();
  if (!o.email || !emailAllowed(o.email, parseAllowlist(env.BOPS_OWNER_EMAILS ?? ""))) return { owner: false };
  const rows = new PeriskopeStore(o.intakeRoot ?? defaultIntakeRoot()).live();
  return { owner: true, digest: digestOf(rows, o.now ?? new Date()), crm: crmSeam().connected ? "ok" : "not-connected" };
}
