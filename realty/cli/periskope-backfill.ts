import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INTAKE_GROUPS, backfillGroup } from "../node/periskope-backfill.ts";
import { postsToCsv } from "../node/group-posts.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";

/**
 * One-time listen-only backfill of the allowlisted Periskope groups. Usage:
 *   node --experimental-strip-types realty/cli/periskope-backfill.ts --days 7 --csv /path/to.csv
 * API key from PERISKOPE_API_KEY or --key-file (never printed). Optional --phone-id, --root.
 * --chat-id and --chat-name limit it to one group; otherwise all INTAKE_GROUPS are read.
 * Writes counts only to stdout (no message text, no phone numbers). The CSV holds original text and phones; don't print it.
 */

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : "";
  return (v && !v.startsWith("--") ? v : fallback).trim();
}

const keyFile = arg("key-file");
const apiKey = (keyFile ? readFileSync(keyFile, "utf8") : process.env.PERISKOPE_API_KEY ?? "").trim();
if (!apiKey) {
  console.error("PERISKOPE_API_KEY is not set (or --key-file is missing)");
  process.exit(1);
}

const root = arg("root", join(process.cwd(), ".data", "realty", "periskope"));
const days = Math.max(1, Number(arg("days", "7")) || 7);
const onlyId = arg("chat-id");
const onlyName = arg("chat-name");
const phoneId = arg("phone-id") || undefined;
const csvPath = arg("csv");

const groups = onlyId
  ? [{ chatId: onlyId, chatName: onlyName || (INTAKE_GROUPS.find((g) => g.chatId === onlyId)?.chatName ?? onlyId) }]
  : [...INTAKE_GROUPS];

const reports: unknown[] = [];
for (const g of groups) {
  const result = await backfillGroup({
    apiKey,
    chatId: g.chatId,
    chatName: g.chatName,
    days,
    phoneId,
    opts: { root },
  });
  if (!result.ok) {
    console.error(`backfill failed for ${g.chatName}: ${result.error}`);
    process.exit(1);
  }
  const { counts } = result;
  reports.push({
    chatId: g.chatId,
    chatName: g.chatName,
    days,
    fetched: counts.fetched,
    parseFailures: counts.parseFailures,
    added: counts.added,
    refilled: counts.refilled,
    unchanged: counts.unchanged,
    ignored: counts.ignored,
    dropped: counts.dropped,
    categories: counts.categories,
    cobroke: counts.cobroke,
    distinctAgents: counts.distinctAgents,
    withNameAndPhone: counts.withNameAndPhone,
    withPhone: counts.withPhone,
    marketMatches: counts.marketMatches,
    crmMatches: counts.crmMatches,
    matchedRequests: counts.matchedRequests,
    photosStored: counts.photosStored,
    photoUrlsKept: counts.photoUrlsKept,
    byResult: counts.byResult,
    supply: (counts.categories["listing_for_sale"] ?? 0) + (counts.categories["listing_for_rent"] ?? 0) + (counts.categories["cobroke"] ?? 0),
    demand: (counts.categories["buyer_request"] ?? 0) + (counts.categories["rental_request"] ?? 0),
  });
}

console.log(JSON.stringify({ groups: reports }));

if (csvPath) {
  mkdirSync(dirname(csvPath), { recursive: true, mode: 0o700 });
  writeFileSync(csvPath, postsToCsv(new PeriskopeStore(root)), { mode: 0o600 });
  console.log(JSON.stringify({ csv: csvPath, rows: new PeriskopeStore(root).posts().length }));
}
