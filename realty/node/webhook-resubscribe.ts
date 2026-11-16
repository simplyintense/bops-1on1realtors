import type { Env } from "../flow/env.ts";
import { publicBaseUrl } from "../flow/admin-digest.ts";

/**
 * Reconnect for the Periskope webhook: when the poller sees the webhook is DOWN, resume OUR exact hook URL for the
 * message.created event, and nothing else. Periskope pauses an endpoint that fails often (is_subscribed false), so the
 * fix is to PATCH that row back to isSubscribed true. With no row for our URL, POST one. Never another URL, never another
 * event type. Bearer auth with the key the poller already has; the key and the response bodies are never logged.
 *
 * The kill-switch PERISKOPE_AUTO_RESUBSCRIBE is ON by default. Unset, empty, 1, true, yes and on keep it on; 0, false,
 * no and off (any case) turn it off. (It deliberately does not use flagOn(), which reads unset as off.)
 */

export const PERISKOPE_WEBHOOKS_URL = "https://api.periskope.app/v1/webhooks";
export const WEBHOOK_EVENT = "message.created";
/** At most one reconnect attempt per hour, however often the poller sees DOWN. */
export const RECONNECT_EVERY_MS = 60 * 60_000;
const SWITCH_OFF = new Set(["0", "false", "no", "off"]);

export function autoResubscribeOn(env: Env): boolean {
  return !SWITCH_OFF.has((env.PERISKOPE_AUTO_RESUBSCRIBE ?? "").trim().toLowerCase());
}

/** The exact URL Periskope posts to: BOPS_PUBLIC_URL (or the default) plus /api/intake/periskope. */
export function webhookHookUrl(env: Env): string {
  return `${publicBaseUrl(env)}/api/intake/periskope`;
}

export type ResubscribeResult = { ok: true; action: "resumed" | "created" | "already_subscribed" } | { ok: false; action: "failed"; code: string };

type HookRow = { id?: unknown; hook_url?: unknown; integration_name?: unknown; is_subscribed?: unknown };
type Call = { status: number; body: unknown };

async function call(f: typeof fetch, apiKey: string, method: "GET" | "PATCH" | "POST", url: string, body?: unknown): Promise<Call | null> {
  try {
    const r = await f(url, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: r.status, body: parsed };
  } catch {
    return null;
  }
}

const ok2xx = (c: Call | null): boolean => !!c && c.status >= 200 && c.status < 300;

function rowsOf(body: unknown): HookRow[] {
  if (Array.isArray(body)) return body as HookRow[];
  if (body && typeof body === "object") {
    const o = body as { webhooks?: unknown; data?: unknown };
    if (Array.isArray(o.webhooks)) return o.webhooks as HookRow[];
    if (Array.isArray(o.data)) return o.data as HookRow[];
  }
  return [];
}

/**
 * One reconnect attempt for `hookUrl`. GET the rows for it (message.created), then: a paused row is PATCHed back on; no
 * row is POSTed; a live row is left alone. Failures return a short code (the HTTP status or "network"), never a body.
 */
export async function resubscribeWebhook(o: { apiKey: string; hookUrl: string; fetch: typeof fetch }): Promise<ResubscribeResult> {
  const fail = (code: string): ResubscribeResult => ({ ok: false, action: "failed", code });
  const q = new URLSearchParams({ hook_url: o.hookUrl, integration_name: WEBHOOK_EVENT });
  const listed = await call(o.fetch, o.apiKey, "GET", `${PERISKOPE_WEBHOOKS_URL}?${q}`);
  if (!listed) return fail("network");
  if (listed.status !== 200) return fail(`list_${listed.status}`);

  const row = rowsOf(listed.body).find((r) => r.hook_url === o.hookUrl && r.integration_name === WEBHOOK_EVENT);
  if (row) {
    if (row.is_subscribed !== false) return { ok: true, action: "already_subscribed" };
    if (row.id === undefined || row.id === null || String(row.id) === "") return fail("no_row_id");
    const patched = await call(o.fetch, o.apiKey, "PATCH", `${PERISKOPE_WEBHOOKS_URL}/${encodeURIComponent(String(row.id))}`, { isSubscribed: true });
    return ok2xx(patched) ? { ok: true, action: "resumed" } : fail(patched ? `patch_${patched.status}` : "network");
  }
  const created = await call(o.fetch, o.apiKey, "POST", PERISKOPE_WEBHOOKS_URL, { hookUrl: o.hookUrl, integrationName: WEBHOOK_EVENT });
  return ok2xx(created) ? { ok: true, action: "created" } : fail(created ? `post_${created.status}` : "network");
}
