import { areaKey, type MatchTier } from "./areas.ts";

/**
 * Data collection for the geography rules, not a change to them. Each explicit staff decision (an agent's
 * approveMatches or rejectMatches) leaves one record per candidate pair: the inquiry area, the listing area,
 * the tier the ranking gave, and the signal. Nothing here changes a tier or a weight.
 *
 * The records are local only: realty/node/area-store.ts appends them to pairs.jsonl. Nothing is sent to
 * market-mcp, and nothing is replayed in bulk.
 */

export type LearnSignal = "approved" | "rejected";
/** A pair is recorded only with a real tier: "any" (no inquiry area) has nothing to learn. */
export type LearnedTier = Exclude<MatchTier, "any">;

export type AreaPair = {
  inquiryArea: string;
  listingArea: string;
  tier: LearnedTier;
  signal: LearnSignal;
  at: string;
};

/** Where the records live. The Node store (realty/node/area-store.ts) appends to a JSONL file. */
export interface AreaPairStore {
  pairs(): AreaPair[];
  add(pair: AreaPair): void;
}

export class MemoryAreaPairStore implements AreaPairStore {
  private rows: AreaPair[] = [];

  pairs(): AreaPair[] {
    return structuredClone(this.rows);
  }

  add(pair: AreaPair): void {
    this.rows.push({ ...pair });
  }
}

/** The pair for one candidate, or null when there's nothing to learn (no inquiry area, no listing area, or tier "any"). */
export function pairFor(inquiryArea: string | null, listingArea: string | null, tier: MatchTier, signal: LearnSignal, at: string): AreaPair | null {
  if (!inquiryArea || !listingArea || tier === "any") return null;
  return { inquiryArea, listingArea, tier, signal, at };
}

// TODO: send these pairs to market-ingest as kind "neighbour" (one item per pair), so Builder can use them. Hold
// until Miles approves automatic neighbour-weight changes; until then the pairs stay local.

export type PairCount = { inquiryArea: string; listingArea: string; tier: LearnedTier; approved: number; rejected: number };

export type AreaLearningStats = {
  total: number;
  bySignal: { approved: number; rejected: number };
  byTier: { tier: LearnedTier; approved: number; rejected: number }[];
  /** Busiest pairs first; the names are as first recorded. */
  byPair: PairCount[];
};

const TIERS: LearnedTier[] = ["same-area", "neighbour", "same-region"];

/** Counts by signal, by tier and by pair (areas compared with areaKey). */
export function aggregatePairs(pairs: AreaPair[]): AreaLearningStats {
  const bySignal = { approved: 0, rejected: 0 };
  const byTier = TIERS.map((tier) => ({ tier, approved: 0, rejected: 0 }));
  const byPair = new Map<string, PairCount>();
  for (const p of pairs) {
    bySignal[p.signal] += 1;
    const t = byTier.find((x) => x.tier === p.tier);
    if (t) t[p.signal] += 1;
    const key = `${areaKey(p.inquiryArea)}|${areaKey(p.listingArea)}|${p.tier}`;
    let c = byPair.get(key);
    if (!c) {
      c = { inquiryArea: p.inquiryArea, listingArea: p.listingArea, tier: p.tier, approved: 0, rejected: 0 };
      byPair.set(key, c);
    }
    c[p.signal] += 1;
  }
  const pairsSorted = [...byPair.values()].sort((a, b) => b.approved + b.rejected - (a.approved + a.rejected) || a.inquiryArea.localeCompare(b.inquiryArea));
  return { total: pairs.length, bySignal, byTier, byPair: pairsSorted };
}
