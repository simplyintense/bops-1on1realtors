"use client";

import { useState } from "react";
import type { ReplayResult } from "@/realty/node/replay.ts";

/**
 * The owners' "Replay samples" button on the digest: POSTs /api/realty/replay (a dry run, nothing kept or sent) and shows
 * what the intake made of each sample message.
 */
export function ReplayButton() {
  const [state, setState] = useState<{ status: "idle" | "running" | "error"; result?: ReplayResult; error?: string }>({ status: "idle" });

  async function run() {
    setState({ status: "running" });
    try {
      const r = await fetch("/api/realty/replay", { method: "POST" });
      const body = await r.json();
      if (!r.ok) return setState({ status: "error", error: typeof body?.error === "string" ? body.error : `HTTP ${r.status}` });
      setState({ status: "idle", result: body as ReplayResult });
    } catch {
      setState({ status: "error", error: "The replay didn't answer. Try again in a minute." });
    }
  }

  const result = state.result;
  return (
    <div className="grid gap-4">
      <div>
        <button type="button" className="rt-btn" onClick={run} disabled={state.status === "running"}>
          {state.status === "running" ? "Replaying…" : "Replay sample WhatsApp messages"}
        </button>
      </div>
      {state.status === "error" ? <p className="rt-notice rt-notice-error">{state.error}</p> : null}
      {result ? (
        <div className="grid gap-3">
          <p className="rt-muted text-sm">
            Dry run. Market search {result.market === "configured" ? "is live, so these are real market matches" : "isn't set up here, so nothing was matched"}.{" "}
            {result.crm === "configured" ? "Our own listings were read from the 1on1 CRM (read only)." : "The 1on1 CRM isn't connected here, so none of our listings were checked."} A second delivery of the first sample:
            &ldquo;{result.duplicate}&rdquo;.
          </p>
          <ul className="grid gap-3">
            {result.messages.map((m) => (
              <li key={m.id} className="rt-card p-4">
                <p className="font-medium">{m.label ?? m.id}</p>
                <p className="rt-muted mt-1 text-xs">
                  Expected {m.expect.replace("_", " ")} · {m.result}
                  {m.status ? ` · ${m.status === "matched" ? `${m.ours.length} on our listings, ${m.matches.length} at other agencies` : m.status}` : ""}
                </p>
                {m.ours.length + m.matches.length ? (
                  <ul className="mt-2 grid gap-1 text-sm">
                    {[...m.ours, ...m.matches].map((x, i) => (
                      <li key={`${x.url ?? x.title}-${i}`}>
                        {x.url ? (
                          <a href={x.url} target="_blank" rel="noopener noreferrer" className="rt-link">
                            {x.title}
                          </a>
                        ) : (
                          x.title
                        )}
                        {[x.area, x.price, x.source].filter(Boolean).length ? <span className="rt-muted"> · {[x.area, x.price, x.source].filter(Boolean).join(" · ")}</span> : null}
                        {x.reason ? <span className="block text-xs">{x.reason}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
