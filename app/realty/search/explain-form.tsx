"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The owners' form on a needs-explanation row: an explanation, and an optional alias (a term in the text that means an
 * area, development or type). POSTs /api/realty/explain, then refreshes the results.
 */
export function ExplainForm({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ status: "idle" | "saving" | "error" | "saved"; message?: string }>({ status: "idle" });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "").trim();
    const term = text("term");
    const alias = term ? [{ term, area: text("area") || null, development: text("development") || null, type: text("type") || null }] : [];
    setState({ status: "saving" });
    try {
      const r = await fetch("/api/realty/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, explanation: text("explanation"), aliases: alias }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return setState({ status: "error", message: typeof body?.error === "string" ? body.error : `HTTP ${r.status}` });
      setState({ status: "saved", message: body.promoted ? "Moved to supply or demand." : "Saved. Still needs detail." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Didn't save. Try again." });
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-2 py-2 text-sm">
      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr]">
        <input name="explanation" required maxLength={2000} placeholder="What this post means" className="rt-field" aria-label="Explanation" />
        <input name="term" maxLength={80} placeholder="Alias term (optional)" className="rt-field" aria-label="Alias term" />
        <input name="area" maxLength={80} placeholder="Area" className="rt-field" aria-label="Alias area" />
        <input name="development" maxLength={80} placeholder="Development" className="rt-field" aria-label="Alias development" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input name="type" maxLength={80} placeholder="Type (optional, for the alias)" className="rt-field" aria-label="Alias type" />
        <button type="submit" className="rt-btn" disabled={state.status === "saving"}>
          {state.status === "saving" ? "Saving…" : "Save explanation"}
        </button>
        {state.message ? <span className="rt-muted">{state.message}</span> : null}
        {state.status === "error" ? <span className="rt-notice rt-notice-error">{state.message}</span> : null}
      </div>
    </form>
  );
}
