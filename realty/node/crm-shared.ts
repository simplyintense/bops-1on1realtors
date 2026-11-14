import { createHash } from "node:crypto";
import { Crm, crmEnv } from "../crm.ts";
import { liveCrmSeam, NOT_CONNECTED, type CrmSeam } from "../flow/crm-seam.ts";
import { runtimeEnv, type Env } from "../flow/env.ts";
import { LiveCrmSource } from "../flow/live-crm.ts";

/**
 * One read-only CRM source per server process, so the bot login signs in once and its session is reused (Crm keeps
 * the token until a minute before it expires, then signs in again) and the property tables are read at most once
 * every 30 seconds (LiveCrmSource's cache). Rebuilt only when the CRM settings change. Null without ONEON1_CRM_*.
 * Reads only: nothing here calls Crm.apply, and ONEON1_CRM_WRITES isn't read.
 */

let shared: { key: string; source: LiveCrmSource } | null = null;

export function sharedCrmSource(env: Env = runtimeEnv(), fetcher?: typeof fetch): LiveCrmSource | null {
  const e = crmEnv(env);
  if (!e) return null;
  // The key tells settings apart without keeping the password itself in it.
  const key = createHash("sha256").update(`${e.url}\n${e.email}\n${e.password}`).digest("hex");
  if (fetcher) return new LiveCrmSource(new Crm(e, fetcher));
  if (!shared || shared.key !== key) shared = { key, source: new LiveCrmSource(new Crm(e)) };
  return shared.source;
}

/** The seam for this server: the live read-only CRM when ONEON1_CRM_* are set, else NOT_CONNECTED. */
export function crmSeamFromEnv(env: Env = runtimeEnv(), fetcher?: typeof fetch): CrmSeam {
  const source = sharedCrmSource(env, fetcher);
  return source ? liveCrmSeam(source) : NOT_CONNECTED;
}
