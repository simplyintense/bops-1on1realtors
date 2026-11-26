import { agentSearch } from "@/realty/node/agent-search.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";

/**
 * Server to server, for the 1on1 Realtors staff MCP only: Authorization: Bearer <BOPS_MCP_TOKEN>. Read-only search of the
 * supply and demand tabs (realty/node/agent-search.ts). Every signed-in staff user gets the same rows: X-1on1-Role,
 * X-1on1-User and full are not read. Not behind the Google gate (lib/gate.ts).
 *   GET → 200 { kind, total, limit, offset, rows, totals?, external? } · 400 { error } · 401 { error }
 */
export async function GET(request: Request) {
  const { status, body } = await agentSearch(
    { authorization: request.headers.get("authorization"), params: new URL(request.url).searchParams },
    periskopeRoot(),
    process.env,
  );
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
