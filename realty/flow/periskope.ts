import { developmentOf, findAreas, findBudget, findInterest, findPhones, normalizePhone } from "../extract.ts";
import type { Currency, Inquiry, ListingType } from "./engine.ts";
import { runtimeEnv, type Env } from "./env.ts";
import { propertyKindFromCrm } from "./taxonomy.ts";

/**
 * Periskope WhatsApp group intake: decisions only, no I/O. Periskope posts each group message to us as
 * a signed webhook. Bops never replies to WhatsApp and never calls Periskope. Staff post the group's
 * notice by hand. realty/node/periskope-intake.ts checks the signature, reads the store and carries out
 * what decide() says.
 *
 *   buyer request ("client looking for 2 bed rental in Westmoorings, under 8k") → Inquiry for LeadFlow.receive
 *     and a kind=request item for market-ingest
 *   co-broke listing ("3 bed townhouse Maraval TT$1.2M co-broke 50/50")       → a kind=listing item for market-ingest
 *   anything else                                                             → dropped; its id is kept so it isn't parsed twice
 *
 * Kept: the structured facts (budget, area, type, beds, rental or sale), the posting agent's business
 * name when the text names a firm, and the agent's own number (sender_phone). Never the body, and never
 * a name or phone found in the body. A group is accepted only once an admin's OK is recorded and either
 * staff have recorded a posted notice or the owner has waived the notice (noticeWaivedAt), and the
 * record is still active (consentAllows). An opted-out sender is dropped before
 * the body is read. Deny by default: a message passes the allowlist only from a group named in
 * PERISKOPE_ALLOWED_GROUPS or whose chat id is in PERISKOPE_ALLOWED_CHAT_IDS (allowlistCheck); anything
 * else is dropped before consent, classification or storage.
 *
 * Market-ingest (Builder, HOSTING.md on tt-market-search): POST one item at a time. Listing and request
 * items do not carry a consent field; the group is allowlisted separately with kind=group. The adapter
 * is in this file (postMarketItem); it stays off unless ONEON1_MARKET_WRITE_URL and
 * ONEON1_MARKET_INGEST_TOKEN are both set. Network errors are left on the outbox for a later flush,
 * never retried inline. Staff area aliases use the same adapter (kind "alias", aliasItem; area-store.ts).
 */

export const DAY_MS = 86_400_000;
export const GROUP_SUFFIX = "@g.us";
export const DEFAULT_REQUEST_RETENTION_DAYS = 60;
export const DEFAULT_LISTING_RETENTION_DAYS = 90;

export type Kind = "buyer_request" | "cobroke_listing" | "other";

export type Facts = {
  area: string | null;
  beds: number | null;
  baths: number | null;
  /** The first kind of place named (townhouse, house, land...). */
  type: string | null;
  budget: { min: number | null; max: number; currency: Currency; monthly: boolean } | null;
  intent: "buy" | "rent" | null;
};

/** How a stored post is categorised for the desk and a backfill report. A listing may also be cobroke. */
export type PostCategory = "buyer_request" | "rental_request" | "listing_for_sale" | "listing_for_rent" | "cobroke" | "other";

export type Interpretation = { kind: Kind; facts: Facts; firm: string | null };

export type GroupConsent = {
  chatId: string;
  groupName: string | null;
  noticePostedAt: string | null;
  /** Owner decision that no group notice is required. Not a posted notice, and never implied by noticePostedAt. */
  noticeWaivedAt?: string | null;
  noticeWaivedBy?: string | null;
  adminOkBy: string | null;
  adminOkAt: string | null;
  /** False means staff revoked it. Missing is treated as true (an older record). */
  active?: boolean;
};

/** One listing or buyer request for POST /functions/v1/market-ingest. `group` is the WhatsApp chat_id. */
export type MarketSourceItem = {
  kind: "listing" | "request";
  sourceMessageId: string;
  source: "whatsapp";
  group: string;
  agency: string;
  agencyPhone?: string;
  seenAt: string;
  title?: string;
  price?: number;
  priceMin?: number;
  priceMax?: number;
  currency: "TTD" | "USD";
  area: string;
  beds?: number;
  baths?: number;
  listingType: "sale" | "rent";
  propertyType?: string;
  notes?: string;
};

export type MarketOptOutItem = { kind: "optout"; senderHash?: string; group?: string };

/** Register or revoke a group on market-ingest. Revoke with active: false, not adminOkAt: null. */
export type MarketGroupItem = {
  kind: "group";
  group: string;
  name?: string;
  noticePostedAt?: string;
  adminOkAt?: string;
  adminOkBy?: string;
  active: boolean;
};

