"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PAGES = [
  { href: "/realty/desk", label: "Desk", ownerOnly: false, teacherOnly: false },
  { href: "/realty/market", label: "Market search", ownerOnly: false, teacherOnly: false },
  { href: "/realty/requests", label: "Requests", ownerOnly: true, teacherOnly: false },
  { href: "/realty/posts", label: "Group posts", ownerOnly: true, teacherOnly: false },
  { href: "/realty/search", label: "Search", ownerOnly: true, teacherOnly: false },
  { href: "/realty/digest", label: "Digest", ownerOnly: true, teacherOnly: false },
  { href: "/realty/learn", label: "Teach Bops", ownerOnly: false, teacherOnly: true },
] as const;

/**
 * The staff pages' shared nav, in the realty layout's header. The page being shown is marked from the path. The owners'
 * pages are listed only when `owner` is set, and the teach page only when `teacher` is (the layout reads both on the server).
 * The Bops chat app is at /, so "Back to Bops" goes there.
 */
export function StaffNav({ owner, teacher }: { owner: boolean; teacher: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Staff" className="rt-nav">
      {PAGES.filter((p) => (owner || !p.ownerOnly) && (teacher || !p.teacherOnly)).map((p) => {
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
