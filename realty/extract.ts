/**
 * What a message says about a property lead: phones, emails, budget, area, what kind of place, and a
 * name. Plain rules, no AI, so the same export always gives the same proposals and every field can be
 * traced to the words it came from. Tuned for Trinidad and Tobago (868 numbers, TT$/US$, local areas).
 */

export type Budget = { min: number | null; max: number; currency: "TTD" | "USD"; period: "month" | null; text: string };

export type Interest = {
  intent: "buy" | "rent" | null;
  types: string[];
  bedrooms: number | null;
};

export type LeadFacts = {
  names: string[];
  phones: string[];
  emails: string[];
  budget: Budget | null;
  areas: string[];
  interest: Interest;
};

/* ---------------- Phones and emails ---------------- */

/** +1868XXXXXXX for a T&T number (with or without 868), +<digits> for another international one. */
export function normalizePhone(raw: string): string | null {
  const plus = raw.trim().startsWith("+");
  const d = raw.replace(/\D/g, "");
  if (d.length === 7) return `+1868${d}`;
  if (d.length === 10 && d.startsWith("868")) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1868")) return `+${d}`;
  if (d.length === 10 && !plus) return `+1${d}`; // a North American number written without +1
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (plus && d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
}

const PHONE = /(?:\+\s?\d{1,3}[\s.-]?)?(?:\(\s?\d{3}\s?\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b|\b\d{3}[\s.-]\d{4}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function findPhones(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PHONE)) {
    // A price like "3,500 000" or a date isn't a phone: skip matches glued to $ or commas.
    const before = text.slice(Math.max(0, (m.index ?? 0) - 3), m.index);
    if (/\$\s?$|\d[,.]$/.test(before)) continue;
    const p = normalizePhone(m[0]);
    if (p) out.add(p);
  }
  return [...out];
}

export const findEmails = (text: string) => [...new Set([...text.matchAll(EMAIL)].map((m) => m[0].toLowerCase()))];

/* ---------------- Money ---------------- */

const WORD_MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mil: 1e6, mill: 1e6, million: 1e6, mn: 1e6 };

function amount(num: string, mult?: string): number {
  const n = Number(num.replace(/,/g, ""));
  return Math.round(n * (mult ? (WORD_MULT[mult.toLowerCase()] ?? 1) : 1));
}

