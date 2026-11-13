import type { Agent } from "./agents.ts";
import type { CrmContact } from "./dedupe.ts";
import type { CrmWrite, Proposal } from "./proposals.ts";
import { runtimeEnv } from "./flow/env.ts";

/**
 * The 1on1 CRM (Supabase project behind 1on1realtors.com) for the CLI tools, over its REST API, signed
 * in as the bot login so the CRM's row-level security decides what it sees. Same settings as
 * lib/server/realty-crm.ts (ONEON1_CRM_URL, ONEON1_CRM_ANON_KEY, ONEON1_CRM_BOT_EMAIL,
 * ONEON1_CRM_BOT_PASSWORD). Never the service-role key. Nothing here prints a key, password or token.
 *
 * Writes: only approved proposals, only with ONEON1_CRM_WRITES=1, only to contact_submissions and
 * crm_tasks (the two tables a lead or a to-do lands in), one row each, and never the same proposal twice
 * (the caller keeps the ledger). Everything else is reads.
 */

type Env = { url: string; anon: string; email: string; password: string };

export function crmEnv(env: Record<string, string | undefined> = runtimeEnv()): Env | null {
  const url = env.ONEON1_CRM_URL?.trim().replace(/\/+$/, "");
  const anon = env.ONEON1_CRM_ANON_KEY?.trim();
  const email = env.ONEON1_CRM_BOT_EMAIL?.trim();
  const password = env.ONEON1_CRM_BOT_PASSWORD ?? "";
  if (!url || !anon || !email || !password || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) return null;
  return { url, anon, email, password };
}

export const writesOn = (env: Record<string, string | undefined> = runtimeEnv()) => env.ONEON1_CRM_WRITES === "1";

export class Crm {
  private e: Env;
  private session: { token: string; until: number } | null = null;
  private fetcher: typeof fetch;

  constructor(e: Env, fetcher: typeof fetch = fetch) {
    this.e = e;
    this.fetcher = fetcher;
  }

  private async token(): Promise<string> {
    if (this.session && this.session.until > Date.now() + 60_000) return this.session.token;
    const r = await this.fetcher(`${this.e.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: this.e.anon, "content-type": "application/json" },
      body: JSON.stringify({ email: this.e.email, password: this.e.password }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`couldn't sign in to the 1on1 CRM (${r.status})`);
    const j = (await r.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error("the 1on1 CRM gave no session");
    this.session = { token: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.session.token;
  }

  async read(table: string, params: Record<string, string>): Promise<Record<string, unknown>[]> {
    const r = await this.fetcher(`${this.e.url}/rest/v1/${table}?${new URLSearchParams(params)}`, {
      headers: { apikey: this.e.anon, authorization: `Bearer ${await this.token()}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`the 1on1 CRM refused ${table} (${r.status})`);
    return (await r.json()) as Record<string, unknown>[];
  }

  /** Every page of a table (PostgREST caps a response; 1,000 rows a page). */
  async readAll(table: string, select: string, filter: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let off = 0; off < 20_000; off += 1000) {
      const rows = await this.read(table, { select, ...filter, order: "id.asc", limit: "1000", offset: String(off) });
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }

  async agents(): Promise<Agent[]> {
    const rows = await this.readAll("agents", "id,name,email,phone");
    return rows.map((r) => ({ id: Number(r.id), name: String(r.name ?? ""), email: (r.email as string) ?? null, phone: (r.phone as string) ?? null }));
  }

  /**
   * Everyone the CRM already knows, for dedupe. A table the bot login can't read (crm_clients without
   * super admin or the read-only view: docs/1on1-crm-readonly.sql) is skipped and named in `missing`.
   */
  async contacts(): Promise<{ contacts: CrmContact[]; missing: string[] }> {
    const contacts: CrmContact[] = [];
    const missing: string[] = [];
    const take = async (table: CrmContact["table"], source: string, agentCol: string, filter: Record<string, string> = {}) => {
      try {
        const rows = await this.readAll(source, `id,name,email,phone,${agentCol}`, filter);
        for (const r of rows) {
          contacts.push({ table, id: String(r.id), name: (r.name as string) ?? null, email: (r.email as string) ?? null, phone: (r.phone as string) ?? null, agentId: r[agentCol] == null ? null : Number(r[agentCol]) });
        }
      } catch {
        missing.push(source);
      }
    };
    // The read-only view first (if it was added), else the table itself (works only as super admin).
    await take("crm_clients", "bops_crm_clients", "agent_id");
    if (missing.includes("bops_crm_clients")) {
      missing.splice(missing.indexOf("bops_crm_clients"), 1);
      await take("crm_clients", "crm_clients", "agent_id");
    }
    await take("contact_submissions", "contact_submissions", "assigned_agent_id", { deleted_at: "is.null" });
    await take("property_inquiries", "property_inquiries", "assigned_agent_id", { deleted_at: "is.null" });
    return { contacts, missing };
  }

  /** One approved proposal's row. Refuses unless ONEON1_CRM_WRITES=1 and the proposal is approved and unblocked. */
  async apply(p: Proposal, env: Record<string, string | undefined> = runtimeEnv()): Promise<string> {
    if (!writesOn(env)) throw new Error("CRM writes are off (ONEON1_CRM_WRITES isn't 1)");
    if (!p.approved) throw new Error(`proposal ${p.id} isn't approved`);
    if (p.blockers.length) throw new Error(`proposal ${p.id} is blocked: ${p.blockers.join("; ")}`);
    const w = checkWrite(p.write);
    const r = await this.fetcher(`${this.e.url}/rest/v1/${w.table}`, {
      method: "POST",
      headers: { apikey: this.e.anon, authorization: `Bearer ${await this.token()}`, "content-type": "application/json", prefer: "return=representation" },
      body: JSON.stringify(w.row),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`the 1on1 CRM refused the ${w.table} row (${r.status})`);
    const [row] = (await r.json()) as { id?: unknown }[];
    return String(row?.id ?? "");
  }
}

/** Only the two tables and the columns this tool proposes; anything else in an edited proposals.json is refused. */
export function checkWrite(w: CrmWrite | null): CrmWrite {
  if (!w) throw new Error("nothing to write");
  const allowed: Record<string, string[]> = {
    contact_submissions: ["name", "email", "phone", "message", "status", "notes"],
    crm_tasks: ["title", "message", "assignee_agent_id", "priority", "status", "due_date"],
  };
  const cols = allowed[w.table];
  if (!cols) throw new Error(`writing to ${w.table} isn't allowed`);
  const extra = Object.keys(w.row).filter((k) => !cols.includes(k));
  if (extra.length) throw new Error(`unexpected columns for ${w.table}: ${extra.join(", ")}`);
  if (w.table === "crm_tasks" && typeof w.row.assignee_agent_id !== "number") throw new Error("a CRM task needs an agent");
  if (w.table === "contact_submissions" && !w.row.email) throw new Error("a contact row needs an email");
  return w;
}
