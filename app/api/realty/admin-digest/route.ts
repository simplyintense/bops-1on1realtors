import { adminDigestRoute } from "@/realty/node/admin-digest.ts";

export const dynamic = "force-dynamic";

/**
 * Owners only. The admin match digest as a preview (realty/node/admin-digest.ts): text/html by default, text/plain with
 * ?format=txt. Renders only: this route never sends mail.
 *   GET → 200 text/html or text/plain · 403 { error } not an owner · 401 signed out · 503 gate misconfigured
 */
export async function GET(request: Request) {
  return adminDigestRoute(request);
}
