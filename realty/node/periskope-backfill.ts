import type { Env } from "../flow/env.ts";
import { ingestEvent, type IntakeOptions, type Reply } from "./periskope-intake.ts";
import { PeriskopeStore } from "./periskope-store.ts";

/**
 * One-time, listen-only backfill of an allowlisted Periskope group: GET messages for that chat_id,
 * then push each through ingestEvent (parse, dedupe, match). Never sends, posts or reacts.
 * Counts only are logged; message text and phone numbers are not.
 */

export const AREA_REGISTERED_AGENTS_CHAT_ID = "18686789715-1444916451@g.us";
export const AREA_REGISTERED_AGENTS_NAME = "AREA Registered Agents";
const API = "https://api.periskope.app";

export type BackfillCounts = {
  fetched: number;
  parseFailures: number;
  added: number;
  refilled: number;
  unchanged: number;
  ignored: number;
  dropped: number;
  categories: Record<string, number>;
  cobroke: number;
  distinctAgents: number;
  withNameAndPhone: number;
  withPhone: number;
  marketMatches: number;
  crmMatches: number;
  matchedRequests: number;
  photosStored: number;
  photoUrlsKept: number;
  byResult: Record<string, number>;
};

type ChatMessage = Record<string, unknown>;

export function messageToEnvelope(msg: ChatMessage, chatName: string, senderName: string | null): { event_type: "message.created"; data: ChatMessage } {
  const data: ChatMessage = {
    ...msg,
    chat_name: chatName,
    chat_id: msg.chat_id,
    message_id: msg.message_id,
    sender_phone: msg.sender_phone || msg.author,
    from_me: msg.from_me,
    body: msg.body,
    message_type: msg.message_type,
    has_media: msg.has_media,
    media: msg.media,
    timestamp: msg.timestamp,
  };
  if (senderName) data.contact_name = senderName;
  return { event_type: "message.created", data };
}

export async function getJson(url: string, apiKey: string, phoneId?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  if (phoneId) headers["x-phone"] = phoneId;
  const r = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

export async function listGroupMessages(args: {
  apiKey: string;
  chatId: string;
  startTime: string;
  phoneId?: string;
  fetcher?: typeof getJson;
}): Promise<{ ok: true; messages: ChatMessage[] } | { ok: false; status: number; error: string }> {
  const get = args.fetcher ?? getJson;
  const messages: ChatMessage[] = [];
  let offset = 0;
  const limit = 200;
  for (;;) {
    const url = `${API}/v1/chats/${encodeURIComponent(args.chatId)}/messages?limit=${limit}&offset=${offset}&start_time=${encodeURIComponent(args.startTime)}`;
    const { status, body } = await get(url, args.apiKey, args.phoneId);
    if (status !== 200) {
      const err = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : `HTTP ${status}`;
      return { ok: false, status, error: err };
    }
    const page = body && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages) ? ((body as { messages: ChatMessage[] }).messages) : Array.isArray(body) ? (body as ChatMessage[]) : [];
    messages.push(...page);
    if (page.length < limit) break;
    offset += page.length;
  }
  return { ok: true, messages };
}

export async function memberNames(args: {
  apiKey: string;
  chatId: string;
  phoneId?: string;
  fetcher?: typeof getJson;
}): Promise<Map<string, string>> {
  const get = args.fetcher ?? getJson;
  const url = `${API}/v1/chats/${encodeURIComponent(args.chatId)}`;
  const { status, body } = await get(url, args.apiKey, args.phoneId);
  const names = new Map<string, string>();
  if (status !== 200 || !body || typeof body !== "object") return names;
  const members = (body as { members?: Record<string, { contact_id?: string; contact_name?: string }> }).members;
  if (!members || typeof members !== "object") return names;
  for (const m of Object.values(members)) {
    const id = typeof m?.contact_id === "string" ? m.contact_id : "";
    const name = typeof m?.contact_name === "string" ? m.contact_name.trim() : "";
    if (id && name) names.set(id, name);
  }
  return names;
}

