"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { CRM_LOGO, LOGO_FALLBACK, sidebarModel } from "./sidebar-model.ts";

/**
 * The staff desk's left sidebar, in the 1on1 CRM's look: the logo, the desk's pages (Market Search is the active one on
 * /realty/search and a stored post), the CRM's agent pages, and the footer (the Start tour button). One tree for every width:
 * on a desktop it's a fixed-width column beside the page; on a phone it's a drawer behind a top bar's Menu button. One tree
 * means each data-tour hook (the guided tour) exists once. The CRM links are same-tab anchors; the desk's links are client links.
 */
export function StaffSidebar({ owner, teacher, footer }: { owner: boolean; teacher: boolean; footer?: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const model = sidebarModel({ owner, teacher }, pathname);

  // Escape closes the phone drawer. Only listens while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div className="rt-side-top flex items-center justify-between gap-3 px-4 py-3 md:hidden">
        <Logo />
        <button
          type="button"
          className="rt-chip"
          aria-expanded={open}
          aria-controls="staff-sidebar"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Close menu" : "Menu"}
        </button>
      </div>
      {open ? <div className="fixed inset-0 z-30 bg-slate-900/40 md:hidden" aria-hidden onClick={() => setOpen(false)} /> : null}
      <aside
        id="staff-sidebar"
        className={`rt-side fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col overflow-y-auto transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full max-md:invisible"
        }`}
      >
        <div className="rt-side-divider border-b px-5 py-5">
          <Logo />
        </div>
        <nav aria-label="Staff" className="flex-1 space-y-1 p-3" onClick={() => setOpen(false)}>
          <p className="rt-eyebrow px-3 pb-1 pt-2">Staff desk</p>
          {model.staff.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={link.current ? "page" : undefined}
              data-tour={link.tourId}
              className="rt-side-link"
            >
              {link.label}
            </Link>
          ))}
          <p className="rt-eyebrow px-3 pb-1 pt-4">Agent portal</p>
          {model.crm.map((link) => (
            <a key={link.key} href={link.href} className="rt-side-link">
              {link.label}
            </a>
          ))}
        </nav>
        {footer ? <div className="rt-side-divider border-t p-3">{footer}</div> : null}
      </aside>
    </>
  );
}

/** The 1on1 Realtors logo from the public site; a local copy only if that one doesn't load. */
function Logo() {
  const [src, setSrc] = useState(CRM_LOGO);
  return (
    <Link href="/realty/desk" aria-label="1on1 Realtors staff desk" className="inline-block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="1on1 Realtors"
        className="h-10 w-auto"
        onError={() => setSrc((current) => (current === LOGO_FALLBACK ? current : LOGO_FALLBACK))}
      />
    </Link>
  );
}
