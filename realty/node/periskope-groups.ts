import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeEnv, type Env } from "../flow/env.ts";
import { denyChatIdsFromEnv } from "../flow/periskope.ts";

/**
 * The single source of truth for which Periskope groups Bops listens to. The poller (periskope-poll.ts) reads
 * them with GET, and the webhook (periskope-intake.ts) accepts the same set, so the two never disagree. Both
 * call pollGroups. Nothing here calls Periskope or writes anything except the roster file's reader.
 *
 * The set is: the pinned groups (INTAKE_GROUPS, in code) plus the auto-discovered ones in the roster
 * (<root>/groups.json, written by periskope-discover.ts), minus PERISKOPE_DENY_CHAT_IDS (deny always wins).
 * The webhook also takes the env allowlist (PERISKOPE_ALLOWED_GROUPS / PERISKOPE_ALLOWED_CHAT_IDS); see
 * allowlistCheck in flow/periskope.ts.
 */

/** The listen-only groups Miles allowlisted (pinned in code). Auto-discovered groups are added on top: periskope-discover.ts. */
export const INTAKE_GROUPS = [
  { chatId: "18686789715-1444916451@g.us", chatName: "AREA Registered Agents" },
  { chatId: "120363139007270954@g.us", chatName: "R. E. SEARCHES ONLY" },
  { chatId: "18686209603-1626217638@g.us", chatName: "🇹🇹🏡 Anything Real Estate❤️" },
  { chatId: "18686894126-1467511703@g.us", chatName: "REAL ESTATE AGENTS OF T&T" },
  { chatId: "18683898353-1597076235@g.us", chatName: "Top Notch Realtors" },
  { chatId: "18687143939-1555072973@g.us", chatName: "T&T Realty Co Broke Group" },
  { chatId: "120363421375699959@g.us", chatName: "Co-Broke 🤝" },
] as const;

/** The brokerage's own staff chats. Matched against the group name; an auto-discovered group with one of these names is never polled. */
export const INTERNAL_NAME: RegExp[] = [/1\s*on\s*1/i, /1on1/i];

export type RosterRow = { chatId: string; chatName: string; memberCount: number | null; addedAt: string; source: "pinned" | "auto" };

export const rosterPath = (root: string) => join(root, "groups.json");

export function loadRoster(root: string): RosterRow[] {
  try {
    const v = JSON.parse(readFileSync(rosterPath(root), "utf8")) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is RosterRow =>
        !!r && typeof r === "object" && typeof (r as RosterRow).chatId === "string" && typeof (r as RosterRow).chatName === "string" && ((r as RosterRow).source === "pinned" || (r as RosterRow).source === "auto"),
    );
  } catch {
    return [];
  }
}

/** A group the poll reads (and the webhook accepts): its id, name, and where it came from. */
export type PollGroup = { chatId: string; chatName: string; source: "pinned" | "auto" };

/**
 * The groups Bops listens to: pinned ones from code, plus auto ones from the roster, minus PERISKOPE_DENY_CHAT_IDS.
 * The poller polls exactly this list; the webhook accepts exactly this list (plus the env allowlist) minus the deny list.
 */
export function pollGroups(root: string, env: Env = runtimeEnv()): PollGroup[] {
  const out = new Map<string, PollGroup>();
  for (const g of INTAKE_GROUPS) out.set(g.chatId, { chatId: g.chatId, chatName: g.chatName, source: "pinned" });
  for (const r of loadRoster(root)) {
    if (r.source !== "auto" || out.has(r.chatId)) continue;
    if (INTERNAL_NAME.some((re) => re.test(r.chatName))) continue;
    out.set(r.chatId, { chatId: r.chatId, chatName: r.chatName, source: "auto" });
  }
  const deny = new Set(denyChatIdsFromEnv(env));
  return [...out.values()].filter((g) => !deny.has(g.chatId));
}
