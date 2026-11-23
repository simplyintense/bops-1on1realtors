import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Inquiry, Lead } from "../flow/engine.ts";
import { runtimeEnv, type Env } from "../flow/env.ts";
import { forgetLeadsIn, LeadFlow, timeoutMsFromEnv, type FlowSnapshot } from "../flow/flow.ts";
import { businessHoursFromEnv } from "../flow/hours.ts";
import { ackSenderFromEnv } from "../flow/messages.ts";
import { areasFromEnv, AreaStore } from "./area-store.ts";
import { INTAKE_ALERT_GAP_MS, syncAutoMatchAlertsCoalesced, syncAutoMatchAlertsSafely } from "./automatch-alert.ts";
import { aliasesOf } from "../flow/knowledge.ts";
import { CachedAreaResolver, type AreaResolver, type ToolCaller } from "../flow/areas.ts";
import { liveRequestOf, matchOnArrival, matchOurListings, type LiveRequest } from "../flow/live-match.ts";
import { veryStrongOurListings, type StrongAlert } from "../flow/observe.ts";
import { MarketClient, marketConfigFromEnv, MarketSearch } from "../flow/market-search.ts";
import { DryRunOutbox } from "../flow/outbox.ts";
import {
  consentIsComplete,
  decide,
  envelopeOf,
  interpret,
  marketWriteConfigFromEnv,
  parseMessage,
  phoneOf,
  postMarketItem,
  postRecordOf,
  recordsDueForPurge,
  retentionFromEnv,
  toMarketGroupItem,
  type ConsentPatch,
  type Decision,
  type GroupConsent,
  type MarketIngestItem,
  type MarketSourceItem,
  type PostRecord,
} from "../flow/periskope.ts";
import type { CrmSource, Listing } from "../flow/source.ts";
import { sharedCrmSource } from "./crm-shared.ts";
import { GATE_COOKIE, gateConfig, ownerAllowed, publicDemo, readSession, teachAllowed } from "../../lib/gate.ts";
import { appendJsonl } from "./jsonl.ts";
import { PeriskopeStore, type LeadRow, type LiveRow, type MarketOutboxRow, type SeenRow } from "./periskope-store.ts";
import { pollGroups } from "./periskope-groups.ts";
import { saveListingPhotos, sweepMedia } from "./listing-media.ts";
import { isListingCategory } from "../flow/listing-photos.ts";
import { matchingKnowledgeFrom, taughtTermsFrom } from "./search-store.ts";
import { periskopeRoot } from "./periskope-root.ts";
import { recordWebhookAccepted, type WebhookOutcome } from "./webhook-status.ts";
import { appendInboxItem, claimInbox, type InboxItem } from "./webhook-inbox.ts";

/**
 * The Periskope WhatsApp intake, Node side: the signature check, the webhook's ingest, opt-outs, group
 * consent, the retention purge, the staff gate, and the market-ingest outbox. The decisions are in
 * realty/flow/periskope.ts. Bops never replies to WhatsApp and never calls Periskope. Market-ingest is
 * posted only when ONEON1_MARKET_WRITE_URL and ONEON1_MARKET_INGEST_TOKEN are both set; otherwise the
 * outbox is dry-run (records only). A failed network post stays pending for flushMarketOutbox later;
 * 403 not_allowlisted / opted_out is logged and not retried.
 *
 * Files under root (default .data/realty/periskope, 0700 dir, 0600 files):
 *   seen.jsonl, opt-out.jsonl, consent.jsonl, market-outbox.jsonl, leads.jsonl, live-matches.jsonl,
 *   match-status.jsonl (the desk's follow-up per match), flow-state.json (the lead flow's snapshot), outbox.jsonl (dry-run client/agent messages).
 * The area aliases and pair records are a sibling store: areas/ next to root (realty/node/area-store.ts).
 *
 * One intake or staff change runs at a time in this process (exclusive below). Across several processes
 * that isn't locked, so run one server per root.
 */

export const SIGNATURE_HEADER = "x-periskope-signature";

/** Messages dropped by the group allowlist since this process started. Only the count is logged, never the content. */
let droppedNotAllowlisted = 0;

/** The admin address the dry-run outbox uses. None is configured yet, so admin messages go nowhere real. */
const ADMIN = { name: "Admin", address: "(no admin address set)" };

