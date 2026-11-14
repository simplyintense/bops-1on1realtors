import { defaultAreasRoot, AreaStore, mapAreaAlias } from "@/realty/node/area-store.ts";
import { staffAccess } from "@/realty/node/periskope-intake.ts";

export const dynamic = "force-dynamic";

/**
 * Staff only (behind the login gate; not an open path; 403 on the public demo). Maps a name staff use for an
 * area to the canonical area the matching uses (realty/flow/areas.ts). Local aliases are checked first.
 *   POST { alias, canonical }  → 201 { alias: { alias, canonical, at, market } }
 *                                 market is "dry-run" unless the market search URL and token are set, then "sent" or "failed"
 *                                 400 for a bad body
 */
export async function POST(request: Request) {
  const denied = await staffAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "send JSON with alias and canonical" }, { status: 400 });
  }
  const r = await mapAreaAlias(body, { store: new AreaStore(defaultAreasRoot()) });
  if (!r.ok) return Response.json({ error: r.error }, { status: 400 });
  return Response.json({ alias: r.row }, { status: 201 });
}
