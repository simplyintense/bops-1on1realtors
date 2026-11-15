"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Changed = { saved: string; stillVague: boolean; promoted: boolean; reparsed: number; promotedRecords: number };

/**
 * One queue item's answer: a one-line answer, and optional small fields (term, area, development, type). POSTs
 * /api/realty/learn, then says what changed and refreshes the queue. Teachers only (the page and the route check).
 */
export function TeachForm({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ status: "idle" | "saving" | "error" | "saved"; message?: string }>({ status: "idle" });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (name: string) => String(f.get(name) ?? "").trim();
    const optional = (name: string) => text(name) || null;
    setState({ status: "saving" });
    try {
      const r = await fetch("/api/realty/learn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, answer: text("answer"), term: optional("term"), area: optional("area"), development: optional("development"), type: optional("type") }),
      });
      const body = (await r.json().catch(() => ({}))) as Partial<Changed> & { error?: string };
      if (!r.ok) return setState({ status: "error", message: body.error ?? `HTTP ${r.status}` });
      const c = body as Changed;
      const what = `Saved as ${c.saved === "alias" ? "a term" : c.saved === "rule" ? "a sale/rent rule" : "a note"}. ${c.reparsed} stored post${c.reparsed === 1 ? "" : "s"} read again, ${c.promotedRecords} moved out of the queue.`;
      setState({ status: "saved", message: c.promoted ? `${what} This one is clear now.` : `${what} This one still needs detail.` });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Didn't save. Try again." });
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-2 text-sm">
      <input name="answer" required maxLength={300} placeholder="What this post means (one line)" className="rt-field" aria-label="Answer" />
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
        <input name="term" maxLength={80} placeholder="Term in the post (optional)" className="rt-field" aria-label="Term" />
        <input name="area" maxLength={80} placeholder="Area" className="rt-field" aria-label="Area" />
        <input name="development" maxLength={80} placeholder="Development" className="rt-field" aria-label="Development" />
        <input name="type" maxLength={80} placeholder="Type" className="rt-field" aria-label="Type" />
        <button type="submit" className="rt-btn" disabled={state.status === "saving"}>
          {state.status === "saving" ? "Saving…" : "Teach"}
        </button>
      </div>
      {state.message ? <p className="rt-muted text-xs">{state.message}</p> : null}
      {state.status === "error" ? <p className="rt-notice rt-notice-error">{state.message}</p> : null}
    </form>
  );
}
