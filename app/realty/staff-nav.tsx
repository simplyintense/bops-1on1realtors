"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { visibleStaffPages } from "./staff-pages";

/**
 * The staff pages' shared nav, in the realty layout's header. The page being shown is marked from the path. The entries
 * (staff-pages.ts) are listed only for the viewer's owner and teacher flags (the layout reads both on the server).
 * The Bops chat app is at /, so "Back to Bops" goes there.
 */
export function StaffNav({ owner, teacher }: { owner: boolean; teacher: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Staff" className="rt-nav">
      {visibleStaffPages({ owner, teacher }).map((p) => {
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
