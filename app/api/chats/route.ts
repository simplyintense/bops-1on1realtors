import { getState, id, update } from "@/lib/server/store";
import { botChatId, type Chat } from "@/lib/types";
import { notReady } from "@/lib/server/ready";
import { deleteGroupChat } from "@/lib/server/remove";
import { ownerAllowed } from "@/lib/gate";
import { staffEmail } from "@/realty/node/periskope-intake.ts";
import { ensureStaffChat } from "@/lib/server/staff-chats";

/**
 * Start a conversation: one bot opens its own chat, two or more make a group chat. A staff member gets their own chat with one bot
 * (ensureStaffChat), never the owner's and never a group.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { botIds, title } = (await request.json()) as { botIds?: string[]; title?: string };
  if (!botIds?.length) return Response.json({ error: "pick at least one bot" }, { status: 400 });
  const who = await staffEmail(request);
  if (!ownerAllowed(who)) {
    const chatId = who && botIds.length === 1 ? ensureStaffChat(botIds[0], who) : null;
    return chatId ? Response.json({ chatId }) : Response.json({ error: "Not allowed." }, { status: 403 });
  }
  if (botIds.length === 1) return Response.json({ chatId: botChatId(botIds[0]) });
  const chat: Chat = { id: id("grp"), kind: "group", botIds, title: title?.trim() || undefined, createdAt: Date.now(), typing: [], workspaceId: getState().workspace };
  update((s) => s.chats.push(chat));
  return Response.json({ chatId: chat.id });
}

/** Delete a group chat and its messages (lib/server/remove.ts deleteGroupChat). (A bot's own chat goes when the bot does.) */
export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!ownerAllowed(await staffEmail(request))) return Response.json({ error: "Owners only." }, { status: 403 });
  const { chatId } = (await request.json().catch(() => ({}))) as { chatId?: string };
  if (chatId) deleteGroupChat(chatId);
  return Response.json({ ok: true });
}
