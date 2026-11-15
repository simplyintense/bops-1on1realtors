import type { Env } from "../flow/env.ts";
import { scrubMailError, type AutoMatchAlert } from "../flow/automatch-alert.ts";

/**
 * Resend HTTP transport for Auto-Match Alert. POST https://api.resend.com/emails with fetch, no extra dependency.
 * The API key is read from RESEND_API_KEY and is never logged. Callers pass a fake key in tests.
 */

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";
export const RESEND_API_KEY_FLAG = "RESEND_API_KEY";

export type ResendSendInput = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
};

export type ResendSendResult =
  | { ok: true; id: string; duplicate?: boolean }
  | { ok: false; retryable: boolean; status: number | null; error: string };

/** The key if set, else null. Never log the return value. */
export function resendApiKey(env: Env = {}): string | null {
  const raw = (env[RESEND_API_KEY_FLAG] ?? "").trim();
  return raw || null;
}

export function hasResendKey(env: Env = {}): boolean {
  return resendApiKey(env) != null;
}

export type SendFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Send one email through Resend. 2xx with an id, or a duplicate idempotency response, is success.
 * 429 and 5xx and network failures are retryable (the caller must not mark the match sent).
 * Other 4xx are not retryable by this loop, and also must not be marked sent.
 */
export async function sendResendEmail(input: ResendSendInput, o: { apiKey: string; fetch: SendFetch }): Promise<ResendSendResult> {
  const body: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    reply_to: input.replyTo,
    subject: input.subject,
    text: input.text,
    html: input.html,
  };
  if (input.cc?.length) body.cc = input.cc;
  if (input.bcc?.length) body.bcc = input.bcc;
  let res: Response;
  try {
    res = await o.fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${o.apiKey}`,
        "content-type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, retryable: true, status: null, error: scrubMailError((e as Error).message ?? String(e)) };
  }
  const text = await res.text();
  const parsed = parseJson(text);
  if (res.ok) {
    const id = typeof parsed?.id === "string" ? parsed.id : "";
    if (!id) return { ok: false, retryable: true, status: res.status, error: "Resend returned no message id" };
    return { ok: true, id };
  }
  // A repeated Idempotency-Key is treated as already sent (do not send again, do record as sent).
  if (res.status === 409 || isIdempotentReplay(res.status, parsed, text)) {
    const id = typeof parsed?.id === "string" ? parsed.id : "duplicate";
    return { ok: true, id, duplicate: true };
  }
  const retryable = res.status === 429 || res.status >= 500;
  return { ok: false, retryable, status: res.status, error: scrubMailError(errorMessage(parsed, text, res.status)) };
}

function parseJson(text: string): { id?: unknown; message?: unknown; name?: unknown; error?: unknown } | null {
  try {
    return JSON.parse(text) as { id?: unknown; message?: unknown; name?: unknown; error?: unknown };
  } catch {
    return null;
  }
}

function isIdempotentReplay(status: number, parsed: { message?: unknown; name?: unknown } | null, text: string): boolean {
  if (status !== 400 && status !== 409) return false;
  const blob = `${String(parsed?.name ?? "")} ${String(parsed?.message ?? "")} ${text}`.toLowerCase();
  return blob.includes("idempotency") || blob.includes("already");
}

function errorMessage(parsed: { message?: unknown; error?: unknown } | null, text: string, status: number): string {
  if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message;
  if (typeof parsed?.error === "string" && parsed.error.trim()) return parsed.error;
  return text.trim() ? text.trim().slice(0, 300) : `HTTP ${status}`;
}

/** The payload for a live alert (includes CC/BCC) or a test alert (caller passes empty cc/bcc). */
export function resendInputOf(
  a: AutoMatchAlert,
  o: { from: string; replyTo: string; to?: string[]; cc?: string[]; bcc?: string[]; idempotencyKey: string },
): ResendSendInput {
  return {
    from: o.from,
    to: o.to ?? [a.to],
    cc: o.cc ?? a.cc,
    bcc: o.bcc ?? a.bcc,
    replyTo: o.replyTo,
    subject: a.subject,
    text: a.text,
    html: a.html,
    idempotencyKey: o.idempotencyKey,
  };
}