export type IntakeOptions = {
  /** Where the files live. Default: .data/realty/periskope under the working directory. */
  root?: string;
  env?: Env;
  now?: () => Date;
  /** The CRM buyer requests are routed through. Unset: the live CRM if ONEON1_CRM_* is set, else none (buyer requests aren't taken). */
  crm?: CrmSource | null;
  /** Injected for tests. Never a live call in tests. */
  fetch?: typeof fetch;
  /** The area aliases and pair records. Default: "areas" next to root (.data/realty/areas). */
  areasRoot?: string;
  /** The market client for live matching (match_buyer). Unset: from ONEON1_MARKET_SEARCH_* (null when they aren't set). */
  market?: ToolCaller | null;
  /**
   * The Auto-Match sync after an ingest: "inline" (await a full run), "coalesced" (at most one run every few minutes, the
   * production default) or "skip" (the caller runs one itself, as the poller does once per poll). Unset: inline when a test
   * injects `now` or `root`, else coalesced.
   */
  alertSync?: "inline" | "coalesced" | "skip";
  /** Where our own listings come from for live matching. Unset: the same CRM as `crm`. Null: no listings of ours. */
  ours?: Pick<CrmSource, "listings"> | null;
  /**
   * Webhook only. True (the route): answer 200 {result:"queued"} as soon as the delivery is queued and handle it in the
   * background. Unset (tests, tools): handle it first and answer with the ingest result.
   */
  ackFirst?: boolean;
};

export type Reply = { status: number; body: Record<string, unknown> };
const reply = (status: number, body: Record<string, unknown>): Reply => ({ status, body });

type Ctx = {
  env: Env;
  now: Date;
  root: string;
  store: PeriskopeStore;
  areas: AreaStore;
  crm: CrmSource | null;
  fetch: typeof fetch;
  market: ToolCaller | null;
  ours: Pick<CrmSource, "listings"> | null;
  /** Injected fetch means a test: no shared area cache then. */
  shared: boolean;
};

function context(o: IntakeOptions): Ctx {
  const env = o.env ?? runtimeEnv();
  const root = o.root ?? periskopeRoot(env);
  const crm = o.crm !== undefined ? o.crm : liveCrm(env);
  return {
    env,
    now: o.now?.() ?? new Date(),
    root,
    store: new PeriskopeStore(root),
    areas: new AreaStore(o.areasRoot ?? join(dirname(root), "areas")),
    crm,
    fetch: o.fetch ?? fetch,
    market: o.market !== undefined ? o.market : marketClient(env, o.fetch ?? fetch),
    ours: o.ours !== undefined ? o.ours : crm,
    shared: !o.fetch,
  };
}

function marketClient(env: Env, fetcher: typeof fetch): ToolCaller | null {
  const cfg = marketConfigFromEnv(env);
  return cfg ? new MarketClient(cfg, fetcher) : null;
}

function liveCrm(env: Env): CrmSource | null {
  return sharedCrmSource(env);
}

/** The area resolver for matching our listings, kept for ten minutes so a request doesn't resolve the same areas again. */
let areaCache: { at: number; resolver: AreaResolver } | null = null;
const AREA_CACHE_MS = 10 * 60_000;

/** The taught places, as exact-text aliases for the matcher (the knowledge store; none before it exists). */
function taughtAliases(root: string) {
  return aliasesOf(taughtTermsFrom(root));
}

function oursAreas(c: Ctx): AreaResolver {
  if (!c.shared) return areasFromEnv(c.areas, c.env, c.fetch, taughtAliases(c.root));
  if (!areaCache || Date.now() - areaCache.at > AREA_CACHE_MS) areaCache = { at: Date.now(), resolver: new CachedAreaResolver(areasFromEnv(c.areas, c.env, undefined, taughtAliases(c.root))) };
  return areaCache.resolver;
}

/** Our own listings that fit, or none if the CRM can't be read: the request is still taken (fail closed). */
async function oursFor(request: LiveRequest, c: Ctx) {
  if (!c.ours) return [];
  let listings: Listing[];
  try {
    listings = await c.ours.listings();
  } catch {
    return [];
  }
  return matchOurListings(request, listings, oursAreas(c), undefined, matchingKnowledgeFrom(c.root)).catch(() => []);
}

/** Very strong CRM matches only (same development or area, exact beds, in-band). Never a neighbour. */
async function strongFor(request: LiveRequest, c: Ctx) {
  if (!c.ours) return [];
  let listings: Listing[];
  try {
    listings = await c.ours.listings();
  } catch {
    return [];
  }
  try {
    return veryStrongOurListings(request, listings);
  } catch {
    return [];
  }
}

function alertOf(d: { messageId: string; chatId: string; post: { sentAt: string; groupName?: string | null; area: string | null; beds: number | null } }, request: LiveRequest, m: { title: string; url: string | null; area: string | null; price: string | null; beds: number | null; reason: string | null }): StrongAlert {
  return {
    at: d.post.sentAt,
    messageId: d.messageId,
    chatId: d.chatId,
    groupName: d.post.groupName ?? null,
    requestArea: request.area ?? d.post.area ?? "",
    requestBeds: request.beds ?? d.post.beds,
    requestBudget: request.priceMax ?? request.priceMin,
    currency: request.currency,
    listingType: request.intent === "rent" ? "rent" : "sale",
    listingTitle: m.title,
    listingArea: m.area,
    listingPrice: m.price,
    listingBeds: m.beds,
    listingUrl: m.url,
    reason: m.reason ?? "very strong match",
  };
}

