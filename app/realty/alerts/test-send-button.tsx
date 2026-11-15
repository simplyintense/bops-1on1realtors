"use client";

import { useState } from "react";

/**
 * Owners' one-off [TEST] send on the Auto-Match Alert page. POSTs /api/realty/automatch-alert, which emails
 * miles@simplyintense.com only (no CC or BCC) with fake details, even while live sending is off.
 */
export function TestSendButton() {
  const [state, setState] = useState<{ status: "idle" | "running" | "ok" | "error"; id?: string; error?: string }>({ status: "idle" });

  async function run() {
    setState({ status: "running" });
    try {
      const r = await fetch("/api/realty/automatch-alert", { method: "POST" });
      const body = (await r.json()) as { ok?: boolean; id?: string; error?: string };
      if (!r.ok || !body?.ok || typeof body.id !== "string") {
        return setState({ status: "error", error: typeof body?.error === "string" ? body.error : `HTTP ${r.status}` });
      }
      setState({ status: "ok", id: body.id });
    } catch {
      setState({ status: "error", error: "The test send didn't answer. Try again in a minute." });
    }
  }

  return (
    <div className="mt-6">
      <button type="button" className="rt-btn" onClick={run} disabled={state.status === "running"}>
        {state.status === "running" ? "Sending test…" : "Send one [TEST] alert to Miles"}
      </button>
      {state.status === "ok" && state.id ? <p className="rt-muted mt-2 text-sm">Test send ok. Message id: {state.id}</p> : null}
      {state.status === "error" ? <p className="mt-2 text-sm text-red-700">{state.error}</p> : null}
    </div>
  );
}
