"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MATCH_STATUSES, STATUS_LABEL, type FollowUp, type MatchStatus } from "@/realty/flow/match-status.ts";

/**
 * The three follow-up buttons on a listing match: Contacted, Not a fit, Closed. A press saves the status to Bops's own record
 * (POST /api/realty/match-status); pressing the pressed button again clears it. The page is refreshed from the server after
 * a save, so the desk's hidden matches and the digest's statuses are the server's. `note` is a line the server wrote (the
 * digest's who and when). Nothing here sends a message or touches the CRM.
 */
export function FollowUpButtons({ requestId, listingKey, current, note }: { requestId: string; listingKey: string; current: FollowUp | null; note: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(status: MatchStatus | null) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/realty/match-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, listingKey, status }),
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
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
