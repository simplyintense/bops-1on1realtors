/**
 * The tools a staff member's chat with a bot may use (lib/server/chat.ts turn). A staff chat (Chat.staff, lib/staff-workspace.ts) is
 * answered here, never through Bops Cloud, and with only the read-only realty data tools below: no memory, no owner tools, no
 * computer. Pure and import-free, so node --test loads it and realty/tsconfig.json includes this one file.
 *
 * The names are the tools' own: realty-crm.ts (REALTY_TOOL_NAMES) and realty/node/workspace-search-tools.ts
 * (WORKSPACE_SEARCH_TOOL_NAMES). realty-crm.ts is server-only, so its four are listed here; the test checks the search two against
 * their exports.
 */

/** 1on1 Realtors' CRM, read-only (realty-crm.ts). */
export const STAFF_CRM_TOOL_NAMES = ["realty_new_leads", "realty_listings", "realty_showings", "realty_pipeline"] as const;

/** WhatsApp supply and demand, and other agencies' listings, read-only (realty/node/workspace-search-tools.ts). */
export const STAFF_SEARCH_TOOL_NAMES = ["realty_whatsapp_search", "realty_market_search"] as const;

const STAFF_TOOL_NAMES: ReadonlySet<string> = new Set<string>([...STAFF_CRM_TOOL_NAMES, ...STAFF_SEARCH_TOOL_NAMES]);

/** Whether a staff chat turn may offer or run this tool: only the six read-only realty tools. */
export const isStaffChatTool = (name: string): boolean => STAFF_TOOL_NAMES.has(name);

/** Keeps only the tools a staff chat turn may have. A tool without a name (OpenAI's hosted web search) is dropped. */
export function staffChatTools<T extends object>(tools: readonly T[]): T[] {
  return tools.filter((t) => "name" in t && typeof t.name === "string" && isStaffChatTool(t.name));
}

/** Whether a chat is a staff member's own (Chat.staff set). Owner chats (no tag) are never restricted by the helpers above. */
export const isStaffChat = (c: { staff?: string } | undefined): boolean => !!c?.staff;
