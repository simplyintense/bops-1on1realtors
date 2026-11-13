import { areaKey, type MatchTier, type ToolCaller } from "./areas.ts";

/**
 * Data collection for the geography rules, not a change to them. Each explicit staff decision (an agent's
 * approveMatches or rejectMatches) leaves one record per candidate pair: the inquiry area, the listing area,
 * the tier the ranking gave, and the signal. Nothing here changes a tier yet.
 *
 * The records are the local truth. The same pair is also sent to market-mcp as learn_area_neighbour, but only
 * when ONEON1_MARKET_SEARCH_URL and _TOKEN are both set; otherwise the send is a dry run and the record is all
 * there is. Nothing is replayed in bulk, and a failed send keeps the local record.
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

/** What the flow is given: the store, and optionally a sender for learn_area_neighbour (one call per record). */
export type AreaLearning = {
  store: AreaPairStore;
  send?: (pair: AreaPair) => Promise<void>;
};

/** The pair for one candidate, or null when there's nothing to learn (no inquiry area, no listing area, or tier "any"). */
export function pairFor(inquiryArea: string | null, listingArea: string | null, tier: MatchTier, signal: LearnSignal, at: string): AreaPair | null {
  if (!inquiryArea || !listingArea || tier === "any") return null;
  return { inquiryArea, listingArea, tier, signal, at };
}

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

export type LearnOutcome = "dry-run" | "sent" | "failed";

/**
 * One tools/call on market-mcp for a learning record, or a dry run when there's no caller (the market
 * isn't configured). Never throws: a failure is "failed", and the local record stays.
 */
export async function learnOnMarket(caller: ToolCaller | null, tool: "learn_area_neighbour" | "learn_area_alias", args: Record<string, unknown>): Promise<LearnOutcome> {
  if (!caller) return "dry-run";
  try {
    await caller.callTool(tool, args);
    return "sent";
  } catch {
    return "failed";
  }
}