let chain: Promise<unknown> = Promise.resolve();

/** Runs one job at a time in this process, so two deliveries can't both read the same state and write it twice. */
export function exclusive<T>(job: () => T | Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.catch(() => undefined);
  return run;
}

/* ---------------- The webhook ---------------- */

/** HMAC-SHA256 of the raw body bytes, hex, compared in constant time. */
export function signatureOk(raw: Uint8Array, signature: string | null, key: string): boolean {
  if (!signature) return false;
  const want = Buffer.from(createHmac("sha256", key).update(raw).digest("hex"));
  const got = Buffer.from(signature.trim().toLowerCase());
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * POST /api/intake/periskope. 503 with no signing key; 401 for a missing or wrong signature. A verified delivery is
 * appended to the durable webhook inbox first (webhook-inbox.ts), then drained: 200 with the ingest result when it
 * was handled, and 200 {result:"accepted"} when handling threw (the item stays queued for a retry). Processing never
 * gives a 5xx. The only 5xx is a failure to write the queue, which tells Periskope to send it again.
 */
export async function handleWebhook(raw: Uint8Array, signature: string | null, o: IntakeOptions = {}): Promise<Reply> {
  const env = o.env ?? runtimeEnv();
  const key = (env.PERISKOPE_SIGNING_KEY ?? "").trim();
  if (!key) return reply(503, { error: "PERISKOPE_SIGNING_KEY isn't set" });
  if (!signatureOk(raw, signature, key)) return reply(401, { error: "bad signature" });
  const c = context(o);
  // Queue first, outside the intake lock: a poll or another delivery holding the lock must never delay the answer.
  // Periskope unsubscribes an endpoint that answers slowly (it saw 10 to 22 s replies while the poll held the lock).
  let queued: InboxItem;
  try {
    queued = appendInboxItem(c.root, raw, c.now);
  } catch (e) {
    console.error(`periskope: webhook not queued code=${errorCode(e)}`);
    return reply(500, { error: "could not queue" });
  }
  if (o.ackFirst) {
    // Answer now; handle it in the background, in order behind whatever holds the lock. A failure stays queued and
    // the 10-minute poller retries it.
    const done = processQueued(o, env, c.root, queued.id).catch(() => undefined);
    lastBackground = done;
    return reply(200, { result: "queued" });
  }
  return (await processQueued(o, env, c.root, queued.id)) ?? reply(200, { result: "accepted" });
}

/** The background work of the newest fast-acked delivery. Tests await it; production never does. */
let lastBackground: Promise<unknown> = Promise.resolve();
export function webhookBackgroundIdle(): Promise<unknown> {
  return lastBackground.then(() => exclusive(() => undefined));
}

/**
 * The Auto-Match sync after an intake. In production it's coalesced (syncAutoMatchAlertsCoalesced: at most one run per
 * few minutes) so a busy WhatsApp group can't starve the server's CPU. Tests that inject `now` or `root` run it inline.
 */
function syncIntakeAlerts(o: IntakeOptions, a: { env: Env; root: string; now?: Date }): Promise<void> {
  const mode = o.alertSync ?? (o.now !== undefined || o.root !== undefined ? "inline" : "coalesced");
  if (mode === "skip") return Promise.resolve();
  if (mode === "inline") return syncAutoMatchAlertsSafely(a);
  return syncAutoMatchAlertsCoalesced({ env: a.env, root: a.root }, INTAKE_ALERT_GAP_MS);
}

async function processQueued(o: IntakeOptions, env: Env, root: string, id: string): Promise<Reply | null> {
  const result = await exclusive(async () => (await drainInbox(context(o), id)).reply);
  await syncIntakeAlerts(o, { env, root, now: context(o).now });
  return result;
}

/**
 * Handles every queued delivery once, oldest first: an item that handles cleanly is removed, one that throws stays with
 * attempts+1. Called after each webhook and from the 10-minute poller, so a retry never waits for Periskope. Under
 * `exclusive`, so drains never overlap; appends don't need the lock (claimInbox). Logs the error code only, never the body. Never throws.
 */
async function drainInbox(c: Ctx, currentId?: string): Promise<{ reply: Reply | null; attempted: number; done: number; pending: number }> {
  let claim: ReturnType<typeof claimInbox>;
  try {
    claim = claimInbox(c.root);
  } catch (e) {
    console.error(`periskope: webhook inbox unreadable code=${errorCode(e)}`);
    return { reply: currentId ? reply(200, { result: "accepted" }) : null, attempted: 0, done: 0, pending: 0 };
  }
  const items = claim.items;
  let current: Reply | null = null;
  const keep: InboxItem[] = [];
  for (const item of items) {
    try {
      const r = await ingest(new TextDecoder().decode(Buffer.from(item.body, "base64")), c, true);
      if (item.id === currentId) current = r;
    } catch (e) {
      keep.push({ ...item, attempts: item.attempts + 1 });
      console.error(`periskope: webhook processing failed attempts=${item.attempts + 1} code=${errorCode(e)}`);
      if (item.id === currentId) current = reply(200, { result: "accepted" });
    }
  }
  if (items.length) {
    try {
      claim.release(keep);
    } catch (e) {
      console.error(`periskope: webhook inbox not updated code=${errorCode(e)}`);
    }
  }
  return { reply: current ?? (currentId ? reply(200, { result: "accepted" }) : null), attempted: items.length, done: items.length - keep.length, pending: keep.length };
}

/** Retries every queued webhook delivery once. Called from the 10-minute poller (periskope-poll.ts). Never throws. */
export async function flushWebhookInbox(o: IntakeOptions = {}): Promise<{ attempted: number; done: number; pending: number }> {
  const r = await exclusive(() => drainInbox(context(o)));
  return { attempted: r.attempted, done: r.done, pending: r.pending };
}

function errorCode(e: unknown): string {
  return (e as { code?: string }).code ?? (e as Error)?.name ?? "error";
}

/**
 * One payload through the pipeline. `webhook` is true only on the signed webhook path: that path alone logs the accepted
 * delivery and counts it in webhook-status.json (see noteWebhook). The poll and backfill (ingestEvent) never do.
 */
async function ingest(text: string, c: Ctx, webhook = false): Promise<Reply> {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return reply(200, { result: "ignored: not JSON" });
  }
  const d = decide({
    payload,
    at: c.now,
    env: c.env,
    optedOut: c.store.optOuts(),
    consentOf: (chatId) => c.store.consent(chatId),
    seen: (id) => c.store.isSeen(id),
    terms: taughtTermsFrom(c.root),
    // The same groups the poller watches (pinned plus roster, minus deny), so the webhook accepts what the poll reads.
    watched: pollGroups(c.root, c.env).map((g) => g.chatId),
  });
  if (d.action === "ignore" && d.reason === "already seen") await refillPost(c, payload);
  const r = await act(d, c);
  if (webhook) noteWebhook(c, payload, d);
  return r;
}

