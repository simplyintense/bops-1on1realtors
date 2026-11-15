/**
 * Short listing titles for the suggested messages, the lead cards and the admin digest. A CRM title is often long, clunky or in
 * capitals ("WEST HILLS, PETIT VALLEY 3BR Apartment For Sale"). shortListingTitle reads the development (or street) out of it,
 * drops the boilerplate, title-cases the capitals, and adds the area, beds and type from the structured fields when they're given:
 * "West Hills, Petit Valley, 3-bed apartment". It never adds the price (leadMessage adds that itself, and the cards show it).
 *
 * Nothing is invented: the name comes from the title (or, when the title has no name, the short street from the address), and
 * an area, beds or type is said only when it's known. A word already in the name is not said again. The title's own bed count
 * is used only when the structured beds are missing. A title with no name and no area gives "Listing".
 *
 * Portable: no node:*, no next, no bare process.
 */

export type ShortTitleInput = {
  title: string;
  area?: string | null;
  beds?: number | null;
  /** The listing's type word (apartment, townhouse, house, condo, villa, land, commercial, office). Read from the title when null. */
  type?: string | null;
  address?: string | null;
};

const FOR_SALE_RE = /\bfor[\s-]+(?:sale|rent|lease)\b/gi;
const BED_RE = /\b\d+\s*-?\s*(?:br|bd|bed|beds|bedroom|bedrooms)\b/gi;
const BATH_RE = /\b\d+(?:\.\d+)?\s*-?\s*(?:ba|bath|baths|bathroom|bathrooms)\b/gi;
const BEDWORD_RE = /\bbedrooms?\b/gi;
const PRICE_RE = /(?:TT|US)?\$\s*[\d.,]+\s*[mk]?/gi;
const TYPE_SRC = String.raw`\b(?:apartments?|apts?|flats?|town\s?houses?|houses?|condos?|condominiums?|villas?|land|commercial|offices?)\b`;
const TYPE_RE = new RegExp(TYPE_SRC, "gi");
const BEDS_IN_TITLE_RE = /\b(\d{1,2})\s*-?\s*(?:br|bd|bed|beds|bedroom|bedrooms)\b/i;
/** Small words kept lower-case inside a title in capitals ("WEST INDIES OF TOBAGO" → "West Indies of Tobago"). */
const CONNECTORS = new Set(["of", "and", "the", "at", "in", "on", "a", "an", "de", "la", "du", "to", "by", "for"]);
/** A street is used as a name only when it's this short; a long address is never dumped into a title. */
const STREET_MAX = 40;
/** Punctuation left dangling at the start or end of a name or a segment once words are taken out ("Name -", "Name …", "Name,"). */
const EDGE_PUNCT_RE = /^[\s,.;:|\/&+*…\-–—]+|[\s,.;:|\/&+*…\-–—]+$/g;
/** Connector words left dangling by the same stripping ("Name or Townhouse" → "Name or" → "Name"). Whole words only. */
const LEAD_CONNECTOR_RE = /^(?:or|and|of|for|with|to|by|vs)\b/i;
const TRAIL_CONNECTOR_RE = /\b(?:or|and|of|for|with|to|by|vs)$/i;

/** The listing type word in a title, canonical (apartment, townhouse, house, condo, villa, land, commercial, office), or null. */
export function typeOfTitle(title: string): string | null {
  const hit = new RegExp(TYPE_SRC, "i").exec(title ?? "");
  return hit ? canonicalType(hit[0]) : null;
}

/** The listing's type word: the title's, else the CRM's property kind when it's land or commercial, else null. */
export function listingTypeWord(title: string, kind?: string | null): string | null {
  return typeOfTitle(title) ?? (kind === "land" || kind === "commercial" ? kind : null);
}

function canonicalType(word: string): string {
  const w = word.toLowerCase().replace(/\s+/g, "");
  if (w.startsWith("apart") || w.startsWith("flat") || w.startsWith("apt")) return "apartment";
  if (w.startsWith("townhouse")) return "townhouse";
  if (w.startsWith("house")) return "house";
  if (w.startsWith("condo")) return "condo";
  if (w.startsWith("villa")) return "villa";
  if (w.startsWith("commercial")) return "commercial";
  if (w.startsWith("office")) return "office";
  return w;
}

