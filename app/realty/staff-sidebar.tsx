"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  BarChart,
  Briefcase,
  Building2,
  Cable,
  ChevronDown,
  ClipboardList,
  Home,
  ImageDown,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  MessageSquare,
  Plus,
  Search,
  Send,
  Settings,
  Shield,
  Sparkles,
  User,
  UserCog,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { CrmRole } from "./crm-role.ts";
import {
  CRM_BACK_TO_SITE,
  CRM_GROUPS_OPEN_BY_DEFAULT,
  DESK_MARKET_SEARCH,
  LOGOUT,
  crmHref,
  crmSidebar,
  isCurrentPage,
  portalHeader,
  type CrmIcon,
  type CrmItem,
} from "./sidebar-model.ts";

/**
 * The staff desk's left sidebar, copied from the 1on1 CRM's staff sidebar (UnifiedSidebar.tsx): the same header, links, order,
 * icons, groups and footer, with the same class names. The CRM's links are same-tab anchors to the CRM's domain. Market Search
 * is the desk's own link (a client link to /realty/search, with data-tour for the guided tour). The desk's other pages are not
 * in this sidebar; they stay reachable by URL. On a phone the same tree is a drawer behind a Menu bar; on md+ it is a sticky
 * column. The class names are the CRM's; the colour utilities are pinned inside .realty-theme (realty-theme.css).
 */

const ICONS: Record<CrmIcon, LucideIcon> = {
  Shield,
  LayoutDashboard,
  Search,
  Briefcase,
  Users,
  Plus,
  UsersRound,
  Home,
  Building2,
  MessageSquare,
  ListChecks,
  ClipboardList,
  Mail,
  Settings,
  UserCog,
  Send,
  BarChart,
  Activity,
  Sparkles,
  ImageDown,
  Cable,
  User,
  LogOut,
};

const LINK = "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground";
const LINK_ACTIVE = "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-sm font-medium bg-primary text-primary-foreground";
const GROUP_TRIGGER = "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-sm font-medium w-full text-muted-foreground hover:bg-muted hover:text-foreground";
const SUB_LINK = "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-sm text-muted-foreground hover:bg-muted hover:text-foreground";
const LOGOUT_LINK = "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors w-full";

export function StaffSidebar({ role }: { role: CrmRole }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(CRM_GROUPS_OPEN_BY_DEFAULT.map((label) => [label, true])),
  );
  const header = portalHeader(role);
  const side = crmSidebar(role);
  const marketCurrent = isCurrentPage(DESK_MARKET_SEARCH.href, pathname);

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
      <div className="rt-header flex justify-end px-4 py-3 md:hidden">
        <button type="button" className="rt-chip" aria-expanded={open} aria-controls="staff-sidebar" onClick={() => setOpen((v) => !v)}>
          {open ? "Close menu" : "Menu"}
        </button>
      </div>
      {open ? <div className="fixed inset-0 z-30 bg-slate-900/40 md:hidden" aria-hidden onClick={() => setOpen(false)} /> : null}
      <aside
        id="staff-sidebar"
        className={`w-64 bg-background border-r border-border flex flex-col h-screen fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:sticky md:inset-auto md:top-0 md:z-auto md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full max-md:invisible"
        }`}
      >
        <div className="p-6 border-b border-border">
          <h1 className="text-xl font-bold">{header.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{header.subtitle}</p>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto" onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}>
          {side.top.map((item) => (
            <CrmNavLink key={item.to} item={item} />
          ))}

          <Link
            href={DESK_MARKET_SEARCH.href}
            data-tour="nav-search"
            aria-current={marketCurrent ? "page" : undefined}
            className={marketCurrent ? LINK_ACTIVE : LINK}
          >
            <Search className="h-5 w-5" />
            <span>{DESK_MARKET_SEARCH.label}</span>
          </Link>

          {side.groups.map((group) => {
            const isOpen = openGroups[group.label] ?? false;
            const GroupIcon = ICONS[group.icon];
            return (
              <div key={group.label} className="space-y-1">
                <button
                  type="button"
                  className={GROUP_TRIGGER}
                  aria-expanded={isOpen}
                  onClick={() => setOpenGroups((prev) => ({ ...prev, [group.label]: !isOpen }))}
                >
                  <GroupIcon className="h-5 w-5" />
                  <span className="flex-1 text-left">{group.label}</span>
                  <ChevronDown className={`h-4 w-4 transition-transform${isOpen ? " transform rotate-180" : ""}`} />
                </button>
                {isOpen ? (
                  <div className="space-y-1 pl-4">
                    {group.items.map((item) => {
                      const ItemIcon = ICONS[item.icon];
                      return (
                        <a key={item.to} href={crmHref(item.to)} className={SUB_LINK}>
                          <ItemIcon className="h-4 w-4" />
                          <span>{item.label}</span>
                        </a>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        <div className="px-4 pb-6 space-y-2 border-t border-border pt-4">
          {side.footer.map((item) => (
            <CrmNavLink key={item.to} item={item} />
          ))}
          <CrmNavLink item={CRM_BACK_TO_SITE} />
          <a href={LOGOUT.href} className={LOGOUT_LINK}>
            <LogOut className="h-5 w-5" />
            <span>{LOGOUT.label}</span>
          </a>
        </div>
      </aside>
    </>
  );
}

/** A top or footer link: a same-tab anchor to the CRM, with the CRM's icon size and classes. */
function CrmNavLink({ item }: { item: CrmItem }) {
  const Icon = ICONS[item.icon];
  return (
    <a href={crmHref(item.to)} className={LINK}>
      <Icon className="h-5 w-5" />
      <span>{item.label}</span>
    </a>
  );
}