/**
 * Logs and counts a signed webhook delivery after it has been handled. Accepted: a stored message (buyer request,
 * co-broke listing, other) as outcome=added, or one already seen as outcome=duplicate. Signed but not message.created
 * (ignored): logged only, not counted, so a Periskope event-name mismatch shows up in the logs. Drops, opt-outs and
 * other ignores are not logged here. The log line carries no message text, phone or chat id.
 */
function noteWebhook(c: Ctx, payload: unknown, d: Decision): void {
  const e = envelopeOf(payload);
  const eventType = e && SAFE_EVENT.test(e.eventType) ? e.eventType : "unknown";
  let outcome: WebhookOutcome;
  if (d.action === "buyer_request" || d.action === "cobroke_listing" || d.action === "other") outcome = "added";
  else if (d.action === "ignore" && d.reason === "already seen") outcome = "duplicate";
  else {
    // The reason is decide()'s "<event> isn't handled", rebuilt from the sanitised token so no raw payload text reaches the log.
    if (d.action === "ignore" && e && e.eventType !== "message.created") console.info(`periskope: webhook ignored event=${eventType} reason=${eventType} isn't handled`);
    return;
  }
  const group = logGroupName(parseMessage(e?.data)?.chatName ?? null);
  console.info(`periskope: webhook accepted event=${eventType} group=${group ?? "unnamed"} outcome=${outcome}`);
  recordWebhookAccepted(c.root, { at: c.now.toISOString(), eventType, groupName: group, outcome });
}

/** Event types we log as-is: a short token, so a stray value can't add a line or a long string to the log. */
const SAFE_EVENT = /^[A-Za-z0-9_.:-]{1,60}$/;

/** The group's name for the log and the status: one line, trimmed, at most 80 characters. */
function logGroupName(name: string | null): string | null {
  const one = name?.replace(/\s+/g, " ").trim() ?? "";
  return one ? one.slice(0, 80) : null;
}

/**
 * Ingest a trusted event (already authenticated, e.g. a backfill from the Periskope read API). Same
 * pipeline as the webhook after the signature check. Does not call Periskope, and never sends.
 */
export async function ingestEvent(payload: unknown, o: IntakeOptions = {}): Promise<Reply> {
  const c = context(o);
  const result = await exclusive(() => ingest(JSON.stringify(payload), c));
  await syncIntakeAlerts(o, { env: c.env, root: c.root, now: c.now });
  return result;
}

