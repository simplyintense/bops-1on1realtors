/**
 * The Bot Workspace (/) for a signed-in staff member: their own chats with the bots, and nothing else of the owner's. Pure and
 * import-free (the types here are structural, so AppState fits them), so the proxy-side helpers and node --test share it, and
 * realty/tsconfig.json includes this one file without pulling in lib/types.ts.
 *
 * A staff member's chat with a bot has its own id (staffChatId), is tagged with their signed-in email (Chat.staff), and is never
 * the owner's default chat (botChatId, "bot:<id>"). The routes check that tag before they read or write a chat (isStaffChatOf).
 * What /api/state sends a staff member is staffState: a whitelist, so a field added to the owner's state later stays out of theirs.
 */

/** The parts of the owner's state this reads. AppState satisfies it. */
export type StaffSource = {
  host?: unknown;
  workspace?: string;
  workspaces?: { id: string; name: string; createdAt: number }[];
  bots: { id: string; name: string; role: string; color: string; isMain: boolean; workspaceId?: string; computerStatus: string }[];
  chats: { id: string; kind: string; botIds: string[]; title?: string; createdAt: number; readAt?: number; typing: string[]; workspaceId?: string; staff?: string }[];
  messages: { id: string; chatId: string; role: string; text: string; at: number; botId?: string; from?: string; replyTo?: string; options?: string[] }[];
};

/** What a staff member is sent: their own chats and what's in them, the bots to pick from, and no more. */
export type StaffView = {
  isOwner: false;
  host?: unknown;
  workspace?: string;
  workspaces?: { id: string; name: string; createdAt: number }[];
  bots: StaffSource["bots"];
  chats: StaffSource["chats"];
  messages: StaffSource["messages"];
  sessions: never[];
  routines: never[];
};

const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

/** A staff member's chat with one bot. Hex-encoded parts keep it to [0-9a-f_], so the gate's path rule can match it exactly. */
export function staffChatId(botId: string, email: string): string {
  return `stf_${hex(botId)}_${hex(email.trim().toLowerCase())}`;
}

/** Whether this chat is `email`'s own. False for the owner's chats (no tag), and for no signed-in email (null). */
export function isStaffChatOf(c: { staff?: string } | undefined, email: string | null | undefined): boolean {
  return !!c && !!email && c.staff === email.trim().toLowerCase();
}

/**
 * The state a staff member sees: `isOwner: false`, the bots (name, colour, whether main: enough to pick one to chat with), the
 * workspaces' names, the host ("orgo" or "mac"), and their own chats and their messages. No sessions, routines or watches, no
 * vault, keys, accounts, owner phones or emails, billing, usage, computers, or the bots' prompts and settings.
 */
export function staffState(state: StaffSource, email: string): StaffView {
  const chats = state.chats.filter((c) => isStaffChatOf(c, email));
  const mine = new Set(chats.map((c) => c.id));
  return {
    isOwner: false,
    host: state.host,
    workspace: state.workspace,
    workspaces: state.workspaces?.map((w) => ({ id: w.id, name: w.name, createdAt: w.createdAt })),
    bots: state.bots.map((b) => ({ id: b.id, name: b.name, role: b.role, color: b.color, isMain: b.isMain, workspaceId: b.workspaceId, computerStatus: b.computerStatus })),
    chats: chats.map((c) => ({ id: c.id, kind: c.kind, botIds: c.botIds, title: c.title, createdAt: c.createdAt, readAt: c.readAt, typing: c.typing, workspaceId: c.workspaceId })),
    messages: state.messages
      .filter((m) => mine.has(m.chatId))
      .map((m) => ({ id: m.id, chatId: m.chatId, role: m.role, text: m.text, at: m.at, botId: m.botId, from: m.from, replyTo: m.replyTo, options: m.options })),
    sessions: [],
    routines: [],
  };
}

/**
 * What /api/auth/status says to a staff member: signed in, as their own email, never asked to sign in to Orgo (that's the owner's,
 * /api/auth/start). The owner's Orgo account is not shown to them.
 */
export function staffAuthStatus(email: string) {
  return { signedIn: true, user: { id: email, email }, needsSignIn: false, cloudProblem: false, isOwner: false };
}
