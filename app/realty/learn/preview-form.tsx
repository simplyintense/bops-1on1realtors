"use client";

import { useState } from "react";

type Reading = {
  kind: "supply" | "demand" | "chatter";
  listingType: "sale" | "rent" | "shortlet" | null;
  area: string | null;
  island: "Trinidad" | "Tobago" | null;
  region: string | null;
  bedrooms: number | null;
  price: number | null;
  currency: string | null;
  vague: boolean;
};

const KIND = { supply: "A listing", demand: "A buyer's ask", chatter: "Chatter, not a listing or an ask" } as const;
const LISTING = { sale: "Sale", rent: "Rent", shortlet: "Short let" } as const;

/**
 * "Test how the desk reads this": a place name or a sample post, read with the taught knowledge (POST /api/realty/learn/preview). Any
 * signed-in staff member may use it. Nothing is saved, and the text is not shown back. Only what the desk read is shown.
 */
export function PreviewForm() {
  const [state, setState] = useState<{ status: "idle" | "reading" | "error" | "done"; reading?: Reading; message?: string }>({ status: "idle" });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = String(new FormData(e.currentTarget).get("text") ?? "").trim();
    setState({ status: "reading" });
    try {
      const r = await fetch("/api/realty/learn/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const body = (await r.json().catch(() => ({}))) as Partial<Reading> & { error?: string };
      if (!r.ok) return setState({ status: "error", message: body.error ?? `HTTP ${r.status}` });
      setState({ status: "done", reading: body as Reading });
    } catch {
      setState({ status: "error", message: "Couldn't read that. Try again." });
    }
  }

  const r = state.reading;
  return (
    <div className="grid gap-3">
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <textarea name="text" rows={3} maxLength={4000} required placeholder="A place name, or a sample post" className="rt-field" aria-label="Sample to test" />
        <button type="submit" className="rt-btn self-start" disabled={state.status === "reading"}>
          {state.status === "reading" ? "Reading…" : "Read it"}
        </button>
      </form>
      {state.status === "error" ? <p className="rt-notice rt-notice-error">{state.message}</p> : null}
      {r ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="rt-muted">Reads as</dt>
          <dd>{KIND[r.kind]}</dd>
          <dt className="rt-muted">Sale or rent</dt>
          <dd>{r.listingType ? LISTING[r.listingType] : "Not said"}</dd>
          <dt className="rt-muted">Area</dt>
          <dd>{r.area ?? "None found"}</dd>
          <dt className="rt-muted">Island</dt>
          <dd>{r.island ?? "Not known"}</dd>
          <dt className="rt-muted">Market</dt>
          <dd>{r.region ?? "Not taught yet"}</dd>
          <dt className="rt-muted">Bedrooms</dt>
          <dd>{r.bedrooms ?? "Not said"}</dd>
          <dt className="rt-muted">Price</dt>
          <dd>{r.price != null ? `${r.currency === "USD" ? "US$" : "TT$"}${r.price.toLocaleString("en-US")}` : "Not said"}</dd>
          <dt className="rt-muted">Matching</dt>
          <dd>{r.vague ? "Too vague: it would wait in the queue for an explanation" : "Clear enough to match"}</dd>
        </dl>
      ) : null}
    </div>
  );
}