/** A staff area alias: the alias maps to the canonical area name. */
export type MarketAliasItem = { kind: "alias"; alias: string; canonical: string };

export type MarketIngestItem = MarketSourceItem | MarketOptOutItem | MarketGroupItem | MarketAliasItem;

export type DropReason = "empty-allowlist" | "dm" | "other-group" | "no-name";

export type Decision =
  | { action: "ignore"; reason: string }
  | { action: "drop"; reason: DropReason }
  | { action: "other"; messageId: string; phone: string; post: PostRecord }
  | { action: "buyer_request"; messageId: string; chatId: string; phone: string; facts: Facts; inquiry: Inquiry; item: MarketSourceItem | null; post: PostRecord }
  | { action: "cobroke_listing"; messageId: string; phone: string; item: MarketSourceItem | null; post: PostRecord };

/** A stored post: structured facts only, never the message body. */
export type PostRecord = {
  messageId: string;
  chatId: string;
  sentAt: string;
  category: PostCategory;
  cobroke: boolean;
  senderPhone: string;
  senderName: string | null;
  firm: string | null;
  area: string | null;
  price: number | null;
  currency: string | null;
  beds: number | null;
  baths: number | null;
  type: string | null;
  listingType: "sale" | "rent" | null;
  intent: "buy" | "rent" | null;
  propertyClass: string | null;
  notes: string | null;
  /** The original message text. Owners may read it in Bops; never log it, and never show it on an agent's desk. */
  originalText: string | null;
  /** The WhatsApp group name, when known. Used to tag a backfill row; not a secret. */
  groupName?: string | null;
  /** supply = a property on offer; demand = someone looking. Unset for chatter. */
  set?: "supply" | "demand" | null;
  /** Canonical development name when the area is a named development. */
  development?: string | null;
  mediaUrls?: string[];
  mediaFiles?: string[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/* ---------------- The webhook envelope and message.created ---------------- */

/** The envelope's event type, or null if it isn't an object with one. */
export function envelopeOf(payload: unknown): { eventType: string; data: unknown } | null {
  if (!isObj(payload)) return null;
  const eventType = str(payload.event_type);
  return eventType ? { eventType, data: payload.data } : null;
}

export type ParsedMessage = {
  messageId: string;
  chatId: string;
  /** sender_phone as Periskope sends it, e.g. "18685550201@c.us". */
  sender: string;
  /** The posting agent's display name, when the payload has one. Never taken from the body. */
  senderName: string | null;
  /** The group's name from the payload (chat_name, or chat.chat_name); null if the payload has none. */
  chatName: string | null;
  body: string;
  fromMe: boolean;
  /** A non-empty body, including a media caption. */
  hasText: boolean;
  /** A plain text chat message: message_type "chat", a non-empty body, and no media at all. */
  textOnly: boolean;
  /** http(s) media URLs on the message, if any. */
  mediaUrls: string[];
  /** The message's own timestamp, when the payload has a valid one. */
  sentAt: string | null;
};

/** The fields of message.created's data that this intake reads, or null if a required one is missing or mistyped. */
export function parseMessage(data: unknown): ParsedMessage | null {
  if (!isObj(data)) return null;
  const messageId = str(data.message_id);
  const chatId = str(data.chat_id);
  const sender = str(data.sender_phone);
  if (!messageId || !chatId || !sender) return null;
  const chat: Obj = isObj(data.chat) ? data.chat : {};
  const chatName = str(data.chat_name) ?? str(chat.chat_name);
  // Without a clear from_me we can't tell whether it's ours, so the message is ignored.
  if (typeof data.from_me !== "boolean") return null;
  const body = typeof data.body === "string" ? data.body : "";
  const hasMedia = data.has_media;
  const mediaUrls = mediaUrlsOf(data);
  const hasText = body.trim() !== "";
  const textOnly =
    data.message_type === "chat" && hasText && (hasMedia === undefined || hasMedia === null || hasMedia === false) && (data.media === undefined || data.media === null) && mediaUrls.length === 0;
  const senderName = str(data.contact_name) ?? str(data.sender_name) ?? str(data.author_name) ?? (isObj(data.sender) ? str(data.sender.name) : null);
  return { messageId, chatId, sender, senderName, chatName, body, fromMe: data.from_me, hasText, textOnly, mediaUrls, sentAt: timestampOf(data.timestamp ?? data.created_at) };
}

/** http(s) URLs on a Periskope media object, list, or path/url field. */
export function mediaUrlsOf(data: Obj): string[] {
  const urls: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) urls.push(v.trim());
    else if (isObj(v)) {
      add(v.path);
      add(v.url);
    } else if (Array.isArray(v)) v.forEach(add);
  };
  add(data.media);
  add(data.media_urls);
  return [...new Set(urls)];
}

