import { flagInputOf } from "../flow/flag-match.ts";
import { sameSecret, type AgentReply, type Env } from "./agent-search.ts";
import { periskopeRoot } from "./periskope-root.ts";
import { SearchStore } from "./search-store.ts";

/**
 * POST /api/realty/learn/flag-match: the 1on1 CRM reports a bad match (a listing that was wrong for a client). Server to server,
 * proving itself by Authorization: Bearer <BOPS_AUTOMATCH_TOKEN> (sameSecret, constant time), the same token as automatch-client.
 * Auth is checked before the body is read, so a wrong token never reads it. Stored in the search store's flagged_matches table for
 * the Teach page ("Flagged from CRM"). Nothing is sent and nothing changes matching.
 *   200 { ok, id } · 400 { error } bad body · 401 { error } · 503 { error } token unset
 */

const NOT_SET: AgentReply = { status: 503, body: { error: "Feedback isn't set up on this server yet." } };
const UNAUTHORIZED: AgentReply = { status: 401, body: { error: "Unauthorized." } };

export type FlagRequest = { authorization: string | null; readBody: () => Promise<string> };
export type FlagOpts = { root?: string; at?: string };

export async function flagMatch(req: FlagRequest, env: Env, o: FlagOpts = {}): Promise<AgentReply> {
  const want = (env.BOPS_AUTOMATCH_TOKEN ?? "").trim();
  if (!want) return NOT_SET;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.authorization ?? "");
  if (!m || !sameSecret(m[1], want)) return UNAUTHORIZED;

  let raw: unknown;
  try {
    raw = JSON.parse(await req.readBody());
  } catch {
    return { status: 400, body: { error: "The body must be JSON." } };
  }
  const f = flagInputOf(raw);
  if (!f.ok) return { status: 400, body: { error: f.error } };

  const store = SearchStore.open(o.root ?? periskopeRoot());
  try {
    return { status: 200, body: { ok: true, id: store.addFlag(f.flag, o.at) } };
  } finally {
    store.close();
  }
}
