"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { marketLabel, TAUGHT_MARKETS, type PlaceTeach } from "@/realty/flow/taught-areas.ts";

/**
 * "Teach a place": one place, its market, and optionally another name, coordinates, a note, and a nearby or not-nearby partner. POSTs
 * /api/realty/learn/area and says what was saved. The matcher reads the taught places on each request, so a rule taught here is in
 * use at once, with no deploy. A pair counts once both of its places are taught. Teachers only (the page and the route check).
 */
export function TeachPlaceForm({ areas }: { areas: string[] }) {
  const router = useRouter();
  const [state, setState] = useState<{ status: "idle" | "saving" | "error" | "saved"; message?: string }>({ status: "idle" });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (name: string) => String(f.get(name) ?? "").trim();
    const number = (name: string) => (text(name) ? Number(text(name)) : null);
    setState({ status: "saving" });
    try {
      const r = await fetch("/api/realty/learn/area", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: text("name"),
          market: text("market"),
          alias: text("alias"),
          lat: number("lat"),
          lon: number("lon"),
          note: text("note"),
          nearby: text("nearby"),
          notNearby: text("notNearby"),
        }),
      });
      const body = (await r.json().catch(() => ({}))) as Partial<PlaceTeach> & { error?: string };
      if (!r.ok) return setState({ status: "error", message: body.error ?? `HTTP ${r.status}` });
      const c = body as PlaceTeach;
      const pairs = c.pairs.map((p) => `${p.nearby ? "nearby" : "not nearby"} ${p.a === c.place ? p.b : p.a}`);
      const also = c.alias ? `, also called ${c.alias}` : "";
      setState({ status: "saved", message: `Saved ${c.place}, ${marketLabel(c.market)}${also}.${pairs.length ? ` ${pairs.join("; ")}.` : ""}` });
      form.reset();
      router.refresh();
    } catch {
      setState({ status: "error", message: "Didn't save. Try again." });
    }
  }

  const busy = state.status === "saving";
  return (
    <form onSubmit={submit} className="grid gap-2 text-sm">
      <div className="grid gap-2 sm:grid-cols-3">
        <input name="name" required maxLength={80} placeholder="Place name" className="rt-field" aria-label="Place name" />
        <select name="market" required defaultValue="" className="rt-field" aria-label="Market">
          <option value="" disabled>
            Market
          </option>
          {TAUGHT_MARKETS.map((m) => (
            <option key={m} value={m}>
              {marketLabel(m)}
            </option>
          ))}
        </select>
        <input name="alias" maxLength={80} placeholder="Also called (optional)" className="rt-field" aria-label="Also called" />
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <input name="lat" type="number" step="any" placeholder="Latitude (optional)" className="rt-field" aria-label="Latitude" />
        <input name="lon" type="number" step="any" placeholder="Longitude (optional)" className="rt-field" aria-label="Longitude" />
        <input name="nearby" maxLength={80} list="learn-place-areas" placeholder="Nearby to (optional)" className="rt-field" aria-label="Nearby to" />
        <input name="notNearby" maxLength={80} list="learn-place-areas" placeholder="Not nearby to (optional)" className="rt-field" aria-label="Not nearby to" />
      </div>
      <input name="note" maxLength={300} placeholder="Note (optional)" className="rt-field" aria-label="Note" />
      <datalist id="learn-place-areas">
        {areas.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="rt-btn" disabled={busy}>
          {busy ? "Saving…" : "Save place"}
        </button>
        <p className="rt-muted text-xs">A nearby pair counts once both places are taught. The rule is in use at once.</p>
      </div>
      {state.message ? <p className="rt-muted text-xs">{state.message}</p> : null}
      {state.status === "error" ? <p className="rt-notice rt-notice-error">{state.message}</p> : null}
    </form>
  );
}
