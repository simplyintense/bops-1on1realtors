/**
 * A sliding-window rate limit for the sign-in routes (app/api/gate/login, app/api/gate/callback), per client IP. In memory, so
 * it holds per server process: enough to slow a script guessing at the callback, not a shared store. Pure: the clock is passed in.
 */

export const GATE_RATE_LIMIT = 20;
export const GATE_RATE_WINDOW_MS = 10 * 60_000;

export type RateLimiter = { allow(key: string, now?: number): boolean; size(): number };

export function makeRateLimiter(limit = GATE_RATE_LIMIT, windowMs = GATE_RATE_WINDOW_MS, maxKeys = 10_000): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    allow(key, now = Date.now()) {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.delete(key);
      if (hits.size >= maxKeys) {
        // Drop the oldest key (Maps keep insertion order) so the table can't grow without bound.
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
      hits.set(key, recent);
      return true;
    },
    size: () => hits.size,
  };
}

/** The caller's address: the platform's header (Fly), else the first hop of X-Forwarded-For, else "unknown" (one shared bucket). */
export function clientIp(headers: Headers): string {
  const fly = headers.get("fly-client-ip")?.trim();
  if (fly) return fly;
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || "unknown";
}

export const loginRateLimiter = makeRateLimiter();
export const callbackRateLimiter = makeRateLimiter();