function timestampOf(raw: unknown): string | null {
  if (typeof raw === "string" && Number.isFinite(Date.parse(raw))) return new Date(raw).toISOString();
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

export const isGroupChat = (chatId: string) => chatId.endsWith(GROUP_SUFFIX);

/** The number in a WhatsApp id ("18685550201@c.us") or a typed number, as +1868…; null if it isn't a phone. */
export function phoneOf(raw: string): string | null {
  return normalizePhone((raw.split("@")[0] ?? "").trim());
}

/** True if the text is or contains a phone number. Used to keep adminOkBy a name or role only. */
export function containsPhoneNumber(text: string): boolean {
  const t = text.trim();
  return !t ? false : findPhones(t).length > 0 || normalizePhone(t) !== null;
}

/* ---------------- Consent, allowlist, opt-outs ---------------- */

/** PERISKOPE_ALLOWED_CHATS: an optional extra restriction. Empty or unset means no extra restriction. */
export function allowedChatsFromEnv(env: Env = runtimeEnv()): string[] {
  return (env.PERISKOPE_ALLOWED_CHATS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** PERISKOPE_ALLOWED_GROUPS (exact group names) and PERISKOPE_ALLOWED_CHAT_IDS (exact chat ids), each separated by "|". */
export function allowlistFromEnv(env: Env = runtimeEnv()): { names: string[]; chatIds: string[] } {
  const list = (raw: string | undefined) =>
    (raw ?? "")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
  return { names: list(env.PERISKOPE_ALLOWED_GROUPS), chatIds: list(env.PERISKOPE_ALLOWED_CHAT_IDS) };
}

/**
 * Deny by default. Null if the message may go on; else why it is dropped. A direct message is always
 * dropped. A group passes if its chat id is listed, or if its name is listed exactly. With names only and
 * no name in the payload, it can't be confirmed, so it is dropped.
 */
export function allowlistCheck(chatId: string, chatName: string | null, env: Env = runtimeEnv()): DropReason | null {
  const { names, chatIds } = allowlistFromEnv(env);
  if (!names.length && !chatIds.length) return "empty-allowlist";
  if (!isGroupChat(chatId)) return "dm";
  if (chatIds.includes(chatId)) return null;
  if (!names.length) return "other-group";
  if (!chatName) return "no-name";
  return names.includes(chatName) ? null : "other-group";
}

/**
 * A group's messages are accepted only with a consent record that has adminOkAt and either a posted
 * notice (noticePostedAt) or an owner waiver (noticeWaivedAt), and has not been revoked
 * (active !== false). With PERISKOPE_ALLOWED_CHATS set, the chat must also be on that list. No record:
 * refused, never accepted.
 */
export function consentAllows(consent: GroupConsent | null | undefined, chatId: string, env: Env = runtimeEnv()): boolean {
  if (!consent || consent.chatId !== chatId || !isGroupChat(chatId)) return false;
  if (consent.active === false) return false;
  if (!consent.adminOkAt) return false;
  if (!consent.noticePostedAt && !consent.noticeWaivedAt) return false;
  const extra = allowedChatsFromEnv(env);
  return extra.length === 0 || extra.includes(chatId);
}

export const consentIsComplete = (c: GroupConsent) => Boolean(c.adminOkAt && (c.noticePostedAt || c.noticeWaivedAt));

/** Opted-out numbers compare normalized: "+1 868 555 0201", "18685550201@c.us" and "868-555-0201" are one sender. */
export function isOptedOut(optedOut: readonly string[], sender: string): boolean {
  const who = phoneOf(sender);
  return who !== null && optedOut.some((p) => phoneOf(p) === who);
}

/* ---------------- Retention ---------------- */

/** PERISKOPE_REQUEST_RETENTION_DAYS (default 60) and PERISKOPE_LISTING_RETENTION_DAYS (default 90). Whole days, 1 to 3650. */
export function retentionFromEnv(env: Env = runtimeEnv()): { requestDays: number; listingDays: number } {
  return {
    requestDays: daysFrom(env.PERISKOPE_REQUEST_RETENTION_DAYS, DEFAULT_REQUEST_RETENTION_DAYS),
    listingDays: daysFrom(env.PERISKOPE_LISTING_RETENTION_DAYS, DEFAULT_LISTING_RETENTION_DAYS),
  };
}

function daysFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : fallback;
}

/** The rows older than `days` (strictly), by their timestamp: `when` picks it (default receivedAt). */
export function recordsDueForPurge<T>(rows: readonly T[], now: Date, days: number, when: (row: T) => string = (r) => (r as { receivedAt: string }).receivedAt): T[] {
  const cutoff = now.getTime() - days * DAY_MS;
  return rows.filter((r) => Date.parse(when(r)) < cutoff);
}

/* ---------------- Classification ---------------- */

// Demand: someone wants something. "looking", "looking for", "seeking", "searching", "searching for",
// "in search for/of", "in the market", "anyone have", "wanted", "ISO", "need", "needs" and "client needs"
// are the strong ones: they win over a supply word ("anyone have a house for sale in...").
const DEMAND = /\b(looking(?:\s+for)?|seeking|search(?:ing)?\s+for|in search (?:of|for)|in the market|anyone (?:have|has|got)|wanted|ISO|client\s+needs?|needs?|wants? (?:a|an))\b/i;
const ANY_UNITS = /\bany\b[\s\S]{0,80}?\bunits?\s+for\s+(?:rent|sale)\b/i;
const STRONG_DEMAND = /\b(looking(?:\s+for)?|seeking|search(?:ing)?\s+for|in search (?:of|for)|in the market|anyone (?:have|has|got)|wanted|ISO|client\s+needs?|needs?)\b/i;
// Supply: a property is on offer.
const SUPPLY = /\b(co-?broke|50\/50|just listed|for sale|available)\b/i;

/** Seller/listing merchandising: these posts are supply even if marketing copy also says "seeking". */
const LISTING_PHRASES = /new\s+to\s+the\s+market|exclusive\s+listing|for\s+sale\s*[-–—]|for\s+rent\s+or\s+sale|for\s+sale\s+or\s+rent|asking\s*(?:price)?\s*[:$]|asking\s+\$/i;
const HEADLINE_LISTING = /(?:^|\n)\s*(?:\p{Extended_Pictographic}|[✨🔥🏙️📍🏡🏠🔑*\s]){0,12}(?:for\s+sale|for\s+rent|apartment\s+for|house\s+for|townhouse\s+for|penthouse\s+for|unit\s+for\s+(?:sale|rent))\b/iu;
const DEMAND_OPENING = /^(?:still\s+)?(?:looking(?:\s+for)?|seeking|search(?:ing)?\s+for|in search (?:of|for)|anyone (?:have|has|got)|client\s+needs?|needs?\s+(?:a|an)|wanted)\b/i;

function hasPriceCue(body: string): boolean {
  return !!findBudget(body) || /(?:\$|TT\$|US\$)\s*[\d,]+|\b(?:asking|price)\s*:\s*\$?\s*[\d,]+/i.test(body);
}

/** True when the text is a property ad (listing signals or a priced headline), not a buyer/rental request. */
export function listingSignals(body: string): boolean {
  if (LISTING_PHRASES.test(body)) return true;
  if (!hasPriceCue(body)) return false;
  const lines = body.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const open = lines.slice(0, 2).join(" ");
  if (DEMAND_OPENING.test(open)) return false;
  return lines.slice(0, 6).some((l) => HEADLINE_LISTING.test(l));
}

/** The structured facts in a message. Each one is what the text says, nothing more. */
export function factsOf(body: string): Facts {
  const interest = findInterest(body);
  const budget = findBudget(body);
  return {
    area: findAreas(body)[0] ?? null,
    beds: interest.bedrooms,
    baths: bathsOf(body),
    type: interest.types[0] ?? null,
    budget: budget ? { min: budget.min, max: budget.max, currency: budget.currency, monthly: budget.period === "month" } : null,
    intent: interest.intent,
  };
}

const BATHS = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:bath|bathroom)s?\b/i;
const BATH_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** The first bathroom count named in the text, or null. */
export function bathsOf(body: string): number | null {
  const m = BATHS.exec(body);
  if (!m) return null;
  const n = BATH_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const COBROKE = /\b(co-?broke|50\/50)\b/i;

/** The report category for an interpretation. cobroke is true only when the text itself said co-broke or 50/50. */
export function categoryOf(i: Interpretation, body: string): { category: PostCategory; cobroke: boolean } {
  const cobroke = COBROKE.test(body);
  if (i.kind === "buyer_request") {
    const rent = i.facts.intent === "rent" || listingTypeOf(i.facts) === "rent";
    return { category: rent ? "rental_request" : "buyer_request", cobroke: false };
  }
  if (i.kind === "cobroke_listing") {
    const lt = listingTypeOf(i.facts);
    if (lt === "rent") return { category: "listing_for_rent", cobroke };
    if (lt === "sale") return { category: "listing_for_sale", cobroke };
    return { category: "cobroke", cobroke: true };
  }
  return { category: "other", cobroke: false };
}

// A firm name: capitalised words then Realty, Realtors, Properties, Real Estate or Homes.
const FIRM = /\b((?:[A-Z][\w&'’.-]*\s){0,3}[A-Z][\w&'’.-]*)\s+(Realty|Realtors|Properties|Real Estate|Homes)\b/;
const NOT_FIRM = new Set(["Call", "Contact", "Client", "Looking", "For", "Just", "Our", "We", "New", "Co", "Cobroke", "Co-broke", "Sale", "Rent", "Listed", "Available", "Buyer", "Lead", "Need", "Needs", "Want", "Wants", "Seeking", "Searching", "The", "A", "An", "Hi", "Hello"]);

/** The posting agency's business name, if the text names one ("Sam Realty"); else null. Never a private person's name. */
export function firmOf(body: string): string | null {
  const m = FIRM.exec(body);
  if (!m) return null;
  const words = m[1].split(/\s+/).filter((w) => !NOT_FIRM.has(w));
  const name = [...words, m[2]].join(" ");
  return words.length && name.length <= 60 ? name : null;
}

const hasListingFacts = (f: Facts) => !!(f.area || f.beds || f.type || f.budget);

/**
 * buyer_request: demand words plus a fact (area, beds, type, budget or rental/sale intent).
 * cobroke_listing: supply words plus a fact (area, beds, type or budget).
 * Both demand and supply words: demand wins when a strong demand phrase is there; otherwise supply.
 * Listing signals (NEW TO THE MARKET, EXCLUSIVE LISTING, FOR SALE –, FOR RENT OR SALE, asking $,
 * or a priced headline-style property ad) are supply, even if the copy also says "seeking".
 * Anything else is other.
 */
export function interpret(body: string): Interpretation {
  const facts = factsOf(body);
  const listed = listingSignals(body);
  const demand = DEMAND.test(body) || ANY_UNITS.test(body);
  const supply = listed || SUPPLY.test(body);
  const side = listed ? "supply" : demand && (!supply || STRONG_DEMAND.test(body) || ANY_UNITS.test(body)) ? "demand" : supply ? "supply" : null;
  let kind: Kind = "other";
  if (side === "demand" && (hasListingFacts(facts) || facts.intent)) kind = "buyer_request";
  if (side === "supply" && hasListingFacts(facts)) kind = "cobroke_listing";
  return { kind, facts, firm: kind === "other" ? null : firmOf(body) };
}

/** sale / rent from what the text said, or from the size of a price when it didn't say (sales here are large). */
export function listingTypeOf(f: Facts): ListingType | null {
  if (f.intent === "rent" || f.budget?.monthly) return "rent";
  if (f.intent === "buy") return "sale";
  if (f.budget && f.budget.max >= 100_000) return "sale";
  if (f.budget && f.budget.max < 20_000) return "rent";
  return null;
}

/** What a buyer wants, in our own words, built only from the structured facts (never the original text). */
export function buyerBrief(f: Facts): string {
  const head = [f.beds ? `${f.beds} bed` : null, f.type, f.intent === "rent" ? "rental" : f.intent === "buy" ? "to buy" : null].filter(Boolean).join(" ");
  const where = f.area ? ` in ${f.area}` : "";
  const money = f.budget ? `, budget up to ${f.budget.currency === "TTD" ? "TT$" : "US$"}${f.budget.max}${f.budget.monthly ? " a month" : ""}` : "";
  return `${head || "Buyer request"}${where}${money}`;
}

/** A co-broke listing, in our own words, from the structured facts only. */
export function listingBrief(f: Facts): string {
  const head = [f.beds ? `${f.beds} bed` : null, f.type ?? "listing"].filter(Boolean).join(" ");
  const where = f.area ? ` in ${f.area}` : "";
  const money = f.budget ? `, ${f.budget.currency === "TTD" ? "TT$" : "US$"}${f.budget.max}` : "";
  return `${head}${where}${money}`.trim();
}

/* ---------------- Builders ---------------- */

/** The Inquiry for LeadFlow.receive. Name: the firm, else "Co-broke agent". Phone: the posting agent's number. */
export function toInquiry(messageId: string, phone: string, i: Interpretation): Inquiry {
  const f = i.facts;
  const listingType = listingTypeOf(f);
  return {
    ref: messageId,
    source: "periskope-group",
    name: i.firm ?? "Co-broke agent",
    phone,
    email: null,
    listingId: null,
    listingType,
    area: f.area,
    budget: f.budget ? { max: f.budget.max, currency: f.budget.currency } : null,
    beds: f.beds,
    message: buyerBrief(f),
    channel: "whatsapp",
    propertyKind: propertyKindFromCrm(listingType === "rent" ? "rent" : listingType === "sale" ? "sale" : null, f.type),
  };
}

/**
 * A listing or request body for market-ingest. `group` is the chat_id, the same value used on kind=group.
 * Null when area or listing type is missing (the ingest API requires both). Never includes a consent field.
 */
export function toMarketSourceItem(args: {
  kind: "listing" | "request";
  messageId: string;
  phone: string;
  chatId: string;
  seenAt: string;
  interpretation: Interpretation;
}): MarketSourceItem | null {
  const f = args.interpretation.facts;
  const listingType = listingTypeOf(f);
  if (!f.area || !listingType) return null;
  const item: MarketSourceItem = {
    kind: args.kind,
    sourceMessageId: args.messageId,
    source: "whatsapp",
    group: args.chatId,
    agency: args.interpretation.firm ?? "Co-broke agent",
    agencyPhone: args.phone,
    seenAt: args.seenAt,
    currency: f.budget?.currency ?? "TTD",
    area: f.area,
    listingType,
    notes: args.kind === "request" ? buyerBrief(f) : listingBrief(f),
    title: [f.beds ? `${f.beds} bed` : null, f.type ?? (listingType === "rent" ? "rental" : "listing"), `in ${f.area}`].filter(Boolean).join(" "),
  };
  if (f.beds != null) item.beds = f.beds;
  if (f.baths != null) item.baths = f.baths;
  if (f.type) item.propertyType = f.type;
  if (args.kind === "listing" && f.budget) item.price = f.budget.max;
  if (args.kind === "request" && f.budget) {
    item.priceMax = f.budget.max;
    if (f.budget.min != null) item.priceMin = f.budget.min;
  }
  return item;
}

/** kind=group for market-ingest. Revoke by setting the record's active to false (not by clearing adminOkAt). */
export function toMarketGroupItem(consent: GroupConsent): MarketGroupItem {
  const item: MarketGroupItem = { kind: "group", group: consent.chatId, active: consent.active !== false };
  if (consent.groupName) item.name = consent.groupName;
  if (consent.noticePostedAt) item.noticePostedAt = consent.noticePostedAt;
  if (consent.adminOkAt) item.adminOkAt = consent.adminOkAt;
  if (consent.adminOkBy) item.adminOkBy = consent.adminOkBy;
  return item;
}

/* ---------------- The decision ---------------- */

/**
 * What to do with one webhook payload. Checks run in this order, and the body is read only after the
 * sender's opt-out check: envelope → event type → message fields → from_me → allowlist → sender number
 * → opt-out → consent (and the optional PERISKOPE_ALLOWED_CHATS) → has text (including a media caption) → already seen → classify.
 */
export function decide(input: {
  payload: unknown;
  at: Date;
  env?: Env;
  optedOut: readonly string[];
  consentOf: (chatId: string) => GroupConsent | null;
  seen: (messageId: string) => boolean;
}): Decision {
  const env = input.env ?? runtimeEnv();
  const e = envelopeOf(input.payload);
  if (!e) return { action: "ignore", reason: "not an event" };
  if (e.eventType !== "message.created") return { action: "ignore", reason: `${e.eventType} isn't handled` };
  const m = parseMessage(e.data);
  if (!m) return { action: "ignore", reason: "message fields missing or wrong" };
  if (m.fromMe) return { action: "ignore", reason: "sent by us" };
  const dropped = allowlistCheck(m.chatId, m.chatName, env);
  if (dropped) return { action: "drop", reason: dropped };
  const phone = phoneOf(m.sender);
  if (!phone) return { action: "ignore", reason: "no usable sender number" };
  if (isOptedOut(input.optedOut, phone)) return { action: "ignore", reason: "sender opted out" };
  const consent = input.consentOf(m.chatId);
  if (!consent || !consentAllows(consent, m.chatId, env)) return { action: "ignore", reason: "group not accepted (no notice and admin OK)" };
  if (!m.hasText) return { action: "ignore", reason: "not a text message" };
  if (input.seen(m.messageId)) return { action: "ignore", reason: "already seen" };

  const i = interpret(m.body);
  const sentAt = m.sentAt ?? input.at.toISOString();
  const itemArgs = { messageId: m.messageId, phone, chatId: m.chatId, seenAt: sentAt, interpretation: i };
  const post = postRecordOf({ message: m, phone, interpretation: i, sentAt });
  if (i.kind === "other") return { action: "other", messageId: m.messageId, phone, post };
  if (i.kind === "buyer_request") {
    return { action: "buyer_request", messageId: m.messageId, chatId: m.chatId, phone, facts: i.facts, inquiry: toInquiry(m.messageId, phone, i), item: toMarketSourceItem({ kind: "request", ...itemArgs }), post };
  }
  return { action: "cobroke_listing", messageId: m.messageId, phone, item: toMarketSourceItem({ kind: "listing", ...itemArgs }), post };
}

/** Structured post fields from a parsed message, plus the original text for owners. Listing media URLs are kept; others are dropped. Never log originalText. */
export function postRecordOf(args: { message: ParsedMessage; phone: string; interpretation: Interpretation; sentAt: string }): PostRecord {
  const { message: m, phone, interpretation: i, sentAt } = args;
  const { category, cobroke } = categoryOf(i, m.body);
  const f = i.facts;
  const listingType = listingTypeOf(f);
  const listing = category === "listing_for_sale" || category === "listing_for_rent" || category === "cobroke";
  const rec: PostRecord = {
    messageId: m.messageId,
    chatId: m.chatId,
    sentAt,
    category,
    cobroke,
    senderPhone: phone,
    senderName: m.senderName,
    firm: i.firm,
    area: f.area,
    price: f.budget?.max ?? null,
    currency: f.budget?.currency ?? null,
    beds: f.beds,
    baths: f.baths,
    type: f.type,
    listingType,
    intent: f.intent,
    propertyClass: propertyKindFromCrm(listingType === "rent" ? "rent" : listingType === "sale" ? "sale" : null, f.type),
    notes: i.kind === "buyer_request" ? buyerBrief(f) : i.kind === "cobroke_listing" ? listingBrief(f) : null,
    originalText: m.body.trim() || null,
    groupName: m.chatName,
    set: category === "buyer_request" || category === "rental_request" ? "demand" : category === "listing_for_sale" || category === "listing_for_rent" || category === "cobroke" ? "supply" : null,
    development: developmentOf(f.area)?.name ?? null,
  };
  if (listing && m.mediaUrls.length) rec.mediaUrls = m.mediaUrls;
  return rec;
}

/** Re-run interpret on a stored post's original text, keeping identity, sender and media. */
export function reparsePost(p: PostRecord): PostRecord {
  const body = p.originalText?.trim();
  if (!body) return p;
  const interpretation = interpret(body);
  const next = postRecordOf({
    message: {
      messageId: p.messageId,
      chatId: p.chatId,
      sender: p.senderPhone,
      senderName: p.senderName,
      chatName: p.groupName ?? null,
      body,
      fromMe: false,
      hasText: true,
      textOnly: !((p.mediaUrls?.length ?? 0) + (p.mediaFiles?.length ?? 0)),
      mediaUrls: p.mediaUrls ?? [],
      sentAt: p.sentAt,
    },
    phone: p.senderPhone,
    interpretation,
    sentAt: p.sentAt,
  });
  return { ...next, mediaFiles: p.mediaFiles, mediaUrls: p.mediaUrls ?? next.mediaUrls, groupName: p.groupName ?? next.groupName };
}

/* ---------------- Staff inputs ---------------- */


/** A staff opt-out request: { senderPhone }. The number is normalized, so any common spelling works. */
export function parseOptOut(body: unknown): { ok: true; phone: string } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "send a JSON object with senderPhone" };
  const raw = str(body.senderPhone);
  const phone = raw ? phoneOf(raw) : null;
  return phone ? { ok: true, phone } : { ok: false, error: "senderPhone isn't a phone number" };
}

export type ConsentPatch = { chatId: string } & Partial<Pick<GroupConsent, "groupName" | "noticePostedAt" | "noticeWaivedAt" | "noticeWaivedBy" | "adminOkBy" | "adminOkAt" | "active">>;

/**
 * A partial consent update. Omitted fields stay as they are; null clears one (except active, which is
 * a boolean). Timestamps must be dates (stored as ISO). chatId must be a group (ends in @g.us).
 * adminOkBy is a business name or role, never a phone number. Revoke by setting active: false.
 */
export function parseConsentPatch(body: unknown): { ok: true; patch: ConsentPatch } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "send a JSON object with chatId" };
  const chatId = str(body.chatId);
  if (!chatId || !isGroupChat(chatId)) return { ok: false, error: "chatId must be a WhatsApp group id (ends in @g.us)" };
  const patch: ConsentPatch = { chatId };
  for (const k of ["groupName", "adminOkBy", "noticeWaivedBy"] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (v === null) patch[k] = null;
    else if (typeof v === "string" && v.trim().length <= 200) {
      const value = v.trim() || null;
      if ((k === "adminOkBy" || k === "noticeWaivedBy") && value && containsPhoneNumber(value)) return { ok: false, error: `${k} must be a name or role, not a phone number` };
      patch[k] = value;
    } else return { ok: false, error: `${k} must be text or null` };
  }
  for (const k of ["noticePostedAt", "noticeWaivedAt", "adminOkAt"] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (v === null) patch[k] = null;
    else if (typeof v === "string" && Number.isFinite(Date.parse(v))) patch[k] = new Date(v).toISOString();
    else return { ok: false, error: `${k} must be a date or null` };
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return { ok: false, error: "active must be true or false" };
    patch.active = body.active;
  }
  return { ok: true, patch };
}

