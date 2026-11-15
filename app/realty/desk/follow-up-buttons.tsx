"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FEEDBACK_REASONS, MATCH_STATUSES, REASON_LABEL, STATUS_LABEL, type FeedbackReason, type FollowUp, type MatchStatus } from "@/realty/flow/match-status.ts";

/**
 * The follow-up buttons on a listing match: Contacted, Viewing booked, Not a fit, Already in touch, Closed. A press saves the
 * status to Bops's own record (POST /api/realty/match-status); pressing the pressed button again clears it (and its feedback).
 * On a lead card (`feedback`), once an outcome is set, an optional reason and note can be added, saved with that outcome. The
 * one-tap outcomes don't send a reason. The page is refreshed from the server after a save, so the desk's hidden matches and
 * the digest's statuses are the server's. `note` is a line the server wrote (the digest's who and when). Nothing here sends a
 * message or touches the CRM.
 */
export function FollowUpButtons({ requestId, listingKey, current, note, feedback = false }: { requestId: string; listingKey: string; current: FollowUp | null; note: string | null; feedback?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(status: MatchStatus | null, extra: { reason?: FeedbackReason; note?: string } = {}) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/realty/match-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, listingKey, status, ...extra }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        setError(typeof body?.error === "string" ? body.error : `Couldn't save (HTTP ${r.status}).`);
        return;
      }
      router.refresh();
    } catch {
      setError("Couldn't save. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 grid gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rt-muted text-xs">Follow-up</span>
        {MATCH_STATUSES.map((s) => {
          const pressed = current?.status === s;
          return (
            <button key={s} type="button" className="rt-chip" aria-pressed={pressed} disabled={busy} onClick={() => save(pressed ? null : s)}>
              {STATUS_LABEL[s]}
            </button>
          );
        })}
      </div>
      {note ? <p className="rt-muted text-xs">{note}</p> : null}
      {feedback && current ? (
        <FeedbackForm key={`${current.status}|${current.reason ?? ""}|${current.note ?? ""}`} current={current} busy={busy} onSave={(reason, text) => save(current.status, { ...(reason ? { reason } : {}), ...(text ? { note: text } : {}) })} />
      ) : null}
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}

/** The optional reason and note for an outcome already set. Starts from what's saved; "Save" sends the outcome again with them. */
function FeedbackForm({ current, busy, onSave }: { current: FollowUp; busy: boolean; onSave: (reason: FeedbackReason | undefined, note: string) => void }) {
  const [reason, setReason] = useState<string>(current.reason ?? "");
  const [text, setText] = useState<string>(current.note ?? "");
  const open = !!(current.reason || current.note);
  return (
    <details className="mt-1 text-sm" open={open}>
      <summary className="rt-muted cursor-pointer text-xs">{current.reason || current.note ? "Reason and note (saved)" : "Add a reason or note (optional)"}</summary>
      <div className="mt-2 grid max-w-md gap-2">
        <label className="grid gap-1 text-xs">
          <span className="rt-muted">Reason</span>
          <select className="rounded border px-2 py-1 text-sm" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)}>
            <option value="">No reason</option>
            {FEEDBACK_REASONS.map((r) => (
              <option key={r} value={r}>
                {REASON_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          <span className="rt-muted">Note (optional, up to 300 characters; no phone numbers)</span>
          <textarea className="rounded border px-2 py-1 text-sm" rows={2} maxLength={300} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
        </label>
        <div>
          <button
            type="button"
            className="rt-chip"
            disabled={busy}
            onClick={() => onSave(reason ? (reason as FeedbackReason) : undefined, text.trim())}
          >
            Save reason
          </button>
        </div>
      </div>
    </details>
  );
}
