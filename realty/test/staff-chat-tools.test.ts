import assert from "node:assert/strict";
import { test } from "node:test";
import { isStaffChat, isStaffChatTool, staffChatTools, STAFF_CRM_TOOL_NAMES, STAFF_SEARCH_TOOL_NAMES } from "../../lib/staff-chat-tools.ts";
import { WORKSPACE_SEARCH_TOOL_NAMES } from "../node/workspace-search-tools.ts";

/**
 * The tools a staff member's chat may use (lib/staff-chat-tools.ts, lib/server/chat.ts turn). Invented fixtures and tool names
 * only: the names are the real ones, checked against their exports where a test can load them.
 */

const SIX = ["realty_listings", "realty_market_search", "realty_new_leads", "realty_pipeline", "realty_showings", "realty_whatsapp_search"];

test("the staff allowlist is exactly the four 1on1 CRM tools and the two read-only search tools", () => {
  assert.deepEqual([...STAFF_CRM_TOOL_NAMES, ...STAFF_SEARCH_TOOL_NAMES].sort(), SIX);
  assert.deepEqual([...STAFF_CRM_TOOL_NAMES].sort(), ["realty_listings", "realty_new_leads", "realty_pipeline", "realty_showings"]);
  assert.deepEqual([...STAFF_SEARCH_TOOL_NAMES].sort(), ["realty_market_search", "realty_whatsapp_search"]);
});

test("the search names are the workspace search tools' own exports", () => {
  assert.deepEqual([...STAFF_SEARCH_TOOL_NAMES].sort(), [...WORKSPACE_SEARCH_TOOL_NAMES].sort());
});

test("each allowed tool passes, and nothing else does", () => {
  for (const name of SIX) assert.equal(isStaffChatTool(name), true, name);
  assert.equal(isStaffChatTool(""), false);
  assert.equal(isStaffChatTool("realty_LISTINGS"), false, "names match exactly");
});

test("memory, owner and mutating tools are rejected in a staff chat", () => {
  const blocked = [
    "remember", "recall", // owner memory
    "start_task", "hand_off", "tell_task", "create_bot", "work_on_app", // computer, handing work on, new bots
    "send_email", "reply_email", "check_email", "read_email", "text_me", // email and texts
    "web_fetch", "web_search", // the web
    "call_api", "use_app", "find_app_actions", "deploy_app", "make_app", "change_app", "local_app", // keys and apps
    "create_skill", "update_skill", "read_skill", "propose_skill_change", // skills
    "schedule", "manage_routine", "watch", "stop_watch", // routines and watches
    "make_page", "make_image", "react", "ask_teammate", "draft_reply",
  ];
  for (const name of blocked) assert.equal(isStaffChatTool(name), false, name);
});

test("Orgo's CRM, business-data and Orbit tools are rejected, even though they're similar to the realty ones", () => {
  // crm.ts CRM_TOOL_NAMES, treg.ts DATA_TOOL_NAMES, orbit.ts ORBIT_TOOL_NAMES: literal names, as those modules are server-only.
  const blocked = ["crm_files", "crm_read", "crm_save_rows", "crm_create_file", "business_search", "find_data", "get_data", "orbit_read", "orbit_update", "orbit_forget"];
  for (const name of blocked) assert.equal(isStaffChatTool(name), false, name);
});

test("filtering a mixed tool list keeps only the six realty tools, in order", () => {
  const offered = [
    { type: "function", name: "start_task" },
    { type: "web_search", search_context_size: "low" }, // hosted: no name, so dropped
    { type: "function", name: "realty_new_leads" },
    { type: "function", name: "remember" },
    { type: "function", name: "realty_whatsapp_search" },
    { type: "function", name: "crm_read" },
    { type: "function", name: "realty_market_search" },
    { type: "function", name: "send_email" },
    { type: "function", name: "realty_listings" },
    { type: "function", name: "realty_showings" },
    { type: "function", name: "realty_pipeline" },
  ];
  const kept = staffChatTools(offered).map((t) => t.name);
  assert.deepEqual(kept, ["realty_new_leads", "realty_whatsapp_search", "realty_market_search", "realty_listings", "realty_showings", "realty_pipeline"]);
});

test("a staff-tagged chat is a staff chat; an owner's bot chat, untagged, is not", () => {
  assert.equal(isStaffChat({ staff: "kerry@1on1.example" }), true);
  const ownerBot: { staff?: string; kind: string; botIds: string[] } = { kind: "bot", botIds: ["bot_main"] };
  const group: { staff?: string; kind: string; botIds: string[] } = { kind: "group", botIds: ["bot_main", "bot_two"] };
  assert.equal(isStaffChat(ownerBot), false, "the owner's default bot chat");
  assert.equal(isStaffChat(group), false, "a group");
  assert.equal(isStaffChat({ staff: "" }), false, "an empty tag is no tag");
  assert.equal(isStaffChat(undefined), false, "no such chat");
});

test("the helpers only narrow: an owner's turn never runs through them, so its tools aren't touched", () => {
  // Owner turns skip the staff filter (chat.ts turn: `staff ? staffChatTools(offerable) : offerable`). Here the contract is that
  // the owner's chat is not a staff chat, so that branch is never taken for it.
  const ownerBot: { staff?: string; kind: string; botIds: string[] } = { kind: "bot", botIds: ["bot_main"] };
  assert.equal(isStaffChat(ownerBot), false);
  assert.equal(isStaffChatTool("remember"), false, "the helper itself refuses owner tools; it's only applied to staff chats");
});
