import { join } from "node:path";
import { ownerAccess } from "@/realty/node/periskope-intake.ts";
import { listPostViews } from "@/realty/node/group-posts.ts";
import { PeriskopeStore } from "@/realty/node/periskope-store.ts";

export const dynamic = "force-dynamic";

/**
 * Owners only. Lists structured group posts. originalText is included for owners; this route is
 * already owner-gated, so agents never receive it.
 */
export async function GET(request: Request) {
  const denied = await ownerAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  const store = new PeriskopeStore(join(process.cwd(), ".data", "realty", "periskope"));
  return Response.json({ posts: listPostViews(store, true) });
}
