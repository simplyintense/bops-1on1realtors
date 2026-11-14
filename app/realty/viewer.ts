import { cookies } from "next/headers";
import { GATE_COOKIE, gateConfig, ownerAllowed, readSession, teachAllowed } from "@/lib/gate";

/**
 * Who is looking at a /realty page, on the server: the gate's signed-in email (null with the gate off, or signed out),
 * whether it may see the owners' screens (ownerAllowed), and whether it may teach Bops (teachAllowed). The email is never
 * rendered; it's for the owner and teacher checks and for who set a match's status.
 */
export async function viewer(): Promise<{ email: string | null; owner: boolean; teacher: boolean }> {
  try {
    const cfg = gateConfig();
    const email = cfg && cfg !== "misconfigured" ? await readSession((await cookies()).get(GATE_COOKIE)?.value, cfg) : null;
    return { email, owner: ownerAllowed(email), teacher: teachAllowed(email) };
  } catch {
    return { email: null, owner: ownerAllowed(null), teacher: false };
  }
}
