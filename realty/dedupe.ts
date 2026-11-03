import { normalizePhone } from "./extract.ts";

/**
 * Who's already in the CRM: one list of contacts from crm_clients, contact_submissions and
 * property_inquiries, keyed by phone, email and name. A lead matches on phone or email (sure), or on
 * full name alone (possible: flagged for the agent to decide).
 */

export type CrmContact = {
  table: "crm_clients" | "contact_submissions" | "property_inquiries";
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  agentId: number | null;
};

export type Match = { how: "phone" | "email" | "name"; contact: CrmContact };

/** The last 10 digits of a number (868 + 7 for T&T), so +1 868…, 868… and 1-868… compare equal. */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const p = normalizePhone(raw);
  if (!p) return null;
  const d = p.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

export function nameKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const words = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !["mr", "mrs", "ms", "miss", "dr"].includes(w));
  return words.length >= 2 ? words.sort().join(" ") : null;
}

export class CrmIndex {
  private byPhone = new Map<string, CrmContact>();
  private byEmail = new Map<string, CrmContact>();
  private byName = new Map<string, CrmContact>();
  readonly size: number;

  constructor(contacts: CrmContact[]) {
    for (const c of contacts) {
      const p = phoneKey(c.phone);
      if (p && !this.byPhone.has(p)) this.byPhone.set(p, c);
      const e = c.email?.trim().toLowerCase();
      if (e && !this.byEmail.has(e)) this.byEmail.set(e, c);
      const n = nameKey(c.name);
      if (n && !this.byName.has(n)) this.byName.set(n, c);
    }
    this.size = contacts.length;
  }

  match(lead: { phones: string[]; emails: string[]; names: string[] }): Match | null {
    for (const ph of lead.phones) {
      const c = this.byPhone.get(phoneKey(ph) ?? "");
      if (c) return { how: "phone", contact: c };
    }
    for (const e of lead.emails) {
      const c = this.byEmail.get(e.toLowerCase());
      if (c) return { how: "email", contact: c };
    }
    for (const n of lead.names) {
      const c = this.byName.get(nameKey(n) ?? "");
      if (c) return { how: "name", contact: c };
    }
    return null;
  }
}
