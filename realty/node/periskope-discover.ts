import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeEnv, type Env } from "../flow/env.ts";
import type { ConsentPatch } from "../flow/periskope.ts";
import { appendJsonl } from "./jsonl.ts";
import { getJson, INTAKE_GROUPS } from "./periskope-backfill.ts";
import { setConsent, type IntakeOptions } from "./periskope-intake.ts";
import { PeriskopeStore } from "./periskope-store.ts";

/**
 * Listen-only group discovery. Once an hour the poller lists the Periskope groups (GET only) and auto-adds the
 * ones whose names look like real-estate groups, with at least MIN_MEMBERS members, outside the internal-team
 * denylist and not in PERISKOPE_DENY_CHAT_IDS. An added group gets Miles's standing owner waiver and then a
 * 7-day backfill on the poll. Nothing is sent, posted, reacted to or flagged. Only names, ids and counts are logged.
 *
 * Roster: <root>/groups.json (0600), [{chatId, chatName, memberCount, addedAt, source: "pinned" | "auto"}].
 * Pinned groups come from INTAKE_GROUPS in code; the file lists them too once discovery has written it.
 */

export const DISCOVERY_EVERY_MS = 60 * 60_000;
export const MIN_MEMBERS = 20;
/** The first fetch of a group with no cursor and no stored posts: the last seven days. */
export const FIRST_BACKFILL_DAYS = 7;
const API = "https://api.periskope.app";
const PAGE = 100;
const MAX_PAGES = 50;

/**
 * Miles's standing owner waiver: "we have consent on all groups as we are members". The same fields
 * realty/cli/periskope-consent.ts records for the pinned groups; noticePostedAt stays null.
 */
export const OWNER_WAIVER = {
  at: "2026-11-14T13:39:00.000Z",
  waivedBy: "owner",
  adminOkBy: "Miles Abraham",
} as const;

export function waiverPatch(chatId: string, groupName: string): ConsentPatch {
  return {
    chatId,
    groupName,
    noticePostedAt: null,
    noticeWaivedAt: OWNER_WAIVER.at,
    noticeWaivedBy: OWNER_WAIVER.waivedBy,
    adminOkBy: OWNER_WAIVER.adminOkBy,
    adminOkAt: OWNER_WAIVER.at,
    active: true,
  };
}

/* ---------------- classification (pure) ---------------- */

/** One chat as the Periskope list returns it. Only these three fields are read. */
export type ApiChat = { chat_id?: unknown; chat_name?: unknown; member_count?: unknown };

export type Reason =
  | "included"
  | "not_group"
  | "denied_chat"
  | "denied_name"
  | "not_real_estate"
  | "too_small"
  | "already_pinned"
  | "already_added";

export type Verdict = { include: boolean; reason: Reason };

/** Case-insensitive word or phrase matches, plus "AREA" matched case-sensitively as a whole word (the agents' association). */
const REAL_ESTATE: RegExp[] = [
  /\brealt(?:y|or|ors)\b/i,
  /\breal\s+estate\b/i,
  /\bpropert(?:y|ies)\b/i,
  /\bco[\s-]?broke\b/i,
  /\brent(?:al|als)?\b/i,
  /\bbrokers?\b/i,
  /\bagents\b/i,
  /\blistings\b/i,
  /\bhomes\b/i,
  /\bland\s+for\s+sale\b/i,
  /\bsearches\b/i,
  /\bAREA\b/,
];

/** The brokerage's own staff chats. Matched against the group name. */
const INTERNAL_NAME: RegExp[] = [/1\s*on\s*1/i, /1on1/i];

