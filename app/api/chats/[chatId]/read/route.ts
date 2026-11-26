import { chat, update } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";
import { ownerAllowed } from "@/lib/gate";
import { isStaffChatOf } from "@/lib/staff-workspace";
import { staffEmail } from "@/realty/node/periskope-intake.ts";

/** Mark a chat read, which clears its unread dot. A staff member may mark only their own chat (lib/staff-workspace.ts). */
export async function POST(request: Request, ctx: RouteContext<"/api/chats/[chatId]/read">) {
  const unready = notReady();
  if (unready) return unready;
  const { chatId } = await ctx.params;
  const who = await staffEmail(request);
  if (!ownerAllowed(who) && !isStaffChatOf(chat(chatId), who)) return Response.json({ error: "Not allowed." }, { status: 403 });
  update(() => {
    const c = chat(chatId);
    if (c) c.readAt = Date.now();
  });
  return Response.json({ ok: true });
}