/** Store the structured post. For listing posts only, also try to save photos under root/media. Idempotent: a second call only fills missing text or photos. */
async function keepPost(c: Ctx, post: PostRecord): Promise<void> {
  const existing = c.store.post(post.messageId);
  const listing = isListingCategory(post.category);
  const needPhotos = listing && (!(existing?.mediaFiles && existing.mediaFiles.length)) && (post.mediaUrls?.length ?? 0) > 0;
  const saved = needPhotos ? await saveListingPhotos(c.root, post.mediaUrls ?? [], c.fetch) : null;
  const photos = saved?.files.length ? { mediaFiles: saved.files, mediaHashes: saved.hashes } : { mediaFiles: existing?.mediaFiles, mediaHashes: existing?.mediaHashes };
  const row = listing ? { ...post, mediaUrls: post.mediaUrls ?? existing?.mediaUrls, ...photos } : { ...post, mediaUrls: undefined, mediaFiles: undefined, mediaHashes: undefined };
  c.store.upsertPost(row);
}

/**
 * If this message is already stored without originalText, fill it in (and a missing post row) without
 * rematching. Does not log the text.
 */
async function refillPost(c: Ctx, payload: unknown): Promise<void> {
  const e = envelopeOf(payload);
  const m = e ? parseMessage(e.data) : null;
  if (!m?.hasText) return;
  const phone = phoneOf(m.sender);
  if (!phone) return;
  const sentAt = m.sentAt ?? c.now.toISOString();
  const post = postRecordOf({ message: m, phone, interpretation: interpret(m.body, taughtTermsFrom(c.root)), sentAt });
  await keepPost(c, post);
}


async function act(d: Decision, c: Ctx): Promise<Reply> {
  const at = c.now.toISOString();
  switch (d.action) {
    case "ignore":
      return reply(200, { result: `ignored: ${d.reason}` });
    case "drop":
      // Counted only: nothing is stored or marked seen, and the body is never read.
      droppedNotAllowlisted += 1;
      console.info(`periskope: dropped not allowlisted, total=${droppedNotAllowlisted} reason=${d.reason}`);
      return reply(200, { result: "dropped: not allowlisted" });
    case "other":
      await keepPost(c, d.post);
      c.store.markSeen({ id: d.messageId, senderPhone: d.phone, kind: "other", at: d.post.sentAt });
      return reply(200, { result: "dropped: not a buyer request or a co-broke listing" });
    case "cobroke_listing":
      await keepPost(c, d.post);
      c.store.markSeen({ id: d.messageId, senderPhone: d.phone, kind: "cobroke_listing", at: d.post.sentAt });
      if (d.item) await queueMarket(c, d.item);
      return reply(200, { result: d.item ? "listing recorded for market-ingest" : "listing noted (not enough fields for market-ingest)" });
    case "buyer_request": {
      // Store the post first. A later write failure must not leave a lead or live row (Periskope retries a 500,
      // and a partial write was creating duplicates). Seen is marked before matching so a slow or failed match
      // never makes Periskope deliver the message twice.
      await keepPost(c, d.post);
      c.store.markSeen({ id: d.messageId, senderPhone: d.phone, kind: "buyer_request", at: d.post.sentAt });
      // With a CRM the request also enters the lead flow (routing, timeouts, dry-run messages only); without one, or if the
      // CRM can't be reached, it is still stored and matched.
      const lead = c.crm ? await receive(d.inquiry, c, c.crm).catch(() => null) : null;
      if (lead) c.store.addLead({ leadId: lead.id, messageId: d.messageId, senderPhone: d.phone, receivedAt: d.post.sentAt });
      const request = liveRequestOf(d.facts);
      c.store.addLive({ messageId: d.messageId, chatId: d.chatId, senderPhone: d.phone, receivedAt: d.post.sentAt, request, status: "pending", matchedAt: null, matches: [] });
      if (d.item) await queueMarket(c, d.item);
      const [m, ours, strong] = await Promise.all([matchOnArrival(request, d.messageId, at, c.market), oursFor(request, c), strongFor(request, c)]);
      c.store.updateLive(d.messageId, { status: m.status, matches: m.matches, ours, matchedAt: c.now.toISOString() });
      for (const hit of strong) c.store.addAlert(alertOf(d, request, hit));
      const taken = lead ? `buyer request taken as ${lead.id}` : c.crm ? "buyer request stored (CRM unreachable: not routed)" : "buyer request stored (no CRM: not routed)";
      return reply(200, { result: taken, matching: m.status, matches: m.matches.length, ours: ours.length, strong: strong.length });
    }
  }
}

/* ---------------- Market-ingest outbox ---------------- */

/** SHA-256 hex of the posting agent's number, the same hash market-ingest uses when agencyPhone is set. */
export function senderHashOf(phone: string): string {
  return createHash("sha256").update(phone).digest("hex");
}

function logReject(item: MarketIngestItem, error: string): void {
  const kind = item.kind;
  const group = kind === "alias" ? null : item.group;
  console.warn(`market-ingest ${error}: kind=${kind}${group ? ` group=${group}` : ""}`);
}

