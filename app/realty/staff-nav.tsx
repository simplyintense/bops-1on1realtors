"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PAGES = [
  { href: "/realty/desk", label: "Desk" },
  { href: "/realty/market", label: "Market search" },
  { href: "/realty/requests", label: "Requests" },
] as const;

/**
 * The staff pages' shared nav, in the realty layout's header. The page being shown is marked from the path. The Bops chat
 * app is at /, so "Back to Bops" goes there.
 */
export function StaffNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Staff" className="rt-nav">
      {PAGES.map((p) => {
        const current = pathname === p.href || pathname.startsWith(`${p.href}/`);
        return (
          <Link key={p.href} href={p.href} aria-current={current ? "page" : undefined}>
            {p.label}
          </Link>
        );
      })}
      <Link href="/" className="rt-back">
        Back to Bops
      </Link>
    </nav>
  );
}
