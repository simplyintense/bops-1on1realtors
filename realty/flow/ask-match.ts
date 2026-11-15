import { developmentOf } from "../extract.ts";
import { ttdValue } from "./fx.ts";
import { placeKey } from "./taught-areas.ts";

/**
 * When two demand asks are the same ask: one person asking for the same thing again. The search store folds such posts into one
 * demand record (within ASK_FOLD_DAYS of the record's last sighting). Supply is never folded by this rule: two listings at close
 * prices can be different units, so the store folds a supply repost only on the identical parsed listing. Automatch folds the
 * near-identical asks that are still left, per sender and listing. Both sides are the parsed fields, so one rule serves both. Pure.
 *
 * Same when: the category and sale or rent agree; the same place, or a development and its parent area; beds agree (no beds
 * matches no beds only); the type agrees (a house and a townhouse agree), or one side gives none; the budget is within ASK_BUDGET_TOLERANCE in TT$. An ask with
 * no place, no beds and no budget is never the same as another, so two underspecified asks (a Carnival rental for one person and
 * one for eight) stay apart.
 */

export const ASK_BUDGET_TOLERANCE = 0.1;
/** The store's fold window: a newer sighting within this many days of the record's last sighting. */
export const ASK_FOLD_DAYS = 14;

export type AskFacts = {
  category?: string | null;
  area: string | null;
  development: string | null;
  beds: number | null;
  /** The budget in `currency` (a single figure), or null. */
  price: number | null;
  currency: string | null;
  type: string | null;
  listingType: string | null;
};

type Place = { dev: string | null; area: string | null; parent: string | null; any: boolean };

/** The place of an ask: its development (a development named as the area counts), its own area, and the development's parent. */
function placeOf(x: AskFacts): Place {
  const devName = x.development ?? (x.area && developmentOf(x.area) ? x.area : null);
  const d = devName ? developmentOf(devName) : null;
  const dev = devName ? placeKey(d?.name ?? devName) : null;
  const area = x.area && (!dev || placeKey(x.area) !== dev) ? placeKey(x.area) : null;
  const parent = d?.parent ? placeKey(d.parent) : null;
  return { dev, area, parent, any: !!(dev || area) };
}

/** Two developments are the same place; otherwise the broad area (own area, else the parent of its development) must be the same. */
function samePlace(a: AskFacts, b: AskFacts): boolean {
  const pa = placeOf(a);
  const pb = placeOf(b);
  if (!pa.any || !pb.any) return false;
  if (pa.dev && pb.dev) return pa.dev === pb.dev;
  const broadA = pa.area ?? pa.parent;
  return !!broadA && broadA === (pb.area ?? pb.parent);
}

function budgetSame(a: AskFacts, b: AskFacts): boolean {
  if (a.price == null || b.price == null) return a.price == null && b.price == null;
  const x = ttdValue(a.price, a.currency);
  const y = ttdValue(b.price, b.currency);
  return Math.abs(x - y) <= ASK_BUDGET_TOLERANCE * Math.max(x, y);
}

/** Kinds people use for the same ask: a "house" and a "townhouse" from one sender are one ask (parsing varies between reposts). */
const TYPE_FAMILY: Record<string, string> = { house: "house", townhouse: "house" };
const typeKey = (t: string) => {
  const k = t.trim().toLowerCase();
  return TYPE_FAMILY[k] ?? k;
};
const typeSame = (a: string | null, b: string | null) => !a || !b || typeKey(a) === typeKey(b);

/** The same ask (see the header). Pure; the time window is the caller's. */
export function sameDemandAsk(a: AskFacts, b: AskFacts): boolean {
  const underspecified = !placeOf(a).any && !placeOf(b).any && a.beds == null && b.beds == null && a.price == null && b.price == null;
  if (underspecified) return false;
  return (
    (a.category ?? null) === (b.category ?? null) &&
    (a.listingType ?? null) === (b.listingType ?? null) &&
    samePlace(a, b) &&
    (a.beds ?? null) === (b.beds ?? null) &&
    typeSame(a.type, b.type) &&
    budgetSame(a, b)
  );
}