const isAllCaps = (w: string): boolean => /\p{L}{2,}/u.test(w) && w === w.toUpperCase() && w !== w.toLowerCase();

/** Capitals become title case word by word (apostrophes and hyphens start a new capital); mixed-case words are left alone. */
function titleCase(s: string): string {
  return s.replace(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu, (w, offset: number) => {
    if (!isAllCaps(w)) return w;
    const lower = w.toLowerCase();
    if (offset > 0 && CONNECTORS.has(lower)) return lower;
    return lower.replace(/(^|['’-])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase());
  });
}

/**
 * One comma-separated segment, tidied: dangling punctuation and connector words come off both ends, again and again until
 * neither is left. A segment that's only punctuation or connectors comes back "" (and the caller drops it).
 */
function tidySegment(seg: string): string {
  let t = seg.replace(/\s+/g, " ").trim();
  for (;;) {
    const before = t;
    t = t.replace(EDGE_PUNCT_RE, "").replace(LEAD_CONNECTOR_RE, "").replace(TRAIL_CONNECTOR_RE, "").trim();
    if (t === before) return t;
  }
}

/**
 * The title with the boilerplate, the beds, the baths, the price and the type words taken out, then each comma-separated
 * segment tidied (no dangling connectors or punctuation), empty segments dropped, and title-cased.
 */
function nameOf(title: string): string {
  let s = (title ?? "").replace(/\s+/g, " ");
  s = s.replace(FOR_SALE_RE, " ").replace(BATH_RE, " ").replace(BED_RE, " ").replace(BEDWORD_RE, " ").replace(PRICE_RE, " ").replace(TYPE_RE, " ");
  s = s.replace(/\s+[-–—|/]\s+/g, ", ");
  const segments = s.split(",").map(tidySegment).filter(Boolean);
  return titleCase(segments.join(", "));
}

/** Letters and digits only, lower-cased and padded, so "Petit Valley" finds itself as a whole word and not inside another word. */
const words = (s: string): string => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** The short street from an address: its first part, with a leading house number dropped; "" when there's none or it's long. */
function streetOf(address: string | null | undefined): string {
  const first = (address ?? "").split(",")[0].trim().replace(/^(?:#\s*)?\d[\d\-/A-Za-z]*\s+/, "").trim();
  const tidy = tidySegment(first);
  return tidy && tidy.length <= STREET_MAX ? titleCase(tidy) : "";
}

/**
 * The short title: the name (from the title, else the street), then the area when the name doesn't already say it, then
 * "N-bed type" from the beds and the type (either or both, or neither). Price is never in it. Pure.
 *   WEST HILLS, PETIT VALLEY 3BR Apartment For Sale + area Petit Valley, beds 3  → "West Hills, Petit Valley, 3-bed apartment"
 *   NEWBURY HILL EXTENSION + area Glencoe, beds 3, rent                          → "Newbury Hill Extension, Glencoe, 3-bed"
 *   THIRD URBAN (no area, beds or type)                                           → "Third Urban"
 */
export function shortListingTitle(l: ShortTitleInput): string {
  const titleBeds = BEDS_IN_TITLE_RE.exec(l.title ?? "");
  const beds = l.beds && l.beds > 0 ? l.beds : titleBeds ? Number(titleBeds[1]) : null;
  const type = l.type?.trim() ? canonicalType(l.type.trim()) : typeOfTitle(l.title ?? "");
  const name = nameOf(l.title ?? "") || streetOf(l.address);
  const area = l.area?.trim() ? titleCase(tidySegment(l.area)) : "";
  const parts: string[] = [];
  if (name) parts.push(name);
  if (area && !(name && words(name).includes(words(area)))) parts.push(area);
  const kind = [beds ? `${beds}-bed` : null, type].filter(Boolean).join(" ");
  if (kind) parts.push(kind);
  return parts.join(", ") || "Listing";
}
