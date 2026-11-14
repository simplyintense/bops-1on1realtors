import { join } from "node:path";
import { crmSourceFromEnv } from "../flow/live-crm.ts";
import type { LiveRequest } from "../flow/live-match.ts";
import { veryStrongOurListings } from "../flow/observe.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";

/**
 * Rematch stored demand posts against our CRM and write very-strong alerts only.
 * Usage: node --experimental-strip-types realty/cli/periskope-rematch.ts --root /app/.data/realty/periskope
 * Never sends, flags, or unflags. Prints counts and alert summaries (no message text, no phones).
 */

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = arg("root", join(process.cwd(), ".data", "realty", "periskope"));
const store = new PeriskopeStore(root);
const listings = await crmSourceFromEnv().listings();
let considered = 0;
let eligible = 0;
let alertsAdded = 0;
const byGroup: Record<string, number> = {};

for (const p of store.demand()) {
  considered += 1;
  const intent = p.intent === "rent" || p.listingType === "rent" ? "rent" : p.intent === "buy" || p.listingType === "sale" ? "buy" : null;
  if (!intent || !p.area || p.beds == null || p.price == null) continue;
  eligible += 1;
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
    const added = store.addAlert({
      at: p.sentAt,
      messageId: p.messageId,
      chatId: p.chatId,
      groupName: p.groupName ?? null,
      requestArea: p.area,
      requestBeds: p.beds,
      requestBudget: p.price,
      currency: request.currency,
      listingType: intent === "rent" ? "rent" : "sale",
      listingTitle: m.title,
      listingArea: m.area,
      listingPrice: m.price,
      listingBeds: m.beds,
      listingUrl: m.url,
      reason: m.reason ?? "very strong match",
    });
    if (added) {
      alertsAdded += 1;
      const g = p.groupName ?? p.chatId;
      byGroup[g] = (byGroup[g] ?? 0) + 1;
    }
  }
}

console.log(JSON.stringify({
  root,
  listingCount: listings.length,
  demand: considered,
  eligible,
  alertsAdded,
  alertsTotal: store.alerts().length,
  alertsByGroup: byGroup,
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
