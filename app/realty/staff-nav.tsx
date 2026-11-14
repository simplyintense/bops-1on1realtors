import Link from "next/link";

const PAGES = [
  { id: "desk", href: "/realty/desk", label: "Desk" },
  { id: "market", href: "/realty/market", label: "Market search" },
] as const;

/** The staff pages' shared nav. `current` marks the page being shown. The Bops chat app is at /. */
export function StaffNav({ current }: { current: (typeof PAGES)[number]["id"] }) {
  return (
    <nav aria-label="Staff" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-neutral-200 pb-3 text-sm">
      {PAGES.map((p) => (
        <Link
          key={p.id}
          href={p.href}
          aria-current={p.id === current ? "page" : undefined}
          className={p.id === current ? "font-semibold text-neutral-900" : "text-neutral-600 hover:text-neutral-900"}
        >
          {p.label}
        </Link>
      ))}
      <Link href="/" className="ml-auto text-neutral-500 hover:text-neutral-900">
        Back to Bops
      </Link>
    </nav>
  );
}
