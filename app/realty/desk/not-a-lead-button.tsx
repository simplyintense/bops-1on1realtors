"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The "Not a lead" button on a request card (a WhatsApp request, or an Automatch lead's ask). It asks first, since a misclick is
 * easy, then saves to Bops's own record (POST /api/realty/not-a-lead). The request then leaves the matches, the search and the desk
 * on the page refresh. Nothing here sends a message or touches the CRM.
 */
export function NotALeadButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mark() {
    if (!window.confirm("Mark this as not a lead? It will be hidden from matches.")) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/realty/not-a-lead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
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
    <div className="mt-2 grid gap-1">
      <div>
        <button type="button" className="rt-chip" disabled={busy} onClick={mark}>
          Not a lead
        </button>
      </div>
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
