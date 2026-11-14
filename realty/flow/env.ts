/**
 * The runtime's environment variables, without importing `process`: Node (and Next) has
 * globalThis.process.env; a Deno edge function or a browser bundle may not, and gets {}. Callers that
 * run somewhere else (Supabase: Deno.env.toObject()) pass their own env object to the *FromEnv helpers.
 */

export type Env = Record<string, string | undefined>;

export function runtimeEnv(): Env {
  const p = (globalThis as { process?: { env?: Env } }).process;
  return p?.env ?? {};
}