const CUR = String.raw`(?:(TT\$?|TTD|US\$?|USD|\$)\s?)`;
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)\s?(k|m|mn|mil|mill|million|thousand)?\b`;
const PERIOD = String.raw`(\s?(?:\/|per|a)\s?(?:month|mth|mo)\b|\s?monthly\b)?`;
const RANGE = new RegExp(String.raw`${CUR}?${NUM}\s?(?:-|–|/|to|and)\s?${CUR}?${NUM}${PERIOD}`, "i");
const SINGLE = new RegExp(String.raw`${CUR}${NUM}${PERIOD}|\b(?:budget|max|maximum|up to|under|around|about)\s(?:is\s|of\s)?${CUR}?${NUM}${PERIOD}|${NUM}${PERIOD}?\s?(TTD|USD|TT|US)\b`, "i");

function currencyOf(sym: string | undefined, text: string): "TTD" | "USD" {
  const s = (sym ?? "").toUpperCase();
  if (s.startsWith("US")) return "USD";
  if (s.startsWith("TT")) return "TTD";
  return /\b(usd|us\$|us dollars?)\b/i.test(text) ? "USD" : "TTD";
}

// "1m", "1.2M", "800k" (letter glued to the number) and "1 mil" / "1 million" (the word form). Bare "5 m" is not money.
const COMPACT_AMOUNT = new RegExp(String.raw`${CUR}?(\d[\d,]*(?:\.\d+)?)(m|mn|mil|mill|k)\b(?:\s*budget\b)?${PERIOD}`, "i");
const WORD_AMOUNT = new RegExp(String.raw`${CUR}?(\d[\d,]*(?:\.\d+)?)\s(mil|mill|million|thousand)\b(?:\s*budget\b)?${PERIOD}`, "i");

function budgetOf(cur: string | undefined, num: string, mult: string | undefined, per: string | undefined, raw: string, text: string, index: number): Budget | null {
  const max = amount(num, mult);
  if (max < 1000) return null;
  const monthly = !!per || /\b(per|a|\/)\s?month\b|monthly/i.test(text.slice(index, index + raw.length + 12));
  return { min: null, max, currency: currencyOf(cur, text), period: monthly ? "month" : null, text: raw.trim() };
}

export function findBudget(text: string): Budget | null {
  const r = RANGE.exec(text);
  // A range only counts with money around it ("2-3M", "$8k to $10k", "budget 2 to 3 million").
  // Groups: 1 cur, 2 num, 3 mult, 4 cur, 5 num, 6 mult, 7 period. A range only counts with money
  // around it ("2-3M", "$8k to $10k", "budget 2 to 3 million"), so "3-4 bedrooms" isn't one.
  if (r && (r[1] || r[4] || r[3] || r[6] || /budget|price/i.test(text))) {
    const unit = r[6] ?? r[3];
    const lo = amount(r[2], r[3] ?? unit);
    const hi = amount(r[5], r[6] ?? unit);
    if (hi >= 1000 && lo <= hi) {
      return { min: lo, max: hi, currency: currencyOf(r[1] ?? r[4], text), period: r[7] ? "month" : null, text: r[0].trim() };
    }
  }
  const s = SINGLE.exec(text);
  if (s) {
    // Groups: [1 cur, 2 num, 3 mult, 4 period] | [5 cur, 6 num, 7 mult, 8 period] | [9 num, 10 mult, 11 period, 12 cur]
    const [cur, num, mult, per] = s[2] ? [s[1], s[2], s[3], s[4]] : s[6] ? [s[5], s[6], s[7], s[8]] : [s[12], s[9], s[10], s[11]];
    return budgetOf(cur, num, mult, per, s[0], text, s.index);
  }
  const c = COMPACT_AMOUNT.exec(text);
  if (c) return budgetOf(c[1], c[2], c[3], c[4], c[0], text, c.index);
  const w = WORD_AMOUNT.exec(text);
  if (w) return budgetOf(w[1], w[2], w[3], w[4], w[0], text, w.index);
  return null;
}

/* ---------------- Areas ---------------- */

/**
 * The Port of Spain / west-of-the-savannah group people mean by "central" or "central locations".
 * The stored name is "Central locations", not "Central", which is already a Trinidad region (Chaguanas, Couva…).
 */
export const CENTRAL_AREA = "Central locations";
export const CENTRAL_AREAS = ["Port of Spain", "St. Clair", "Woodbrook", "Newtown", "Belmont", "St. James", "Maraval", "Cascade"];
const CENTRAL_PHRASE = /\bcentral(?:\s+locations?)?\b/i;

/** True when the parsed area is the central group, not a single named place and not the Central region. */
export function isCentralAreaGroup(name: string | null | undefined): boolean {
  const k = (name ?? "").replace(/[–—]/g, "-").trim().replace(/\s+/g, " ").toLowerCase();
  return k === "central" || k === "central location" || k === "central locations";
}

/**
 * Named apartment developments in west Trinidad. A message that names one is in that development:
 * the parent is the surrounding area, neighbours are adjoining areas, and the type is apartment
 * unless the text names another kind of place. Glencoe sits in the same west cluster as West Hills
 * (Petit Valley / Morne Coco Road) but is left out of West Hills neighbours until Miles confirms.
 *
 * Sources (checked 14 Nov 2026):
 *   La Fontaine — Columbus Circle, Westmoorings: prince-associates.com/properties/rental/west/la_fontaine.html,
 *     deneco.co, mybunchofkeys.com (Westmoorings South East, walking distance to ISPS, Massy, Westmall).
 *   West Hills / Westhills — Morne Coco Road, Petit Valley, Diego Martin: homesolutionstt.com/communities/west-hills,
 *     mybunchofkeys.com listings ("Westhills, Morne Coco Rd – Petit Valley", building-numbered blocks).
 *   One Woodbrook Place — Woodbrook / Mucurapo, Port of Spain: owptt.com, nck.ca, appleandiron.com.
 *   La Riviera — Columbus Circle / Westmoorings East: desilvarealty.com, mybunchofkeys.com.
 *   The Towers — Columbus Circle, Westmoorings (Caribi, Arawak, Ciboney): desilvarealty.com, mybunchofkeys.com.
 *   Victoria Keyes — Diego Martin, minutes from Westmall: terracaribbean.com, mybunchofkeys.com.
 *   Aquaria — Carenage hillside off the Western Main Road, listed with Goodwood Park / Westmoorings:
 *     mybunchofkeys.com/property/for-rent-aquaria/.
 *   Goodwood Heights — Westmoorings: mybunchofkeys.com/property/goodwood-heights-westmoorings-3/.
 *   Glencoe adjoining this cluster: Wikipedia "Maraval" groups Westmoorings, Goodwood Park and Glencoe;
 *     mybunchofkeys.com tags a Glencoe rental as Diego Martin / Glencoe / Petit Valley / Westmoorings;
 *     Morne Coco Road links Petit Valley toward Westmoorings (jbmancave.com drive notes).
 */
export type Development = {
  name: string;
  aliases: string[];
  parent: string;
  neighbours: string[];
  type: "apartment";
};

export const DEVELOPMENTS: Development[] = [
  { name: "La Fontaine", aliases: ["La Fontaine", "Lafontaine"], parent: "Westmoorings", neighbours: ["Westmoorings", "Diego Martin", "Goodwood Park", "Carenage"], type: "apartment" },
  { name: "West Hills", aliases: ["West Hills", "Westhills", "Westhill", "West Hill"], parent: "Petit Valley", neighbours: ["Petit Valley", "Diego Martin", "Westmoorings"], type: "apartment" },
  { name: "One Woodbrook Place", aliases: ["One Woodbrook Place", "One Woodbrook", "OWP"], parent: "Woodbrook", neighbours: ["Woodbrook", "Port of Spain"], type: "apartment" },
  { name: "La Riviera", aliases: ["La Riviera"], parent: "Westmoorings", neighbours: ["Westmoorings", "Diego Martin"], type: "apartment" },
  { name: "The Towers", aliases: ["The Towers, Westmoorings", "The Towers Westmoorings"], parent: "Westmoorings", neighbours: ["Westmoorings", "Diego Martin"], type: "apartment" },
  { name: "Victoria Keyes", aliases: ["Victoria Keyes", "Victoria Keys"], parent: "Diego Martin", neighbours: ["Diego Martin", "Westmoorings"], type: "apartment" },
  { name: "Aquaria", aliases: ["Aquaria Apartments", "Aquaria"], parent: "Carenage", neighbours: ["Carenage", "Goodwood Park", "Westmoorings"], type: "apartment" },
  { name: "Goodwood Heights", aliases: ["Goodwood Heights"], parent: "Westmoorings", neighbours: ["Westmoorings", "Goodwood Park"], type: "apartment" },
];

/** West Hills is on Morne Coco Road in Petit Valley; Glencoe is next to that west cluster, but is not used as a neighbour in matching until Miles confirms. */
export const WEST_HILLS_UNCONFIRMED_NEIGHBOURS = ["Glencoe"];


/** Canonical area and development names for the knowledge layer (deduped aliases). */
export function gazetteerPlaces(): { name: string; kind: "area" | "development"; parent: string | null }[] {
  const seen = new Set<string>();
  const out: { name: string; kind: "area" | "development"; parent: string | null }[] = [];
  const add = (name: string, kind: "area" | "development", parent: string | null) => {
    const k = name.replace(/[–—]/g, "-").trim().replace(/\s+/g, " ").toLowerCase();
    if (!k || seen.has(k) || k === "trinidad" || k === "tobago") return;
    seen.add(k);
    out.push({ name, kind, parent });
  };
  for (const d of DEVELOPMENTS) add(d.name, "development", d.parent);
  for (const a of AREAS) add(CANON[a.toLowerCase().replace(/\./g, "")] ?? a, "area", null);
  return out;
}

export function developmentOf(name: string | null | undefined): Development | null {
  const k = (name ?? "").replace(/[–—]/g, "-").trim().replace(/\s+/g, " ").toLowerCase();
  if (!k) return null;
  return DEVELOPMENTS.find((d) => d.name.toLowerCase() === k || d.aliases.some((a) => a.toLowerCase() === k)) ?? null;
}

export function findDevelopments(text: string): Development[] {
  const aliases = DEVELOPMENTS.flatMap((d) => d.aliases.map((alias) => ({ alias, d }))).sort((a, b) => b.alias.length - a.alias.length);
  const out: Development[] = [];
  let rest = text;
  for (const { alias, d } of aliases) {
    const re = new RegExp(`\\b${esc(alias)}\\b`, "i");
    if (re.test(rest) && !out.includes(d)) {
      out.push(d);
      rest = rest.replace(new RegExp(`\\b${esc(alias)}\\b`, "gi"), " ");
    }
  }
  return out;
}

/** Areas to match against a request: a development expands to itself, its parent, and confirmed neighbours. */
export function areasForMatch(area: string): { same: string[]; nearby: string[] } {
  if (isCentralAreaGroup(area)) return { same: [...CENTRAL_AREAS], nearby: [] };
  const d = developmentOf(area);
  if (d) return { same: [d.name], nearby: [d.parent, ...d.neighbours].filter((n, i, all) => areaKeyish(n) !== areaKeyish(d.name) && all.indexOf(n) === i) };
  return { same: [area], nearby: [] };
}

function areaKeyish(s: string): string {
  return s.replace(/[–—]/g, "-").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Places 1on1 lists in, by the names people write. Longest first so "Port of Spain" beats "Spain". */
export const AREAS = [
  "Port of Spain", "Westmoorings", "West Moorings", "Maraval", "St. Ann's", "St Anns", "St. James", "St James", "Cascade", "Diego Martin", "Glencoe",
  "Goodwood Park", "Woodbrook", "Newtown", "New Town", "St. Clair", "St Clair", "Federation Park", "Ellerslie Park", "Fairways", "Valsayn", "St. Augustine",
  "St Augustine", "Curepe", "Tunapuna", "Arima", "Trincity", "D'Abadie", "Chaguanas", "Couva", "Point Lisas", "San Fernando",
  "Gulf View", "La Romaine", "Marabella", "Princes Town", "Point Fortin", "Carenage", "Chaguaramas", "Santa Cruz", "Petit Valley",
  "Cocorite", "Belmont", "Barataria", "San Juan", "Morvant", "El Socorro", "Piarco", "Freeport", "Claxton Bay", "Penal", "Siparia",
  "Sangre Grande", "Mayaro", "Moka", "Haleland Park", "Bayshore", "Long Circular", "Lange Park", "Endeavour", "Cunupia",
  "Scarborough", "Crown Point", "Bon Accord", "Buccoo", "Black Rock", "Plymouth", "Mt Irvine", "Mount Irvine", "Lowlands", "Canaan",
  "Signal Hill", "Tobago", "Trinidad",
].sort((a, b) => b.length - a.length);

const CANON: Record<string, string> = { "west moorings": "Westmoorings", "st anns": "St. Ann's", "st clair": "St. Clair", "st james": "St. James", "st augustine": "St. Augustine", "new town": "Newtown", "mount irvine": "Mt Irvine" };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\./g, "\\.?").replace(/'/g, "['’]?");

export function findAreas(text: string): string[] {
  const devs = findDevelopments(text);
  const out: string[] = devs.map((d) => d.name);
  let rest = text;
  for (const d of devs) {
    for (const alias of d.aliases) rest = rest.replace(new RegExp(`\\b${esc(alias)}\\b`, "gi"), " ");
  }
  for (const a of AREAS) {
    const re = new RegExp(`\\b${esc(a)}\\b`, "i");
    if (re.test(rest)) {
      const name = CANON[a.toLowerCase().replace(/\\./g, "")] ?? a;
      if (!out.includes(name)) out.push(name);
      rest = rest.replace(new RegExp(`\\b${esc(a)}\\b`, "gi"), " ");
    }
  }
  const named = out.filter((a) => a !== "Trinidad" || (out.length === 1 && !CENTRAL_PHRASE.test(text)));
  // "central" / "central locations" is the group only when no more specific place was named.
  if (CENTRAL_PHRASE.test(text) && named.length === 0) return [CENTRAL_AREA];
  return named;
}

/* ---------------- What kind of place ---------------- */

const TYPES: [string, RegExp][] = [
  ["townhouse", /\btown\s?houses?\b/i],
  ["apartment", /\b(apartments?|apt|flat|(?<!storage\s)units?)\b/i],
  ["condo", /\b(condos?|condominiums?)\b/i],
  ["house", /\b(house|home|bungalow|villa)s?\b/i],
  ["land", /\b(land|lots?|acres?|plot)\b/i],
  ["commercial", /\b(commercial|office|warehouse|shop|retail|business space)\b/i],
];

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

export function findInterest(text: string): Interest {
  const rent = /\b(rent|rental|renting|lease|leasing|to let)\b/i.test(text);
  const buy = /\b(buy|buying|purchase|purchasing|for sale|mortgage)\b/i.test(text);
  const types = TYPES.filter(([t, re]) => re.test(t === "house" ? text.replace(/\btown\s?houses?\b/gi, " ") : text)).map(([t]) => t);
  if (findDevelopments(text).length && types.length === 0) types.unshift("apartment");
  const b = /\b(\d|one|two|three|four|five|six)\s?(?:-|\s)?(?:bed(?:room)?s?|br|bd)\b/i.exec(text);
  const bedrooms = b ? (NUMBERS[b[1].toLowerCase()] ?? Number(b[1])) : null;
  return { intent: rent && !buy ? "rent" : buy && !rent ? "buy" : rent && buy ? (text.search(/rent|lease/i) < text.search(/buy|purchas|sale/i) ? "rent" : "buy") : null, types, bedrooms };
}

/* ---------------- Names ---------------- */

const NAME = String.raw`([A-Z][a-z'’-]+(?:\s(?:[A-Z][a-z'’-]+|[A-Z]\.)){0,2})`;
/** A keyword in either case at its start ("client", "Client"), leaving the name after it case-sensitive. */
const ci = (...words: string[]) => words.map((w) => `[${w[0].toLowerCase()}${w[0].toUpperCase()}]${w.slice(1)}`).join("|");
const NAME_PATTERNS = [
  new RegExp(String.raw`\b(?:${ci("client", "lead", "buyer", "tenant", "customer", "prospect", "caller")})\b(?:'s)?\s(?:name\s)?(?:is\s|named\s|called\s|[:\-–]\s?)?${NAME}`, ""),
  new RegExp(String.raw`\b(?:[Nn]ame)\s?[:\-–]\s?${NAME}`, ""),
  new RegExp(String.raw`\b(?:[Cc]ontact|[Cc]all|[Mm]eet|[Ss]poke (?:to|with)|[Hh]eard from)\s${NAME}`, ""),
  new RegExp(String.raw`\b${NAME}\s(?:is|was)\s(?:looking|interested|asking|searching|wanting)`, ""),
];
const NOT_NAMES = new Set(["The", "This", "That", "She", "He", "They", "We", "I", "Hi", "Hello", "Good", "Please", "Anyone", "Someone", "Client", "Lead", "New", "Budget", "Name", "Can", "Need", "Viewing", "Tomorrow", "Today", ...AREAS]);

