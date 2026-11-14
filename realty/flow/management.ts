/**
 * Messages that belong to management, not the lead flow. These are only ever flagged for a person;
 * nothing here is (or may later be) acted on automatically. Keyword heuristics, deliberately narrow:
 * an ordinary buyer question ("what's the price?") is not flagged.
 */

export type ManagementFlag = "commissions_invoicing" | "price_contract_changes" | "compliance_docs" | "complaints" | "unusual_deals";

/** Management-only: never auto-acted, always handed to a person. */
export const MANAGEMENT_ONLY: readonly ManagementFlag[] = [
  "commissions_invoicing",
  "price_contract_changes",
  "compliance_docs",
  "complaints",
  "unusual_deals",
];

const RULES: [ManagementFlag, RegExp[]][] = [
  ["commissions_invoicing", [
    /\binvoic(e|es|ed|ing)\b/,
    /\bcommissions?\b.{0,40}\b(split|owed|due|paid|payment|pay|cheque|dispute)\b/,
    /\b(split|owed|due|pay|payment of|dispute)\b.{0,40}\bcommissions?\b/,
  ]],
  ["price_contract_changes", [
    /\b(change|lower|reduce|raise|increase|drop|adjust|revise|update)\b.{0,20}\b(asking|listing|list) price\b/,
    /\b(amend|change|modify|revise|cancel|terminate|break|extend)\b.{0,20}\b(contract|agreement|lease)\b/,
    /\b(contract|lease) (amendment|variation)\b/,
  ]],
  ["compliance_docs", [
    /\btitle deeds?\b/,
    /\bkyc\b/,
    /\bcompliance\b/,
    /\b(aml|anti[- ]money laundering)\b/,
    /\bsource of funds\b/,
  ]],
  ["complaints", [/\bcomplain(t|ts|ed|ing)?\b/]],
  ["unusual_deals", [
    /\bunusual\b.{0,20}\b(deal|arrangement|offer|payment|request)\b/,
    /\b(deal|arrangement|offer|payment)\b.{0,20}\bunusual\b/,
    /\boff[- ]market\b/,
    /\bunder the table\b/,
    /\bside deal\b/,
    /\bunder[- ]?declare/,
  ]],
];

export function managementFlags(text: string): ManagementFlag[] {
  // "no complaints" is praise, not a complaint.
  const t = text.toLowerCase().replace(/\bno complaints?\b/g, "");
  return RULES.filter(([, res]) => res.some((re) => re.test(t))).map(([flag]) => flag);
}
