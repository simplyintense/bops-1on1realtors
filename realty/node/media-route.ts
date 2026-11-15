import { runtimeEnv, type Env } from "../flow/env.ts";
import { mediaReply } from "./listing-media.ts";
import { staffAccess } from "./periskope-intake.ts";
import { periskopeRoot } from "./periskope-root.ts";

/** GET /api/realty/media/<hash>[/thumb]: staff only (staffAccess: 401 signed out with the gate on), then the stored photo or 404. */
export async function serveMedia(request: Request, hash: string, thumb: boolean, env: Env = runtimeEnv()): Promise<Response> {
  const denied = await staffAccess(request, env);
  if (denied) return Response.json(denied.body, { status: denied.status });
  return mediaReply(periskopeRoot(env), hash, thumb);
}