/* ---------------- Market-ingest adapter (off unless URL and token are both set) ---------------- */

/** The body for a staff alias on market-ingest. The one place that builds it: change the shape here. */
export function aliasItem(alias: string, canonical: string): MarketAliasItem {
  return { kind: "alias", alias, canonical };
}

export type MarketWriteConfig = { url: string; token: string };

export type MarketWriteResult =
  | { ok: true; kind: "source"; id: number; deduped: boolean }
  | { ok: true; kind: "group"; group: string; active: boolean; adminOk: boolean }
  | { ok: true; kind: "optout" }
  | { ok: true; kind: "alias" }
  | { ok: false; retry: false; error: "not_allowlisted" | "opted_out" | "invalid" | "http"; status: number }
  | { ok: false; retry: true; error: "network" };

/** Both ONEON1_MARKET_WRITE_URL and ONEON1_MARKET_INGEST_TOKEN, or null (dry-run, records only). */
export function marketWriteConfigFromEnv(env: Env = runtimeEnv()): MarketWriteConfig | null {
  const url = (env.ONEON1_MARKET_WRITE_URL ?? "").trim();
  const token = (env.ONEON1_MARKET_INGEST_TOKEN ?? "").trim();
  if (!url || !token) return null;
  return { url, token };
}

/**
 * POST one item. One attempt only: a 403 not_allowlisted or opted_out is not retried; a network (or 5xx)
 * failure is left for the outbox to retry later. The token is sent in Authorization and never logged.
 */