export function denyChatIds(env: Env = {}): string[] {
  return (env.PERISKOPE_DENY_CHAT_IDS ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Whether one chat is auto-included, and why not if not. Pure: the env is passed in. Pinned and already-added checks are the caller's. */
export function discoveryVerdict(chat: ApiChat, env: Env = {}): Verdict {
  const chatId = str(chat.chat_id);
  if (!chatId || !chatId.endsWith("@g.us")) return { include: false, reason: "not_group" };
  if (denyChatIds(env).includes(chatId)) return { include: false, reason: "denied_chat" };
  const name = str(chat.chat_name) ?? "";
  if (INTERNAL_NAME.some((re) => re.test(name))) return { include: false, reason: "denied_name" };
  if (!REAL_ESTATE.some((re) => re.test(name))) return { include: false, reason: "not_real_estate" };
  if ((num(chat.member_count) ?? 0) < MIN_MEMBERS) return { include: false, reason: "too_small" };
  return { include: true, reason: "included" };
}

/** True when discovery would auto-include this chat (see discoveryVerdict). */
export function looksRealEstate(chat: ApiChat, env: Env = {}): boolean {
  return discoveryVerdict(chat, env).include;
}

/* ---------------- Periskope listing (GET only) ---------------- */

export type ListResult = { ok: true; chats: ApiChat[] } | { ok: false; code: string };

/** Every group the account can see, paginated. Returns a short code on failure, never the response body. */
export async function listGroupChats(args: { apiKey: string; phoneId?: string; fetcher?: typeof getJson }): Promise<ListResult> {
  const get = args.fetcher ?? getJson;
  const chats: ApiChat[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${API}/v1/chats?chat_type=group&limit=${PAGE}&offset=${page * PAGE}`;
    let res: Awaited<ReturnType<typeof getJson>>;
    try {
      res = await get(url, args.apiKey, args.phoneId);
    } catch (e) {
      return { ok: false, code: codeOf(e) };
    }
    if (res.status !== 200) return { ok: false, code: `http_${res.status}` };
    const list = res.body && typeof res.body === "object" ? (res.body as { chats?: unknown }).chats : undefined;
    if (!Array.isArray(list)) return { ok: false, code: "bad_response" };
    for (const c of list) if (c && typeof c === "object") chats.push(c as ApiChat);
    if (list.length < PAGE) break;
  }
  return { ok: true, chats };
}

/* ---------------- roster file ---------------- */

export type RosterRow = { chatId: string; chatName: string; memberCount: number | null; addedAt: string; source: "pinned" | "auto" };

const rosterPath = (root: string) => join(root, "groups.json");
const addedPath = (root: string) => join(root, "groups-added.jsonl");

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

function saveRoster(root: string, rows: RosterRow[]): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = `${rosterPath(root)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, rosterPath(root));
}

/** The groups the poll reads: pinned ones from code, plus auto ones from the roster. A denied chat id is never polled. */
export type PollGroup = { chatId: string; chatName: string; source: "pinned" | "auto" };

export function pollGroups(root: string, env: Env = runtimeEnv()): PollGroup[] {
  const out = new Map<string, PollGroup>();
  for (const g of INTAKE_GROUPS) out.set(g.chatId, { chatId: g.chatId, chatName: g.chatName, source: "pinned" });
  for (const r of loadRoster(root)) {
    if (r.source !== "auto" || out.has(r.chatId)) continue;
    if (INTERNAL_NAME.some((re) => re.test(r.chatName))) continue;
    out.set(r.chatId, { chatId: r.chatId, chatName: r.chatName, source: "auto" });
  }
  const deny = new Set(denyChatIds(env));
  return [...out.values()].filter((g) => !deny.has(g.chatId));
}

/* ---------------- consent ---------------- */

/** Records the owner waiver for a group that has no consent record yet. Returns true when it wrote one. */
export async function ensureOwnerWaiver(root: string, chatId: string, groupName: string, intake: IntakeOptions): Promise<boolean> {
  if (new PeriskopeStore(root).consent(chatId)) return false;
  await setConsent(waiverPatch(chatId, groupName), { ...intake, root });
  return true;
}

/* ---------------- discovery ---------------- */

export type AddedGroup = { group: string; chatId: string; members: number; source: "auto" };
export type DiscoveryResult = { ok: true; checked: number; added: AddedGroup[] } | { ok: false; code: string };

/** Whether the hourly discovery is due. Attempts are throttled, so a failed attempt waits an hour too. */
export function discoveryDue(lastDiscoveryAt: string | null | undefined, now: Date): boolean {
  if (!lastDiscoveryAt) return true;
  const last = Date.parse(lastDiscoveryAt);
  return !Number.isFinite(last) || now.getTime() - last >= DISCOVERY_EVERY_MS;
}

/**
 * One discovery pass: list the groups, add the ones that qualify to the roster, record the owner waiver for each
 * new one, and append it to groups-added.jsonl. The 7-day backfill happens on the poll, which sees no cursor for
 * the new group. Never throws for a Periskope failure: a code comes back instead.
 */
export async function discoverGroups(args: {
  apiKey: string;
  phoneId?: string;
  fetcher?: typeof getJson;
  /** The root, env and clock; the env also decides the deny list. */
  intake: IntakeOptions & { root: string };
}): Promise<DiscoveryResult> {
  const listed = await listGroupChats({ apiKey: args.apiKey, phoneId: args.phoneId, fetcher: args.fetcher });
  if (!listed.ok) return listed;
  const at = args.intake.now?.() ?? new Date();
  const roster = loadRoster(args.intake.root);
  const known = new Set<string>([...INTAKE_GROUPS.map((g) => g.chatId), ...roster.map((r) => r.chatId)]);
  const added: AddedGroup[] = [];
  const fresh: RosterRow[] = [];
  for (const chat of listed.chats) {
    const chatId = str(chat.chat_id);
    if (!chatId || known.has(chatId) || !looksRealEstate(chat, args.intake.env ?? runtimeEnv())) continue;
    const name = str(chat.chat_name) ?? chatId;
    const members = num(chat.member_count) ?? 0;
    known.add(chatId);
    fresh.push({ chatId, chatName: name, memberCount: members, addedAt: at.toISOString(), source: "auto" });
    added.push({ group: name, chatId, members, source: "auto" });
  }
  if (added.length) {
    const seeds: RosterRow[] = INTAKE_GROUPS.filter((g) => !roster.some((r) => r.chatId === g.chatId)).map((g) => ({
      chatId: g.chatId,
      chatName: g.chatName,
      memberCount: null,
      addedAt: at.toISOString(),
      source: "pinned",
    }));
    saveRoster(args.intake.root, [...roster, ...seeds, ...fresh]);
    for (const g of added) {
      // A failed waiver is retried on the poll (the poll checks for a record before every group).
      try {
        await ensureOwnerWaiver(args.intake.root, g.chatId, g.group, args.intake);
      } catch {
        /* the poll records it before the group's first fetch */
      }
      appendJsonl(addedPath(args.intake.root), JSON.stringify({ at: at.toISOString(), group: g.group, chatId: g.chatId, members: g.members, source: g.source }));
    }
  }
  return { ok: true, checked: listed.chats.length, added };
}

/** Read-only view for the dry run: every listed chat with its verdict. Names, ids and counts only. */
export type PreviewRow = { group: string; chatId: string; members: number; included: boolean; reason: Reason };

export function previewDiscovery(chats: ApiChat[], env: Env, roster: RosterRow[]): PreviewRow[] {
  const pinned = new Set<string>(INTAKE_GROUPS.map((g) => g.chatId));
  const auto = new Set(roster.filter((r) => r.source === "auto").map((r) => r.chatId));
  return chats.map((chat) => {
    const chatId = str(chat.chat_id) ?? "";
    const group = str(chat.chat_name) ?? "";
    const members = num(chat.member_count) ?? 0;
    let verdict: Verdict;
    if (pinned.has(chatId)) verdict = { include: false, reason: "already_pinned" };
    else if (auto.has(chatId)) verdict = { include: false, reason: "already_added" };
    else verdict = discoveryVerdict(chat, env);
    return { group, chatId, members, included: verdict.include, reason: verdict.reason };
  });
}

/** A short code for a thrown error (its code or name), for logs. Never the message: it can carry a URL or a body. */
export function codeOf(e: unknown): string {
  return (e as { code?: string })?.code ?? (e as Error)?.name ?? "error";
}
