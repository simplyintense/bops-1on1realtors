"use client";

import { useRef, useState } from "react";
import type { CoBrokeHit } from "@/realty/flow/market-search.ts";
import { moneyLabel } from "@/realty/flow/market-search.ts";

/**
 * The results table and the hover/tap card. Listings themselves are loaded on the server; this file only
 * opens a card over a row (mouse hover or a tap on a touch screen). Photos are hotlinked from the source
 * (`photo`) with loading=lazy and are not stored. A missing or broken photo shows a placeholder. No scores.
 */

const SOURCE_LABEL: Record<string, string> = {
  mybunchofkeys: "MyBunchOfKeys",
  trinidadrealtor: "Trinidad Realtor",
  remax: "RE/MAX",
  pintt: "PIN.tt",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source.toLowerCase()] ?? source;
}

export function pricesOf(h: CoBrokeHit): { ttd: string | null; usd: string | null; other: string | null } {
  const label = moneyLabel(h.price, h.currency);
  const c = (h.currency ?? "").toUpperCase();
  return {
    ttd: c === "TTD" ? label : null,
    usd: c === "USD" ? label : null,
    other: c === "TTD" || c === "USD" ? null : label,
  };
}

export function ListingTable({ listings }: { listings: CoBrokeHit[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (i: number) => {
    if (leave.current) clearTimeout(leave.current);
    setOpen(i);
  };
  const hide = () => {
    if (leave.current) clearTimeout(leave.current);
    leave.current = setTimeout(() => setOpen(null), 150);
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-neutral-50 text-xs uppercase tracking-wider text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-semibold">Photo</th>
            <th className="px-3 py-2 font-semibold">Title</th>
            <th className="px-3 py-2 font-semibold">Source</th>
            <th className="px-3 py-2 font-semibold">First seen</th>
            <th className="px-3 py-2 font-semibold">Last checked</th>
            <th className="px-3 py-2 font-semibold">Beds</th>
            <th className="px-3 py-2 font-semibold">Location</th>
            <th className="px-3 py-2 font-semibold">Price</th>
            <th className="px-3 py-2 font-semibold">Listing type</th>
            <th className="px-3 py-2 font-semibold">Property type</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200">
          {listings.map((h, i) => (
            <tr
              key={`${h.url ?? h.title}-${i}`}
              tabIndex={0}
              className="cursor-pointer align-top hover:bg-neutral-50 focus:bg-neutral-50 focus:outline-none"
              onMouseEnter={() => show(i)}
              onMouseLeave={hide}
              onFocus={() => show(i)}
              onClick={() => setOpen((n) => (n === i ? null : i))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((n) => (n === i ? null : i));
                }
                if (e.key === "Escape") setOpen(null);
              }}
            >
              <td className="px-3 py-2">
                <Photo src={h.photo} alt="" className="h-14 w-20 rounded object-cover" />
              </td>
              <td className="px-3 py-2">
                {h.url ? (
                  <a
                    href={h.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-blue-700 underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {h.title}
                  </a>
                ) : (
                  <span className="font-medium">{h.title}</span>
                )}
              </td>
              <td className="px-3 py-2 text-neutral-600">{sourceLabel(h.source)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-neutral-600">{h.firstSeen ?? "—"}</td>
              <td className="whitespace-nowrap px-3 py-2 text-neutral-600">{h.lastSeen ?? "—"}</td>
              <td className="px-3 py-2">{h.beds ?? "—"}</td>
              <td className="px-3 py-2 text-neutral-600">{h.area ?? "—"}</td>
              <td className="whitespace-nowrap px-3 py-2">{moneyLabel(h.price, h.currency) ?? "—"}</td>
              <td className="px-3 py-2 text-neutral-600">{h.listingType ?? "—"}</td>
              <td className="px-3 py-2 text-neutral-600">{h.propertyClass ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open !== null && listings[open] ? <ListingCard h={listings[open]} onClose={() => setOpen(null)} onShow={() => show(open)} onHide={hide} /> : null}
    </div>
  );
}

function ListingCard({ h, onClose, onShow, onHide }: { h: CoBrokeHit; onClose: () => void; onShow: () => void; onHide: () => void }) {
  const prices = pricesOf(h);
  const priceLine = [prices.ttd, prices.usd, prices.other].filter(Boolean).join(" · ") || "—";
  return (
    <div
      className="fixed inset-x-0 bottom-6 z-20 mx-auto w-[min(28rem,calc(100%-2rem))] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl"
      onMouseEnter={onShow}
      onMouseLeave={onHide}
      onClick={(e) => e.stopPropagation()}
    >
      <Photo src={h.photo} alt="" className="h-48 w-full object-cover" />
      <div className="p-4 text-sm">
        <p className="font-semibold text-neutral-900">{h.title}</p>
        <p className="mt-2 text-base font-medium">{priceLine}</p>
        <p className="mt-1 text-neutral-600">
          {h.beds !== null ? `${h.beds} bed` : "Beds —"}
          {h.area ? ` · ${h.area}` : ""}
        </p>
        <p className="mt-1 text-neutral-500">Last change: {h.lastSeen ?? "—"}</p>
        <div className="mt-3 flex items-center justify-between gap-3">
          {h.url ? (
            <a href={h.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">
              Open listing
            </a>
          ) : (
            <span className="text-neutral-400">No listing link</span>
          )}
          <button type="button" onClick={onClose} className="text-neutral-500 hover:text-neutral-900">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Photo({ src, alt, className }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <Placeholder className={className} />;
  return (
    // Hotlinked from the source; not stored or proxied.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} loading="lazy" decoding="async" className={`bg-neutral-100 ${className ?? ""}`} onError={() => setFailed(true)} />
  );
}

function Placeholder({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center justify-center bg-neutral-100 text-neutral-400 ${className ?? ""}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 10.5 12 3l9 7.5V21H3V10.5Z" />
        <path d="M9 21v-6h6v6" />
      </svg>
    </span>
  );
}
