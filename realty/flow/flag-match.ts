/**
 * A bad-match report from the CRM (POST /api/realty/learn/flag-match), checked. Pure: the store keeps what passes here. Group
 * names are never a field of this, so none can be stored.
 */

export const FLAG_SOURCES = ["crm", "whatsapp", "online"] as const;
export const FLAG_REASONS = ["wrong_area", "wrong_type", "not_a_listing", "wrong_price", "other"] as const;
export type FlagSource = (typeof FLAG_SOURCES)[number];
export type FlagReason = (typeof FLAG_REASONS)[number];

export const FLAG_SOURCE_LABELS: Record<FlagSource, string> = { crm: "CRM", whatsapp: "WhatsApp", online: "Online search" };
export const FLAG_REASON_LABELS: Record<FlagReason, string> = { wrong_area: "Wrong area", wrong_type: "Wrong type", not_a_listing: "Not a listing", wrong_price: "Wrong price", other: "Other" };

export type FlagInput = {
  source: FlagSource;
  clientId: string | null;
  clientLocations: string[];
  listingId: string | null;
  listingTitle: string | null;
  listingLocation: string | null;
  reason: FlagReason;
  note: string | null;
  reportedBy: string | null;
};
/** A stored flag: the input, its id and when it came in (UTC ISO). */
export type FlaggedMatch = FlagInput & { id: number; flaggedAt: string };

const MAX_SHORT = 200;
const MAX_NOTE = 2000;
const MAX_LOCATIONS = 20;

/** The body as the CRM sends it (snake_case). Returns { ok: false, error } on a bad field, never a throw. */
export function flagInputOf(body: unknown): { ok: true; flag: FlagInput } | { ok: false; error: string } {
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("The body must be a JSON object.");
    const o = body as Record<string, unknown>;
    const oneOf = <T extends string>(v: unknown, list: readonly T[], error: string): T => {
      if (typeof v !== "string" || !(list as readonly string[]).includes(v)) throw new Error(error);
      return v as T;
    };
    const text = (k: string, max: number): string | null => {
      const v = o[k];
      if (v == null) return null;
      if (typeof v !== "string") throw new Error(`${k} must be text.`);
      const s = v.trim();
      if (s.length > max) throw new Error(`${k} is longer than ${max} characters.`);
      return s || null;
    };
    const locs = o.client_locations;
    if (locs != null && (!Array.isArray(locs) || locs.length > MAX_LOCATIONS)) throw new Error(`client_locations is a list of up to ${MAX_LOCATIONS} places.`);
    const clientLocations = ((locs as unknown[] | undefined) ?? []).map((l) => {
      if (typeof l !== "string" || !l.trim() || l.trim().length > MAX_SHORT) throw new Error(`Each client location is text of up to ${MAX_SHORT} characters.`);
      return l.trim();
    });
    return {
      ok: true,
      flag: {
        source: oneOf(o.source, FLAG_SOURCES, "source must be crm, whatsapp or online."),
        reason: oneOf(o.reason, FLAG_REASONS, "reason must be wrong_area, wrong_type, not_a_listing, wrong_price or other."),
        clientId: text("client_id", MAX_SHORT),
        clientLocations,
        listingId: text("listing_id", MAX_SHORT),
        listingTitle: text("listing_title", MAX_SHORT),
        listingLocation: text("listing_location", MAX_SHORT),
        note: text("note", MAX_NOTE),
        reportedBy: text("reported_by", MAX_SHORT),
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
