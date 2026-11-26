import { cookies } from "next/headers";
import { GATE_COOKIE, gateConfig, ownerAllowed, readSession, teachAllowed } from "@/lib/gate";

/**
 * Who is looking at a /realty page, on the server: the gate's signed-in email (null with the gate off, or signed out),
 * whether it may see the owners' screens (ownerAllowed), whether it may teach Bops (teachAllowed), and whether it is staff:
 * any signed-in person the gate admits (an owner, an agent or a teacher), or anyone with the gate off (then owner is true too).
 * The email is never rendered; it's for the owner and teacher checks and for who set a match's status.
 */
export async function viewer(): Promise<{ email: string | null; owner: boolean; teacher: boolean; staff: boolean }> {
  try {
    const cfg = gateConfig();
    const email = cfg && cfg !== "misconfigured" ? await readSession((await cookies()).get(GATE_COOKIE)?.value, cfg) : null;
    const owner = ownerAllowed(email);
    return { email, owner, teacher: teachAllowed(email), staff: owner || email !== null };
  } catch {
    const owner = ownerAllowed(null);
    return { email: null, owner, teacher: false, staff: owner };
  }
}
