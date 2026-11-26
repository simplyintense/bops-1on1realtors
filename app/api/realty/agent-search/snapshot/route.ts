import { agentSnapshot } from "@/realty/node/agent-search.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";

/**
 * Server to server, for the 1on1 Realtors staff MCP only: Authorization: Bearer <BOPS_MCP_TOKEN>. Market counts and prices by
 * area, type, listing type and currency. No phone, text or group (realty/node/agent-search.ts).
 *   GET → 200 { kind, groups } · 400 { error } · 401 { error }
 */
export async function GET(request: Request) {
  const { status, body } = agentSnapshot(
    { authorization: request.headers.get("authorization"), params: new URL(request.url).searchParams },
    periskopeRoot(),
    process.env,
  );
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
