/**
 * The first-review Auto-Match set: the matches shared for feedback on 15 Nov 2026, plus any
 * still-suppressed baseline keys. Used only by the one-shot send. Portable: no node:*, no next, no bare process.
 */

export type ReviewSeed = {
  listingUrl: string;
  askArea: string;
  listingType: "sale" | "rent";
  budget: number;
};

/** The 11 first-review matches, identified by listing URL and the ask (area, sale/rent, budget). */
export const FIRST_REVIEW_SEEDS: readonly ReviewSeed[] = [
  { listingUrl: "https://1on1realtors.com/property/maraval-3bed-residential-for-sale-1382", askArea: "Maraval", listingType: "sale", budget: 4_300_000 },
  { listingUrl: "https://1on1realtors.com/property/maraval-3bed-residential-for-sale-1268", askArea: "Goodwood Park", listingType: "sale", budget: 2_400_000 },
  { listingUrl: "https://1on1realtors.com/property/fort-george-3bed-residential-for-sale-1182", askArea: "Goodwood Park", listingType: "sale", budget: 2_400_000 },
  { listingUrl: "https://1on1realtors.com/property/barataria-3bed-residential-for-rent-1283", askArea: "Santa Cruz", listingType: "rent", budget: 7_000 },
  { listingUrl: "https://1on1realtors.com/property/valsayn-3bed-residential-for-sale-1397", askArea: "Valsayn", listingType: "sale", budget: 2_950_000 },
  { listingUrl: "https://1on1realtors.com/property/port-of-spain-0bed-commercial-for-sale-1074", askArea: "Central locations", listingType: "sale", budget: 7_000_000 },
  { listingUrl: "https://1on1realtors.com/property/calder-hill-scarborough-residential-for-sale-1325", askArea: "Tobago", listingType: "sale", budget: 850_000 },
  { listingUrl: "https://1on1realtors.com/property/maraval-4bed-residential-for-sale-1356", askArea: "Haleland Park", listingType: "sale", budget: 6_000_000 },
  { listingUrl: "https://1on1realtors.com/property/carenage-2bed-residential-for-rent-1366", askArea: "Westmoorings", listingType: "rent", budget: 15_000 },
  { listingUrl: "https://1on1realtors.com/property/valsayn-3bed-residential-for-sale-1397", askArea: "Tunapuna", listingType: "sale", budget: 3_500_000 },
  { listingUrl: "https://1on1realtors.com/property/d-abadie-5bed-residential-for-sale-1363", askArea: "Tunapuna", listingType: "sale", budget: 3_500_000 },
];

export function normListingUrl(url: string | null | undefined): string {
  return (url ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

export type ReviewPair<T> = T & {
  listingKey: string;
  listing: { url?: string | null };
  ask: { postId?: string | null; area?: string | null; listingType?: "sale" | "rent" | null; budget?: number | null };
};

export type ReviewResolution<T> = {
  seed: ReviewSeed;
  pair: T | null;
};

/**
 * Resolve each first-review seed to at most one current pair. A pair is used at most once.
 * Preference: exact listing URL, then exact sale/rent, exact budget, then case-insensitive area.
 */
export function resolveReviewSeeds<T extends ReviewPair<unknown>>(pairs: readonly T[], seeds: readonly ReviewSeed[] = FIRST_REVIEW_SEEDS): ReviewResolution<T>[] {
  const used = new Set<string>();
  const byUrl = new Map<string, T[]>();
  for (const p of pairs) {
    const u = normListingUrl(p.listing.url);
    if (!u) continue;
    const list = byUrl.get(u) ?? [];
    list.push(p);
    byUrl.set(u, list);
  }
  return seeds.map((seed) => {
    const cands = (byUrl.get(normListingUrl(seed.listingUrl)) ?? []).filter((p) => p.ask.postId && !used.has(`${p.ask.postId}|${p.listingKey}`));
    if (!cands.length) return { seed, pair: null };
    const ranked = cands.slice().sort((a, b) => reviewFit(seed, b) - reviewFit(seed, a));
    const pair = ranked[0];
    if (reviewFit(seed, pair) <= 0) return { seed, pair: null };
    used.add(`${pair.ask.postId}|${pair.listingKey}`);
    return { seed, pair };
  });
}

export function reviewFit(seed: ReviewSeed, p: ReviewPair<unknown>): number {
  if (normListingUrl(p.listing.url) !== normListingUrl(seed.listingUrl)) return 0;
  let n = 1;
  if ((p.ask.listingType ?? "") === seed.listingType) n += 4;
  if (p.ask.budget != null && p.ask.budget === seed.budget) n += 4;
  const area = (p.ask.area ?? "").trim().toLowerCase();
  if (area && area === seed.askArea.trim().toLowerCase()) n += 4;
  return n;
}

export function reviewKeysOf<T extends ReviewPair<unknown>>(resolved: readonly ReviewResolution<T>[]): Set<string> {
  const keys = new Set<string>();
  for (const r of resolved) {
    if (r.pair?.ask.postId) keys.add(`${r.pair.ask.postId}|${r.pair.listingKey}`);
  }
  return keys;
}
