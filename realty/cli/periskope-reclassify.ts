import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveRequest } from "../flow/live-match.ts";
import { crmSourceFromEnv } from "../flow/live-crm.ts";
import { veryStrongOurListings } from "../flow/observe.ts";
import { reparsePost } from "../flow/periskope.ts";
import { postsToCsv } from "../node/group-posts.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";

/**
 * Re-parse stored posts with the current classifier, rebuild supply/demand/price ranges, rematch
 * very-strong CRM alerts, and write a CSV. Never sends. Counts only are printed (no phones, no text).
 *
 *   node --experimental-strip-types realty/cli/periskope-reclassify.ts --root /app/.data/realty/periskope --csv /tmp/periskope-groups-7d.csv
 */

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = arg("root", join(process.cwd(), ".data", "realty", "periskope"));
const csvPath = arg("csv", "");
const store = new PeriskopeStore(root);
const before = { posts: store.posts().length, supply: store.supply().length, demand: store.demand().length, other: 0, alerts: store.alerts().length };
before.other = before.posts - before.supply - before.demand;

const posts = store.posts().map((p) => reparsePost(p));
const prior = new Map(store.posts().map((p) => [p.messageId, p.set ?? null]));
const toSupply = posts.filter((p) => p.set === "supply" && prior.get(p.messageId) === "demand").length;
const toDemand = posts.filter((p) => p.set === "demand" && prior.get(p.messageId) === "supply").length;
store.reprojectObservation(posts);

const listings = await crmSourceFromEnv().listings();
const alerts = [];
for (const p of store.demand()) {
  const intent = p.intent === "rent" || p.listingType === "rent" ? "rent" as const : p.intent === "buy" || p.listingType === "sale" ? "buy" as const : null;
  if (!intent || !p.area || p.beds == null || p.price == null) continue;
  const request: LiveRequest = {
    intent,
    area: p.area,
    beds: p.beds,
    propertyType: p.type,
    priceMin: p.price,
    priceMax: p.price,
    currency: p.currency === "USD" || p.currency === "TTD" ? p.currency : "TTD",
    monthly: intent === "rent",
  };
  for (const m of veryStrongOurListings(request, listings)) {
    alerts.push({
      at: p.sentAt,
      messageId: p.messageId,
      chatId: p.chatId,
      groupName: p.groupName ?? null,
      requestArea: p.area,
      requestBeds: p.beds,
      requestBudget: p.price,
      currency: request.currency,
      listingType: intent === "rent" ? "rent" as const : "sale" as const,
      listingTitle: m.title,
      listingArea: m.area,
      listingPrice: m.price,
      listingBeds: m.beds,
      listingUrl: m.url,
      reason: m.reason ?? "very strong match",
    });
  }
}
store.replaceAlerts(alerts);

const byGroup: Record<string, { posts: number; supply: number; demand: number; other: number }> = {};
for (const p of store.posts()) {
  const g = p.groupName ?? p.chatId;
  const row = byGroup[g] ?? (byGroup[g] = { posts: 0, supply: 0, demand: 0, other: 0 });
  row.posts += 1;
  if (p.set === "supply") row.supply += 1;
  else if (p.set === "demand") row.demand += 1;
  else row.other += 1;
}

if (csvPath) {
  writeFileSync(csvPath, postsToCsv(store), { mode: 0o600 });
}

console.log(JSON.stringify({
  root,
  csv: csvPath || null,
  before,
  after: {
    posts: store.posts().length,
    supply: store.supply().length,
    demand: store.demand().length,
    other: store.posts().length - store.supply().length - store.demand().length,
    priceRangeRows: store.priceRanges().length,
    alerts: store.alerts().length,
  },
  movedToSupply: toSupply,
  movedToDemand: toDemand,
  byGroup,
  alertsByGroup: store.alerts().reduce((m: Record<string, number>, a) => {
    const g = a.groupName ?? "?";
    m[g] = (m[g] ?? 0) + 1;
    return m;
  }, {}),
  alerts: store.alerts().map((a) => ({
    groupName: a.groupName,
    requestArea: a.requestArea,
    requestBeds: a.requestBeds,
    requestBudget: a.requestBudget,
    currency: a.currency,
    listingType: a.listingType,
    listingTitle: a.listingTitle,
    listingArea: a.listingArea,
    listingPrice: a.listingPrice,
    listingBeds: a.listingBeds,
    listingUrl: a.listingUrl,
    reason: a.reason,
  })),
}, null, 2));
