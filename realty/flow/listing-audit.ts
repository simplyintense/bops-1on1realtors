import type { Listing } from "./source.ts";

/**
 * Which of the eight fields a client needs (Wendy's list) a listing is missing. Conservative: a field
 * is present only when the data actually holds it, never inferred from the title or description.
 */

export type MissingField =
  | "availability_status"
  | "exact_location_directions"
  | "price_rent_and_fees"
  | "size_beds_baths"
  | "utilities_parking_amenities"
  | "furnishing"
  | "viewing_arrangements"
  | "photos";

const STATUSES = new Set([
  "active", "available", "pending", "under offer", "under contract",
  "sold", "rented", "let", "withdrawn", "unavailable", "off market",
]);

const text = (v: unknown) => typeof v === "string" && v.trim() !== "";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const measure = (v: unknown) => (num(v) && v > 0) || text(v);

function hasSize(l: Listing): boolean {
  if (l.propertyKind === "land") return measure(l.lotSize);
  if (l.propertyKind === "commercial") return measure(l.squareFeet) || measure(l.lotSize);
  if (!num(l.beds) || !num(l.baths)) return false;
  // 0 beds or baths (a studio, or a placeholder) only counts with a floor area alongside it.
  return (l.beds > 0 && l.baths > 0) || measure(l.squareFeet);
}

export function missingListingFields(l: Listing): MissingField[] {
  const status = String(l.status ?? "").trim().toLowerCase().replace(/[-_]+/g, " ");
  const amenities = Array.isArray(l.amenities) ? l.amenities.some(text) : text(l.amenities);
  const checks: [MissingField, boolean][] = [
    ["availability_status", STATUSES.has(status)],
    ["exact_location_directions", text(l.address) || text(l.directions)],
    ["price_rent_and_fees", num(l.price) && l.price > 0],
    ["size_beds_baths", hasSize(l)],
    ["utilities_parking_amenities", amenities],
    ["furnishing", text(l.furnishing)],
    ["viewing_arrangements", text(l.viewingArrangements)],
    ["photos", num(l.photoCount) && l.photoCount >= 1],
  ];
  return checks.filter(([, present]) => !present).map(([field]) => field);
}