export async function postMarketItem(cfg: MarketWriteConfig, item: MarketIngestItem, fetcher: typeof fetch = fetch): Promise<MarketWriteResult> {
  let response: Response;
  try {
    response = await fetcher(cfg.url, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(item),
    });
  } catch {
    return { ok: false, retry: true, error: "network" };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  if (response.ok) {
    if (item.kind === "group") {
      const g = (isObj(body) ? body : {}) as { group?: unknown; active?: unknown; adminOk?: unknown };
      return { ok: true, kind: "group", group: typeof g.group === "string" ? g.group : item.group, active: g.active === true, adminOk: g.adminOk === true };
    }
    if (item.kind === "optout") return { ok: true, kind: "optout" };
    if (item.kind === "alias") return { ok: true, kind: "alias" };
    const r = (isObj(body) ? body : {}) as { id?: unknown; deduped?: unknown };
    return { ok: true, kind: "source", id: typeof r.id === "number" ? r.id : 0, deduped: r.deduped === true };
  }
  const code = isObj(body) && typeof body.error === "string" ? body.error : "";
  if (response.status === 403 && (code === "not_allowlisted" || code === "opted_out")) {
    return { ok: false, retry: false, error: code, status: 403 };
  }
  if (response.status === 400) return { ok: false, retry: false, error: "invalid", status: 400 };
  if (response.status >= 500) return { ok: false, retry: true, error: "network" };
  return { ok: false, retry: false, error: "http", status: response.status };
}

