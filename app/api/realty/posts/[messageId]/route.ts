import { join } from "node:path";
import { ownerAccess } from "@/realty/node/periskope-intake.ts";
import { findPostView } from "@/realty/node/group-posts.ts";
import { PeriskopeStore } from "@/realty/node/periskope-store.ts";

export const dynamic = "force-dynamic";

/** Owners only. One post, including originalText, looked up by the hashed request id (never the raw WhatsApp id). */
export async function GET(request: Request, ctx: { params: Promise<{ messageId: string }> }) {
  const denied = await ownerAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  const { messageId } = await ctx.params;
  const store = new PeriskopeStore(join(process.cwd(), ".data", "realty", "periskope"));
  const post = findPostView(store, messageId, true);
  if (!post) return Response.json({ error: "Not found." }, { status: 404 });
  return Response.json({ post });
}