/**
 * Records the item on the outbox, then makes one attempt if the adapter is on. Network failures stay
 * pending for flushMarketOutbox; 403 not_allowlisted / opted_out is logged and marked rejected.
 */
export async function queueMarket(c: Ctx, item: MarketIngestItem): Promise<MarketOutboxRow> {
  const row = c.store.enqueueMarket(item, c.now.toISOString());
  return deliver(c, row);
}

async function deliver(c: Ctx, row: MarketOutboxRow): Promise<MarketOutboxRow> {
  const cfg = marketWriteConfigFromEnv(c.env);
  if (!cfg) return row;
  const result = await postMarketItem(cfg, row.item, c.fetch);
  if (result.ok) {
    if (result.kind === "source") return c.store.updateMarket(row.localId, { status: "sent", remoteId: result.id, deduped: result.deduped, lastError: undefined }) ?? row;
    if (result.kind === "group") return c.store.updateMarket(row.localId, { status: "sent", remoteGroup: { group: result.group, active: result.active, adminOk: result.adminOk }, lastError: undefined }) ?? row;
    return c.store.updateMarket(row.localId, { status: "sent", lastError: undefined }) ?? row;
  }
  if (!result.retry) {
    logReject(row.item, result.error);
    return c.store.updateMarket(row.localId, { status: "rejected", lastError: result.error }) ?? row;
  }
  return c.store.updateMarket(row.localId, { status: "pending", lastError: result.error }) ?? row;
}

/** One attempt each for every pending outbox row. Called from tickFlow; never loops on a single item. */
export async function flushMarketOutbox(o: IntakeOptions = {}): Promise<{ attempted: number; sent: number; rejected: number; pending: number }> {
  return exclusive(() => flushMarketOutboxUnlocked(context(o)));
}

async function flushMarketOutboxUnlocked(c: Ctx): Promise<{ attempted: number; sent: number; rejected: number; pending: number }> {
  const pending = c.store.market().filter((r) => r.status === "pending");
  let sent = 0;
  let rejected = 0;
  let still = 0;
  for (const row of pending) {
    const after = await deliver(c, row);
    if (after.status === "sent") sent += 1;
    else if (after.status === "rejected") rejected += 1;
    else still += 1;
  }
  return { attempted: pending.length, sent, rejected, pending: still };
}

/* ---------------- The lead flow, kept in a file ---------------- */

function openFlow(c: Ctx, crm: CrmSource, onTick?: (now: Date) => void | Promise<void>): LeadFlow {
  return new LeadFlow({
    crm,
    clock: () => c.now,
    outbox: new DryRunOutbox({ clock: () => c.now, append: (line) => appendJsonl(join(c.root, "outbox.jsonl"), line) }),
    market: marketFrom(c.env),
    areas: areasFromEnv(c.areas, c.env, c.fetch, taughtAliases(c.root)),
    pairStore: c.areas,
    timeoutMs: timeoutMsFromEnv(c.env),
    hours: businessHoursFromEnv(c.env),
    admin: ADMIN,
    ackSender: ackSenderFromEnv(c.env),
    snapshot: readFlowState(c.root),
    persist: (s) => writeFlowState(c.root, s),
    onTick,
  });
}

async function receive(inq: Inquiry, c: Ctx, crm: CrmSource): Promise<Lead> {
  return openFlow(c, crm).receive(inq);
}

function marketFrom(env: Env): MarketSearch | null {
  const cfg = marketConfigFromEnv(env);
  return cfg ? new MarketSearch(cfg) : null;
}