export function findNames(text: string): string[] {
  const out: string[] = [];
  for (const re of NAME_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const words = m[1].split(/\s/).filter((w) => !NOT_NAMES.has(w.replace(/[.'’]/g, "")) && !/^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/.test(w));
    const name = words.join(" ").trim();
    if (name.length >= 2 && !AREAS.some((a) => a.toLowerCase() === name.toLowerCase()) && !out.includes(name)) out.push(name);
  }
  return out;
}

/* ---------------- All of it ---------------- */

export function leadFacts(text: string): LeadFacts {
  return { names: findNames(text), phones: findPhones(text), emails: findEmails(text), budget: findBudget(text), areas: findAreas(text), interest: findInterest(text) };
}

const LEAD_WORDS = /\b(client|lead|buyer|tenant|prospect|looking for|search(?:ing)? for|in search (?:of|for)|interested in|enquir|inquir|wants? (?:to|a|an)|client\s+needs?|needs?|searching for|in the market|budget|is (?:it|this) (?:still )?available|for (?:rent|sale))\b/i;

/** Whether a message reads like a lead: lead words plus something concrete (contact, money, place, kind of property). */
export function looksLikeLead(text: string, f: LeadFacts = leadFacts(text)): boolean {
  if (!LEAD_WORDS.test(text)) return false;
  const concrete = [f.phones.length > 0 || f.emails.length > 0, !!f.budget, f.areas.length > 0, f.interest.types.length > 0 || f.interest.bedrooms !== null || f.interest.intent !== null].filter(Boolean).length;
  return concrete >= 2 || ((f.phones.length > 0 || f.emails.length > 0) && concrete >= 1);
}
