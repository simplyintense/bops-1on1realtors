import { chat, getState, update } from "@/lib/server/store";
import { workspaceOf, type Chat } from "@/lib/types";
import { staffChatId } from "@/lib/staff-workspace";

/**
 * A staff member's own chat with a bot (lib/staff-workspace.ts staffChatId), made the first time it's asked for; its id, or null
 * for no such bot. Tagged with their email, so the routes let only them write to it. Idempotent, and no write once it exists
 * (the state poll asks for every bot each time).
 */
export function ensureStaffChat(botId: string, email: string): string | null {
  const b = getState().bots.find((x) => x.id === botId);
  if (!b) return null;
  const id = staffChatId(botId, email);
  if (chat(id)) return id;
  update((s) => {
    if (s.chats.some((c) => c.id === id)) return;
    const made: Chat = { id, kind: "bot", botIds: [botId], createdAt: Date.now(), typing: [], workspaceId: workspaceOf(b), staff: email.trim().toLowerCase() };
    s.chats.push(made);
  });
  return id;
}
