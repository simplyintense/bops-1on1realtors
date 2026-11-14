import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AliasTable, CompositeAreaResolver, MarketAreaResolver, type AreaResolver } from "../flow/areas.ts";
import { runtimeEnv, type Env } from "../flow/env.ts";
import type { AreaPair, AreaPairStore } from "../flow/area-learning.ts";
import { aliasItem, marketWriteConfigFromEnv, postMarketItem } from "../flow/periskope.ts";
import { marketConfigFromEnv, MarketClient } from "../flow/market-search.ts";
import { appendJsonl } from "./jsonl.ts";

/**
 * Node-only I/O for the area rules: staff aliases and the approve/reject pair records, both JSONL under one
 * root (default .data/realty/areas, 0700 dir, 0600 files, as the other realty stores). The rules are in
 * realty/flow/areas.ts and realty/flow/area-learning.ts.
 *
 *   aliases.jsonl  one row per staff mapping: { alias, canonical, at, market }. The last row for an alias wins.
 *                  market is dry-run (no ONEON1_MARKET_WRITE_URL, no ONEON1_MARKET_INGEST_TOKEN, or
 *                  ONEON1_MARKET_ALIAS_WRITE is not 1/true), sent, or failed. A row is posted to market-ingest as
 *                  kind "alias" (periskope.ts) only when all three are set; listings, requests and groups do not need the flag.
 *   pairs.jsonl    one row per approve/reject decision on one candidate (AreaPair). Local only, never bulk-replayed.
 */

const ALIAS_FILE = "aliases.jsonl";
const PAIR_FILE = "pairs.jsonl";
const NAME_MAX = 80;

export type AliasRow = { alias: string; canonical: string; at: string; market: "dry-run" | "sent" | "failed" };

/** The default root: .data/realty/areas under the working directory. */
export function defaultAreasRoot(): string {
  return join(process.cwd(), ".data", "realty", "areas");
}

function readRows<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        // A torn line from a crash: skip it.
        return [];
      }
    });
}

export class AreaStore implements AreaPairStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  aliasRows(): AliasRow[] {
    return readRows<AliasRow>(join(this.root, ALIAS_FILE));
  }

  /** The local alias table, as it is now: the flow reads it fresh for each intake. */
  aliasTable(): AliasTable {
    return new AliasTable(this.aliasRows());
  }

  addAlias(row: AliasRow): void {
    appendJsonl(join(this.root, ALIAS_FILE), JSON.stringify(row));
  }

  pairs(): AreaPair[] {
    return readRows<AreaPair>(join(this.root, PAIR_FILE));
  }

  add(pair: AreaPair): void {
    appendJsonl(join(this.root, PAIR_FILE), JSON.stringify(pair));
  }
}

/** The market client when ONEON1_MARKET_SEARCH_URL and _TOKEN are both set; null otherwise (exact text). */
function marketClientFrom(env: Env, fetcher?: typeof fetch): MarketClient | null {
  const cfg = marketConfigFromEnv(env);
  return cfg ? new MarketClient(cfg, fetcher) : null;
}

/**
 * The area resolver for a flow, from the environment. Aliases are read from the store now; the market's
 * resolve_area is used only when the market search is configured, and exact text otherwise.
 */
export function areasFromEnv(store: AreaStore, env: Env = runtimeEnv(), fetcher?: typeof fetch): AreaResolver {
  const client = marketClientFrom(env, fetcher);
  return new CompositeAreaResolver({ aliases: store.aliasTable(), market: client ? new MarketAreaResolver(client) : null });
}

function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t && t.length <= NAME_MAX ? t : null;
}

export type MapAliasResult = { ok: true; row: AliasRow } | { ok: false; error: string };

/**
 * Alias posts stay dry-run until market-ingest accepts kind "alias": ONEON1_MARKET_ALIAS_WRITE must be "1" or
 * "true" (trimmed; "true" in any case). Anything else, or unset, is off. Listings, requests and groups don't use this.
 */
export function aliasWriteOn(env: Env): boolean {
  const v = (env.ONEON1_MARKET_ALIAS_WRITE ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * A staff mapping of one alias to a canonical area. One POST to market-ingest (kind "alias") only when
 * ONEON1_MARKET_WRITE_URL, ONEON1_MARKET_INGEST_TOKEN and ONEON1_MARKET_ALIAS_WRITE (1 or true) are all set.
 * Otherwise a dry run, with no network: flag off, or the write URL or token missing. The row records the outcome.
 * A failed post keeps the row (market: "failed"); it never fails the mapping. The caller checks staff access (staffAccess).
 */
export async function mapAreaAlias(body: unknown, o: { store: AreaStore; env?: Env; fetcher?: typeof fetch; now?: Date }): Promise<MapAliasResult> {
  const b = (typeof body === "object" && body !== null ? body : {}) as { alias?: unknown; canonical?: unknown };
  const alias = cleanName(b.alias);
  const canonical = cleanName(b.canonical);
  if (!alias || !canonical) return { ok: false, error: `send JSON with alias and canonical (text, up to ${NAME_MAX} characters)` };
  const env = o.env ?? runtimeEnv();
  const cfg = marketWriteConfigFromEnv(env);
  let market: AliasRow["market"] = "dry-run";
  if (cfg && aliasWriteOn(env)) market = (await postMarketItem(cfg, aliasItem(alias, canonical), o.fetcher)).ok ? "sent" : "failed";
  const row: AliasRow = { alias, canonical, at: (o.now ?? new Date()).toISOString(), market };
  o.store.addAlias(row);
  return { ok: true, row };
}
