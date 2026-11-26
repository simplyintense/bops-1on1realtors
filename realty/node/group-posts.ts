import type { PostRecord } from "../flow/periskope.ts";
import { PeriskopeStore, requestIdOf, type LiveRow } from "./periskope-store.ts";
import { dateAst } from "../flow/ast-time.ts";

/**
 * Views of WhatsApp group posts. Agents never receive originalText, the group name or the chat id. Owners get all of
 * them; the post page (/realty/posts/<id>) passes withText so that any signed-in staff member can check the parse against
 * the original message. The text is not logged here.
 */

export type PostView = Omit<PostRecord, "originalText" | "chatId" | "groupName"> & {
  requestId: string;
  matchCount: number;
  marketMatches: number;
  crmMatches: number;
  /** Owners only: the WhatsApp chat and group. */
  chatId?: string;
  groupName?: string | null;
  /** Present when withText is true (owners, and staff on the post page). */
  originalText?: string;
};

export function matchCounts(live: LiveRow | undefined): { matchCount: number; marketMatches: number; crmMatches: number } {
  const marketMatches = live?.matches.length ?? 0;
  const crmMatches = live?.ours?.length ?? 0;
  return { marketMatches, crmMatches, matchCount: marketMatches + crmMatches };
}

/**
 * The post as a page or API may return it. The group name and chat id are present only when owner is true. The original
 * text is present when withText is true, which defaults to owner.
 */
export function postView(post: PostRecord, owner: boolean, live?: LiveRow, withText: boolean = owner): PostView {
  const requestId = requestIdOf(post.messageId);
  const counts = matchCounts(live);
  const { originalText, chatId, groupName, ...rest } = post;
  const view: PostView = { ...rest, requestId, ...counts };
  if (owner) {
    view.chatId = chatId;
    view.groupName = groupName;
  }
  if (withText) view.originalText = originalText ?? undefined;
  return view;
}

export function listPostViews(store: PeriskopeStore, owner: boolean): PostView[] {
  const liveById = new Map(store.live().map((r) => [r.messageId, r]));
  return store
    .posts()
    .map((p) => postView(p, owner, liveById.get(p.messageId)))
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

export function findPostView(store: PeriskopeStore, requestId: string, owner: boolean, withText: boolean = owner): PostView | null {
  const post = store.posts().find((p) => requestIdOf(p.messageId) === requestId);
  if (!post) return null;
  const live = store.live().find((r) => r.messageId === post.messageId);
  return postView(post, owner, live, withText);
}

/** Date in AST for the export (flow/ast-time.ts, shared with the admin digest). */
export { dateAst };

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
