"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * One open policy question's answer: a one-line text box. POSTs /api/realty/learn/questions; on success the answer
 * replaces the form on this card, and the page is refreshed so the saved date shows. Teachers only (page and route check).
 * Recording an answer changes nothing else: the question is not a post and does not touch matching.
 */
export function QuestionForm({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ status: "idle" | "saving" | "error" | "saved"; message?: string; answer?: string; by?: string }>({ status: "idle" });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const answer = String(new FormData(e.currentTarget).get("answer") ?? "").trim();
    setState({ status: "saving" });
    try {
      const r = await fetch("/api/realty/learn/questions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, answer }),
      });
      const body = (await r.json().catch(() => ({}))) as { answer?: string; answeredBy?: string; error?: string };
      if (!r.ok) return setState({ status: "error", message: body.error ?? `HTTP ${r.status}` });
      setState({ status: "saved", answer: body.answer ?? answer, by: body.answeredBy ?? "teacher" });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Didn't save. Try again." });
    }
  }

  if (state.status === "saved") {
    return (
      <p className="text-sm">
        <span className="rt-muted">Answer ({state.by}):</span> {state.answer}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-2 text-sm sm:grid-cols-[1fr_auto]">
      <input name="answer" required maxLength={300} placeholder="Your answer (one line)" className="rt-field" aria-label="Answer" />
      <button type="submit" className="rt-btn" disabled={state.status === "saving"}>
        {state.status === "saving" ? "Saving…" : "Save answer"}
      </button>
      {state.status === "error" ? <p className="rt-notice rt-notice-error sm:col-span-2">{state.message}</p> : null}
    </form>
  );
}
