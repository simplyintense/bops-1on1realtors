import { findBudget, findInterest } from "../extract.ts";

/**
 * What Bops has been taught, applied to text. Pure: the terms come from the shared knowledge store (realty/node/search-store.ts)
 * and are passed in, so this file never opens a database. A term fills only the fields the parser left empty, so the built-in
 * gazetteer always wins where it already found something.
 */

/** Text that means a place, a development, a type or sale/rent/shortlet. Canonical names; null where the term says nothing about that field. */
export type KnownTerm = { term: string; area: string | null; development: string | null; type: string | null; listingType: string | null };

/** Sale, long-term rent, or a seasonal short let (Carnival and other short stays). */
export type RecordListingType = "sale" | "rent" | "shortlet";

/**
 * Canonical listing type, or null when empty. "short-let" / "short let" become "shortlet".
 * Returns undefined when the value isn't one of those.
 */
export function parseListingType(raw: string | null | undefined): RecordListingType | null | undefined {
  if (raw == null || !String(raw).trim()) return null;
  const s = String(raw).trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (s === "sale" || s === "rent") return s;
  if (s === "shortlet" || s === "short-let") return "shortlet";
  return undefined;
}

export type PlaceFields = { area: string | null; development: string | null; type: string | null; listingType: string | null };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole word or phrase, case-insensitive: no letter or digit on either side. */
const wordRe = (term: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, "iu");

/** Terms sorted once per array (longest first) with their patterns. The array must not change after it is first used. */
const compiled = new WeakMap<readonly KnownTerm[], { t: KnownTerm; re: RegExp }[]>();

function compile(terms: readonly KnownTerm[]): { t: KnownTerm; re: RegExp }[] {
  let c = compiled.get(terms);
  if (!c) {
    c = [...terms].sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term)).map((t) => ({ t, re: wordRe(t.term) }));
    compiled.set(terms, c);
  }
  return c;
}

/** Index of the first whole-word, case-insensitive match of term in text, or -1. */
export function termAt(text: string, term: string): number {
  const m = wordRe(term).exec(text);
  return m ? m.index : -1;
}

export function termIn(text: string, term: string): boolean {
  return termAt(text, term) >= 0;
}

/** A shorter term that must not fire when a longer compound place is present (bare "savannah" vs Savannah Mews). */
const TERM_EXCEPTIONS: Record<string, string[]> = {
  savannah: ["savannah mews", "grand savannah", "caroni savannah", "savannah villas"],
};

/** Drop blocked compound phrases, then test whether the term still remains. */
function termStillMatches(text: string, term: string, re: RegExp): boolean {
  const blocked = TERM_EXCEPTIONS[term.toLowerCase()];
  if (!blocked) return re.test(text);
  let rest = text;
  for (const phrase of blocked) rest = rest.replace(wordRe(phrase), " ");
  return re.test(rest);
}

/** Fill only the empty fields, from every term the text contains (longest term first). Never overwrites, except a shortlet term may refine rent. */
export function applyKnownTerms(f: PlaceFields, text: string, terms: readonly KnownTerm[]): PlaceFields {
  const out = { ...f };
  for (const { t, re } of compile(terms)) {
    const refineRent = t.listingType === "shortlet" && out.listingType === "rent";
    const wanted = (t.area && !out.area) || (t.development && !out.development) || (t.type && !out.type) || (t.listingType && !out.listingType) || refineRent;
    if (!wanted || !termStillMatches(text, t.term, re)) continue;
    if (t.area && !out.area) out.area = t.area;
    if (t.development && !out.development) out.development = t.development;
    if (t.type && !out.type) out.type = t.type;
    if (t.listingType && !out.listingType) out.listingType = t.listingType;
    else if (refineRent) out.listingType = "shortlet";
  }
  return out;
}

/** The place names the matcher can resolve by exact text: a taught area or development, under the term. */
export function aliasesOf(terms: readonly KnownTerm[]): { alias: string; canonical: string }[] {
  return terms.flatMap((t) => {
    const canonical = t.area ?? t.development;
    return canonical ? [{ alias: t.term, canonical }] : [];
  });
}

/**
 * A short guess at what a vague post means, shown to the owner to confirm or correct: the first known place named, then the
 * type, sale or rent, and the price, from the same plain-word rules the parser uses. "No guess" when none of them show up.
 */
export function bestGuess(text: string, terms: readonly KnownTerm[]): string {
  let place: { at: number; name: string } | null = null;
  for (const { t, re } of compile(terms)) {
    const name = t.area ?? t.development;
    if (!name) continue;
    const m = re.exec(text);
    if (m && (!place || m.index < place.at)) place = { at: m.index, name };
  }
  const interest = findInterest(text);
  const budget = findBudget(text);
  const price = budget ? `${budget.currency} ${budget.max.toLocaleString("en-US")}${budget.period === "month" ? " a month" : ""}` : null;
  const listing = interest.intent === "rent" ? "rent" : interest.intent === "buy" ? "sale" : null;
  const parts = [place?.name, interest.types[0] ?? null, listing, price].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : "No guess";
}