function readFlowState(root: string): FlowSnapshot | undefined {
  const file = join(root, "flow-state.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as FlowSnapshot) : undefined;
}

function writeFlowState(root: string, snapshot: FlowSnapshot): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, "flow-state.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Takes these leads out of the stored flow state (opt-out, purge). */
function dropFromFlowState(root: string, leadIds: string[]): void {
  if (!leadIds.length) return;
  const snapshot = readFlowState(root);
  if (snapshot) writeFlowState(root, forgetLeadsIn(snapshot, leadIds));
}

/* ---------------- Retention ---------------- */

export type PurgeResult = { leads: number; market: number; seen: number; leadIds: string[] };

function sourceItem(row: MarketOutboxRow): MarketSourceItem | null {
  return row.item.kind === "listing" || row.item.kind === "request" ? row.item : null;
}

/**
 * Deletes what is past its window: buyer-request leads and live requests (PERISKOPE_REQUEST_RETENTION_DAYS, default 60) and
 * co-broke listings (PERISKOPE_LISTING_RETENTION_DAYS, default 90), each with its seen rows and market
 * outbox source items. Seen rows of other messages go on the request window. kind=group / optout rows
 * are left (they are not listings or requests). LeadFlow.tick() calls this through onTick (tickFlow).
 */
export function purgeExpiredPeriskope(store: PeriskopeStore, now: Date, env: Env = runtimeEnv()): PurgeResult {
  const { requestDays, listingDays } = retentionFromEnv(env);
  const leadsDue = recordsDueForPurge(store.leads(), now, requestDays);
  const market = store.market();
  const requestsDue = recordsDueForPurge(
    market.filter((r) => r.item.kind === "request"),
    now,
    requestDays,
    (r) => sourceItem(r)?.seenAt ?? r.at,
  );
  const listingsDue = recordsDueForPurge(
    market.filter((r) => r.item.kind === "listing"),
    now,
    listingDays,
    (r) => sourceItem(r)?.seenAt ?? r.at,
  );
  const leadIds = new Set(leadsDue.map((l) => l.leadId));
  const marketIds = new Set([...requestsDue, ...listingsDue].map((m) => m.localId));
  const messageIds = new Set([
    ...leadsDue.map((l) => l.messageId),
    ...[...requestsDue, ...listingsDue].flatMap((m) => {
      const item = sourceItem(m);
      return item ? [item.sourceMessageId] : [];
    }),
  ]);
  const seen = store.seenRows();
  const seenDue = new Set([
    ...recordsDueForPurge(
      seen.filter((r) => r.kind !== "cobroke_listing"),
      now,
      requestDays,
      (r) => r.at,
    ).map((r) => r.id),
    ...recordsDueForPurge(
      seen.filter((r) => r.kind === "cobroke_listing"),
      now,
      listingDays,
      (r) => r.at,
    ).map((r) => r.id),
  ]);
  const leads = store.removeWhere<LeadRow>("leads", (r) => leadIds.has(r.leadId)).length;
  const liveDue = new Set(recordsDueForPurge(store.live(), now, requestDays).map((r) => r.messageId));
  store.removeWhere<LiveRow>("live", (r) => liveDue.has(r.messageId));
  store.pruneMatchStatuses();
  const marketN = store.removeWhere<MarketOutboxRow>("market", (r) => marketIds.has(r.localId)).length;
  const seenN = store.removeWhere<SeenRow>("seen", (r) => seenDue.has(r.id) || messageIds.has(r.id) || liveDue.has(r.id)).length;
  store.removeWhere<PostRecord>("posts", (r) => {
    const listing = r.category === "listing_for_sale" || r.category === "listing_for_rent" || r.category === "cobroke";
    const days = listing ? listingDays : requestDays;
    return Date.parse(r.sentAt) < now.getTime() - days * 86_400_000 || messageIds.has(r.messageId) || liveDue.has(r.messageId) || seenDue.has(r.messageId);
  });
  sweepMedia(store, now);
  return { leads, market: marketN, seen: seenN, leadIds: [...leadIds] };
}

/** The purge on its own (no timeouts), for a schedule or a staff action. Also drops the purged leads from the flow state. */
export function runPurge(o: IntakeOptions = {}): Promise<PurgeResult> {
  return exclusive(() => {
    const c = context(o);
    const r = purgeExpiredPeriskope(c.store, c.now, c.env);
    dropFromFlowState(c.root, r.leadIds);
    return r;
  });
}

/**
 * The lead flow's timeouts with the Periskope purge and a single market-outbox flush wired in (LeadFlow's
 * onTick). Needs a CRM, since a timeout hands the lead to a backup agent; without one it runs the purge
 * and flush alone and returns 0.
 */
export function tickFlow(o: IntakeOptions = {}): Promise<number> {
  return exclusive(async () => {
    const c = context(o);
    const afterTick = async (now: Date) => {
      const ids = purgeExpiredPeriskope(c.store, now, c.env).leadIds;
      dropFromFlowState(c.root, ids);
      await flushMarketOutboxUnlocked(c);
      return ids;
    };
    if (!c.crm) {
      await afterTick(c.now);
      return 0;
    }
    const flow: LeadFlow = openFlow(c, c.crm, async (now) => {
      flow.forgetLeads(await afterTick(now));
    });
    return flow.tick();
  });
}

/* ---------------- Opt-outs and consent (staff) ---------------- */

export type OptOutResult = { senderPhone: string; added: boolean; leads: number; market: number; seen: number };

/**
 * Adds the number to the opt-out list and deletes what's stored from it: its leads (and their lines in the
 * flow state), its live requests and matches, its listing/request outbox records and its seen rows. Then queues kind=optout for
 * market-ingest (senderHash of the number). Later messages from this sender are dropped before the body is read.
 */
export function optOutSender(senderPhone: string, o: IntakeOptions = {}): Promise<OptOutResult> {
  return exclusive(async () => {
    const c = context(o);
    const added = c.store.addOptOut(senderPhone, c.now.toISOString());
    const leadIds = c.store.removeWhere<LeadRow>("leads", (r) => r.senderPhone === senderPhone).map((r) => r.leadId);
    const market = c.store.removeWhere<MarketOutboxRow>("market", (r) => {
      const item = sourceItem(r);
      return item?.agencyPhone === senderPhone;
    }).length;
    const seen = c.store.removeWhere<SeenRow>("seen", (r) => r.senderPhone === senderPhone).length;
    c.store.removeWhere<LiveRow>("live", (r) => r.senderPhone === senderPhone);
    c.store.removeWhere<PostRecord>("posts", (r) => r.senderPhone === senderPhone);
    c.store.pruneMatchStatuses();
    dropFromFlowState(c.root, leadIds);
    await queueMarket(c, { kind: "optout", senderHash: senderHashOf(senderPhone) });
    return { senderPhone, added, leads: leadIds.length, market, seen };
  });
}


const isoOrSame = (v: string | null | undefined): string | null => {
  if (v == null || v === "") return v ?? null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : v;
};

const definedOnly = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * Creates or updates a group's consent record. Partial: a field left out stays as it was. A group is
 * accepted only once adminOkAt is set and either noticePostedAt or noticeWaivedAt is set, and active is
 * not false. When the record becomes complete, kind=group (active: true) is queued for market-ingest.
 * Revoke with active: false (the same call, not by clearing adminOkAt).
 */
export function setConsent(patch: ConsentPatch, o: IntakeOptions = {}): Promise<GroupConsent> {
  return exclusive(async () => {
    const c = context(o);
    const base: GroupConsent = c.store.consent(patch.chatId) ?? { chatId: patch.chatId, groupName: null, noticePostedAt: null, noticeWaivedAt: null, noticeWaivedBy: null, adminOkBy: null, adminOkAt: null, active: true };
    const before = { complete: consentIsComplete(base) && base.active !== false, active: base.active !== false };
    const raw = { ...base, ...definedOnly(patch) };
    const next = c.store.setConsent({
      ...raw,
      noticePostedAt: isoOrSame(raw.noticePostedAt),
      noticeWaivedAt: isoOrSame(raw.noticeWaivedAt ?? null),
      adminOkAt: isoOrSame(raw.adminOkAt),
    });
    const complete = consentIsComplete(next) && next.active !== false;
    if (complete && !before.complete) await queueMarket(c, toMarketGroupItem(next));
    else if (before.active && next.active === false) await queueMarket(c, toMarketGroupItem({ ...next, active: false }));
    return next;
  });
}

export function listConsents(o: IntakeOptions = {}): GroupConsent[] {
  return context(o).store.consents();
}

/* ---------------- Staff access ---------------- */

/**
 * The gate for the staff routes (opt-out, consent): 403 on the public demo; 503 if the login gate is on
 * but not set up; 401 without a valid session. Null means go ahead. With the gate off (the Mac app, dev),
 * the window token in proxy.ts is the check, as for the other APIs.
 */
export async function staffAccess(request: Request, env: Env = runtimeEnv()): Promise<Reply | null> {
  if (publicDemo(env)) return reply(403, { error: "Not available in the demo." });
  const cfg = gateConfig(env);
  if (cfg === "misconfigured") return reply(503, { error: "Sign-in isn't set up on this server yet." });
  if (cfg && !(await readSession(cookieNamed(request, GATE_COOKIE), cfg))) return reply(401, { error: "Sign in first." });
  return null;
}

/**
 * staffAccess, then owners only (BOPS_OWNER_EMAILS, ownerAllowed): 403 for a signed-in non-owner. With the login gate off (the
 * Mac app, dev) there's no session to check, so the window token in proxy.ts stays the check, as for staffAccess.
 */
export async function ownerAccess(request: Request, env: Env = runtimeEnv()): Promise<Reply | null> {
  const denied = await staffAccess(request, env);
  if (denied) return denied;
  return ownerAllowed(await staffEmail(request, env), env) ? null : reply(403, { error: "Owners only." });
}

/**
 * staffAccess, then the teachers only (BOPS_TEACH_EMAILS, teachAllowed). A signed-in non-teacher gets a 404, not a 403: the
 * teach endpoint is not there for them. With the gate off there's no email, so nobody teaches over the API (the CLI does).
 */
export async function teacherAccess(request: Request, env: Env = runtimeEnv()): Promise<Reply | null> {
  const denied = await staffAccess(request, env);
  if (denied) return denied;
  return teachAllowed(await staffEmail(request, env), env) ? null : reply(404, { error: "Not found." });
}

/** The signed-in staff email, or null (gate off, or no valid session). Call after staffAccess has let the request through. */
export async function staffEmail(request: Request, env: Env = runtimeEnv()): Promise<string | null> {
  const cfg = gateConfig(env);
  return cfg && cfg !== "misconfigured" ? readSession(cookieNamed(request, GATE_COOKIE), cfg) : null;
}

function cookieNamed(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

