"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isCurrentPage } from "./sidebar-model.ts";
import { navTourId, visibleStaffPages } from "./staff-pages";

/**
 * The staff desk's top nav, for the Bops chat app at / (app/page.tsx) only: a signed-in staff member sees the desk's pages above
 * the chat. The /realty/* pages use the left sidebar instead (staff-sidebar.tsx), which reads the same list (staff-pages.ts).
 * The entries are listed only for the viewer's owner and teacher flags (read on the server).
 */
export function StaffNav({ owner, teacher }: { owner: boolean; teacher: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Staff" className="rt-nav">
      {visibleStaffPages({ owner, teacher }).map((p) => {
        const current = isCurrentPage(p.href, pathname);
        return (
          <Link key={p.href} href={p.href} aria-current={current ? "page" : undefined} data-tour={navTourId(p.href)}>
            {p.label}
          </Link>
        );
      })}
    </nav>
  );
}
