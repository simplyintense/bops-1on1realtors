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

function Stat({ label, value }: { label: string; value: number }) {
  const n = useCountUp(value);
  return (
    <div className="rt-stat">
      <div className="rt-stat-value" aria-hidden="true">
        <span className="rt-stat-count-animated">{formatCount(n)}</span>
        <span className="rt-stat-count-static">{formatCount(value)}</span>
      </div>
      <div className="rt-stat-label">{label}</div>
      <span className="rt-sr-only">
        {formatCount(value)} {label}
      </span>
    </div>
  );
}

/** Real market_stats totals at the top of /realty/market. Counts up on load unless the user prefers reduced motion. */
export function StatsStrip({ listings, areas }: MarketStrip) {
  return (
    <div className="rt-stats" aria-label="Market size">
      <Stat label="Listings" value={listings} />
      {areas !== null ? <Stat label="Areas" value={areas} /> : null}
    </div>
  );
}
