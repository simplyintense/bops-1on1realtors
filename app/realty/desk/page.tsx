import type { Metadata } from "next";
import Link from "next/link";
import { StaffNav } from "../staff-nav";

/**
 * The staff desk landing (signed-in staff only: the login gate covers every page, and the public demo redirects it).
 * Thin for now: the lead flow has no Next desk UI yet. Links to the read-only market search.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Staff desk · 1on1 Realtors", robots: { index: false, follow: false } };

export default function RealtyDesk() {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-10 text-neutral-900">
      <StaffNav current="desk" />
      <p className="mt-8 text-xs font-semibold uppercase tracking-wider text-amber-700">Staff only</p>
      <h1 className="mt-2 text-3xl font-semibold">1on1 Realtors staff desk</h1>
      <p className="mt-3 text-neutral-600">Tools for the 1on1 Realtors team. Nothing on these pages sends a message or writes to the CRM.</p>

      <ul className="mt-8 grid gap-3 sm:grid-cols-2">
        <li>
          <Link href="/realty/market" className="block rounded-lg border border-neutral-200 p-4 hover:bg-neutral-50">
            <span className="font-semibold">Market search</span>
            <p className="mt-1 text-sm text-neutral-600">Other agencies&apos; listings for an area, with filters. Read-only.</p>
          </Link>
        </li>
      </ul>
    </main>
  );
}
