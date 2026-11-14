import { nameKey } from "./dedupe.ts";

/** 1on1's agents (the CRM's agents table: public), to turn a WhatsApp sender or an @mention into an agent id. */
export type Agent = { id: number; name: string; email: string | null; phone: string | null };

export function findAgent(who: string, agents: Agent[]): Agent | null {
  const w = who.trim().toLowerCase();
  if (!w) return null;
  const digits = w.replace(/\D/g, "");
  if (digits.length >= 7) {
    const a = agents.find((x) => x.phone && x.phone.replace(/\D/g, "").slice(-7) === digits.slice(-7));
    if (a) return a;
  }
  const full = nameKey(who);
  const exact = agents.find((a) => full && nameKey(a.name) === full);
  if (exact) return exact;
  // A first name alone ("@Kerry") only if exactly one agent has it.
  const first = w.split(/\s+/)[0];
  const byFirst = agents.filter((a) => a.name.trim().toLowerCase().split(/\s+/)[0] === first);
  return byFirst.length === 1 ? byFirst[0] : null;
}
