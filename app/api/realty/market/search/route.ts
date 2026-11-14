import { criteriaFromParams } from "@/realty/flow/market-desk.ts";
import { staffMarketSearch } from "@/realty/node/market-desk.ts";
import { staffAccess } from "@/realty/node/periskope-intake.ts";

export const dynamic = "force-dynamic";

/**
 * Staff only (behind the login gate; not an open path; 403 on the public demo). The same read-only search as
 * /realty/market, as JSON. Filters are the page's query params (realty/flow/market-desk.ts criteriaFromParams).
 *   GET → 200 { status: "ok", area, listings, returned, failed } or { status: "not-configured" }
 *       → 502 { status: "error", reason: "timeout" | "unavailable" }
 * The market token is never in the response.
 */
export async function GET(request: Request) {
  const denied = await staffAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  const result = await staffMarketSearch(criteriaFromParams(new URL(request.url).searchParams));
  return Response.json(result, { status: result.status === "error" ? 502 : 200 });
}
