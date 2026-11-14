import type { PostRecord } from "../flow/periskope.ts";
import { PeriskopeStore, requestIdOf, type LiveRow } from "./periskope-store.ts";

/**
 * Owner views of WhatsApp group posts (original text next to the parse). Agents never receive
 * originalText. The text is not logged here.
 */

export type PostView = Omit<PostRecord, "originalText"> & {
  requestId: string;
  matchCount: number;
  marketMatches: number;
  crmMatches: number;
  originalText?: string;
};

export function matchCounts(live: LiveRow | undefined): { matchCount: number; marketMatches: number; crmMatches: number } {
  const marketMatches = live?.matches.length ?? 0;
  const crmMatches = live?.ours?.length ?? 0;
  return { marketMatches, crmMatches, matchCount: marketMatches + crmMatches };
}

/** The post as a page or API may return it. originalText is present only when owner is true. */
export function postView(post: PostRecord, owner: boolean, live?: LiveRow): PostView {
  const requestId = requestIdOf(post.messageId);
  const counts = matchCounts(live);
  const { originalText, ...rest } = post;
  if (owner) return { ...rest, originalText: originalText ?? undefined, requestId, ...counts };
  return { ...rest, requestId, ...counts };
}

export function listPostViews(store: PeriskopeStore, owner: boolean): PostView[] {
  const liveById = new Map(store.live().map((r) => [r.messageId, r]));
  return store
    .posts()
    .map((p) => postView(p, owner, liveById.get(p.messageId)))
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

export function findPostView(store: PeriskopeStore, requestId: string, owner: boolean): PostView | null {
  const post = store.posts().find((p) => requestIdOf(p.messageId) === requestId);
  if (!post) return null;
  const live = store.live().find((r) => r.messageId === post.messageId);
  return postView(post, owner, live);
}

const AST = "America/Port_of_Spain";

/** Date in AST for the export, e.g. "2026-11-14 09:44 AST". */
export function dateAst(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} AST`;
}

const CSV_HEADER = [
  "date (AST)",
  "group",
  "set",
  "category",
  "development",
  "agent name",
  "agent phone",
  "area",
  "price",
  "beds",
  "baths",
  "type",
  "buy/rent",
  "property class",
  "parsed notes",
  "original text",
  "message link",
  "match count",
] as const;

export function postsToCsv(store: PeriskopeStore): string {
  const liveById = new Map(store.live().map((r) => [r.messageId, r]));
  const rows = [...store.posts()].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  const lines = [CSV_HEADER.join(",")];
  for (const p of rows) {
    const counts = matchCounts(liveById.get(p.messageId));
    const price = p.price != null ? `${p.currency ?? ""} ${p.price}`.trim() : "";
    const buyRent = p.intent ?? p.listingType ?? "";
    const agentName = p.senderName ?? p.firm ?? "";
    lines.push(
      [
        dateAst(p.sentAt),
        p.groupName ?? "",
        p.set ?? "",
        p.cobroke && p.category !== "cobroke" ? `${p.category}+cobroke` : p.category,
        p.development ?? "",
        agentName,
        p.senderPhone ?? "",
        p.area ?? "",
        price,
        p.beds ?? "",
        p.baths ?? "",
        p.type ?? "",
        buyRent,
        p.propertyClass ?? "",
        p.notes ?? "",
        p.originalText ?? "",
        p.messageId,
        counts.matchCount,
      ].map(csvCell).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
