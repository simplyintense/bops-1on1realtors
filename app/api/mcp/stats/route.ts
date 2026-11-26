import { mcpStats } from "@/realty/node/usage-stats.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";

/**
 * Server to server, for the 1on1 CRM's Monday usage report only: Authorization: Bearer <BOPS_MCP_TOKEN>. Read-only counts for
 * Market Listings, Market Search and the Search Backend (realty/node/usage-stats.ts). Not behind the Google gate (lib/gate.ts).
 *   GET → 200 { generatedAt, timezone, db, health, listings, webSearches } · 401 { error } · 503 { error }
 */
export async function GET(request: Request) {
  const { status, body } = mcpStats({ authorization: request.headers.get("authorization") }, periskopeRoot(), process.env);
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