export function startTimeDaysAgo(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function resultKey(reply: Reply): string {
  const r = reply.body.result;
  return typeof r === "string" ? r.replace(/ as lead-.*$/, " taken") : `status ${reply.status}`;
}

export async function backfillGroup(args: {
  apiKey: string;
  chatId?: string;
  chatName?: string;
  days?: number;
  phoneId?: string;
  opts: IntakeOptions;
  fetcher?: typeof getJson;
}): Promise<{ ok: true; counts: BackfillCounts } | { ok: false; error: string; status?: number }> {
  const chatId = args.chatId ?? AREA_REGISTERED_AGENTS_CHAT_ID;
  const chatName = args.chatName ?? AREA_REGISTERED_AGENTS_NAME;
  const days = args.days ?? 7;
  const listed = await listGroupMessages({
    apiKey: args.apiKey,
    chatId,
    startTime: startTimeDaysAgo(days),
    phoneId: args.phoneId,
    fetcher: args.fetcher,
  });
  if (!listed.ok) return { ok: false, error: listed.error, status: listed.status };
  const names = await memberNames({ apiKey: args.apiKey, chatId, phoneId: args.phoneId, fetcher: args.fetcher });
  const store = new PeriskopeStore(args.opts.root ?? `${process.cwd()}/.data/realty/periskope`);
  const before = new Map(store.posts().map((p) => [p.messageId, { hasText: Boolean(p.originalText), files: p.mediaFiles?.length ?? 0 }]));
  const ordered = [...listed.messages].sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));

  const counts: BackfillCounts = {
    fetched: listed.messages.length,
    parseFailures: 0,
    added: 0,
    refilled: 0,
    unchanged: 0,
    ignored: 0,
    dropped: 0,
    categories: {},
    cobroke: 0,
    distinctAgents: 0,
    withNameAndPhone: 0,
    withPhone: 0,
    marketMatches: 0,
    crmMatches: 0,
    matchedRequests: 0,
    photosStored: 0,
    photoUrlsKept: 0,
    byResult: {},
  };

  const env: Env = { ...(args.opts.env ?? {}), PERISKOPE_ALLOWED_CHAT_IDS: chatId, PERISKOPE_ALLOWED_GROUPS: chatName };

  for (const msg of ordered) {
    if (!msg || typeof msg !== "object" || !msg.message_id) {
      counts.parseFailures += 1;
      continue;
    }
    const sender = String(msg.sender_phone || msg.author || "");
    const senderName = names.get(sender) ?? (typeof msg.contact_name === "string" ? msg.contact_name : null);
    const envelope = messageToEnvelope(msg, chatName, senderName);
    const reply = await ingestEvent(envelope, { ...args.opts, env });
    const key = resultKey(reply);
    counts.byResult[key] = (counts.byResult[key] ?? 0) + 1;
    if (reply.body.result === undefined && reply.status !== 200) counts.parseFailures += 1;
    if (typeof reply.body.result === "string" && reply.body.result.startsWith("ignored: message fields")) counts.parseFailures += 1;
    else if (typeof reply.body.result === "string" && reply.body.result.startsWith("dropped:")) counts.dropped += 1;
    else if (typeof reply.body.result === "string" && reply.body.result.startsWith("ignored:")) counts.ignored += 1;
  }

  const after = store.posts();
  const agents = new Set<string>();
  for (const p of after) {
    const prev = before.get(p.messageId);
    if (!prev) counts.added += 1;
    else if ((!prev.hasText && p.originalText) || (prev.files === 0 && (p.mediaFiles?.length ?? 0) > 0)) counts.refilled += 1;
    else counts.unchanged += 1;
    counts.categories[p.category] = (counts.categories[p.category] ?? 0) + 1;
    if (p.cobroke) counts.cobroke += 1;
    if (p.senderPhone) {
      agents.add(p.senderPhone);
      counts.withPhone += 1;
      if (p.senderName) counts.withNameAndPhone += 1;
    }
    counts.photosStored += p.mediaFiles?.length ?? 0;
    counts.photoUrlsKept += p.mediaUrls?.length ?? 0;
  }
  counts.distinctAgents = agents.size;
  for (const row of store.live()) {
    const market = row.matches.length;
    const ours = row.ours?.length ?? 0;
    counts.marketMatches += market;
    counts.crmMatches += ours;
    if (market + ours > 0) counts.matchedRequests += 1;
  }
  return { ok: true, counts };
}
