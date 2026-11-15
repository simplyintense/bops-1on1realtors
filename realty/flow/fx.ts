/**
 * US$ and TT$ for matching and scoring. A fixed rate, not a market rate: a USD budget or USD listing price is compared in TTD
 * with it (the price band, the score's price points, the duplicate folding), so asks and listings in different currencies can
 * match. The desk always shows the original money beside the TT$ figure. Portable: no node:*, no next, no bare process.
 */

export const USD_TO_TTD = 6.78; // fixed rate agreed with Miles 2026-11-14, for matching only

export const isUsd = (currency: string | null | undefined): boolean => (currency ?? "").trim().toUpperCase() === "USD";

/** The TTD value of an amount: USD at USD_TO_TTD (never a market rate), TTD or no currency as it is. */
export function ttdValue(amount: number, currency: string | null | undefined): number {
  return isUsd(currency) ? amount * USD_TO_TTD : amount;
}

const trimmed = (n: number) => String(Math.round(n * 100) / 100);

/** A figure short enough for a line: US$650k, TT$1.75m, TT$8,500. Millions keep two decimals at most. */
export function shortMoney(amount: number, currency: string): string {
  const sym = isUsd(currency) ? "US$" : "TT$";
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${sym}${trimmed(amount / 1_000_000)}m`;
  if (abs >= 100_000) return `${sym}${Math.round(amount / 1000)}k`;
  return `${sym}${Math.round(amount).toLocaleString("en-US")}`;
}

/**
 * A USD amount with its TT$ equivalent, e.g. "US$500k ≈ TT$3.39m". The CRM's own TTD equivalent wins when it has one. A TTD amount
 * is just its TT$ figure.
 */
export function moneyWithTtd(amount: number, currency: string, ttdEquiv?: number | null): string {
  if (!isUsd(currency)) return shortMoney(amount, "TTD");
  return `${shortMoney(amount, "USD")} ≈ ${shortMoney(ttdEquiv || ttdValue(amount, "USD"), "TTD")}`;
}
