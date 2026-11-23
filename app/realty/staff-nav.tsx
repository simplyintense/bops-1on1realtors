"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navTourId, visibleStaffPages } from "./staff-pages";

/**
 * The staff pages' one top nav: in the realty layout's header, and in the header of the Bops chat app at / for a signed-in staff
 * member. The page being shown is marked from the path. The entries (staff-pages.ts) are listed only for the viewer's owner and
 * teacher flags (read on the server). "Bops home" (/) is one of them, not a one-off link. An external entry (the public site)
 * opens in a new tab.
 */
export function StaffNav({ owner, teacher }: { owner: boolean; teacher: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Staff" className="rt-nav">
      {visibleStaffPages({ owner, teacher }).map((p) => {
        if (p.external) {
          return (
            <a key={p.href} href={p.href} target="_blank" rel="noopener noreferrer" data-tour={navTourId(p.href)}>
              {p.label}
            </a>
          );
        }
        const current = pathname === p.href || pathname.startsWith(`${p.href}/`);
        return (
          <Link key={p.href} href={p.href} aria-current={current ? "page" : undefined} data-tour={navTourId(p.href)}>
            {p.label}
          </Link>
        );
      })}
    </nav>
  );
}
