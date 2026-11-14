"use client";

import { useEffect, useState } from "react";
import type { MarketStrip } from "@/realty/flow/market-stats.ts";

const DURATION_MS = 800;

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function useCountUp(target: number, durationMs = DURATION_MS): number {
  const [n, setN] = useState(0);

  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setN(target);
      return;
    }
    setN(0);
    let start: number | null = null;
    let raf = 0;
    const tick = (now: number) => {
      if (start === null) start = now;
      const p = Math.min(1, (now - start) / durationMs);
      setN(Math.round(target * easeOutCubic(p)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return n;
}

function withListingsNote(n: number | null): string | null {
  return n === null ? null : `${formatCount(n)} with listings`;
}

function Stat({ label, value, note }: { label: string; value: number; note?: string | null }) {
  const n = useCountUp(value);
  return (
    <div className="rt-stat">
      <div className="rt-stat-value" aria-hidden="true">
        <span className="rt-stat-count-animated">{formatCount(n)}</span>
        <span className="rt-stat-count-static">{formatCount(value)}</span>
      </div>
      <div className="rt-stat-label">{label}</div>
      {note ? <div className="rt-stat-note">{note}</div> : null}
      <span className="rt-sr-only">
        {formatCount(value)} {label}{note ? `, ${note}` : ""}
      </span>
    </div>
  );
}

/** Real market_stats totals at the top of /realty/market. Counts up on load unless the user prefers reduced motion. */
export function StatsStrip({ listings, areas, subAreas, areasWithListings, subAreasWithListings }: MarketStrip) {
  return (
    <div className="rt-stats" aria-label="Market size">
      <Stat label="Listings" value={listings} />
      {areas !== null ? <Stat label="areas mapped" value={areas} note={withListingsNote(areasWithListings)} /> : null}
      {subAreas !== null ? (
        <Stat label="sub-areas mapped" value={subAreas} note={withListingsNote(subAreasWithListings)} />
      ) : null}
    </div>
  );
}
