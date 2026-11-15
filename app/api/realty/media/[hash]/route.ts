import { serveMedia } from "@/realty/node/media-route.ts";

export const dynamic = "force-dynamic";

/** Staff only: a stored listing photo by its content hash (display size). Never public, never a directory listing. */
export async function GET(request: Request, ctx: { params: Promise<{ hash: string }> }) {
  const { hash } = await ctx.params;
  return serveMedia(request, hash, false);
}
