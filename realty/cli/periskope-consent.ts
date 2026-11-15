import { INTAKE_GROUPS } from "../node/periskope-backfill.ts";
import { setConsent, listConsents } from "../node/periskope-intake.ts";
import { waiverPatch } from "../node/periskope-discover.ts";
import { periskopeRoot } from "../node/periskope-root.ts";

/**
 * Record Miles's owner waiver on the pinned groups (the same waiver the poller records for auto-discovered ones:
 * OWNER_WAIVER in periskope-discover.ts). Usage:
 *   node --experimental-strip-types realty/cli/periskope-consent.ts --root /app/.data/realty/periskope
 * Does not post in WhatsApp. noticePostedAt stays null. Prints chat ids and completeness only.
 *
 * The recorded approval is OWNER_WAIVER.at (2026-11-14T13:39:00.000Z, 9:39 AM AST); adminOkBy "Miles Abraham";
 * noticeWaivedBy "owner".
 */

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const root = arg("root", periskopeRoot());
const opts = { root };

if (process.argv.includes("--list")) {
  const rows = await listConsents(opts);
  console.log(JSON.stringify(rows.map((c) => ({
    chatId: c.chatId,
    groupName: c.groupName,
    hasPostedNotice: Boolean(c.noticePostedAt),
    waived: Boolean(c.noticeWaivedAt),
    adminOk: Boolean(c.adminOkAt),
    active: c.active !== false,
  })), null, 2));
  process.exit(0);
}

const written = [];
for (const g of INTAKE_GROUPS) {
  const row = await setConsent(waiverPatch(g.chatId, g.chatName), opts);
  written.push({
    chatId: row.chatId,
    groupName: row.groupName,
    hasPostedNotice: Boolean(row.noticePostedAt),
    waived: Boolean(row.noticeWaivedAt),
    adminOk: Boolean(row.adminOkAt),
    active: row.active !== false,
  });
}
console.log(JSON.stringify({ root, groups: written }, null, 2));
