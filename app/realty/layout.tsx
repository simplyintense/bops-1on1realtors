import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import "./realty-theme.css";
import { DeskTourProvider, StartTourButton } from "./desk-tour";
import { StaffSidebar } from "./staff-sidebar";
import { crmRole } from "./crm-role.ts";
import { shouldAutoStart } from "./tour-steps";
import { viewer } from "./viewer";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";
import { hasSeenTour } from "@/realty/node/tour-seen.ts";

/**
 * The staff pages' layout (/realty/*): the 1on1 Realtors theme (realty-theme.css, scoped to .realty-theme) in Inter, the CRM's
 * own font, then the left sidebar (staff-sidebar.tsx, matching UnifiedSidebar.tsx on 1on1realtors.com) beside the page. The
 * shell follows the CRM's AdminLayout: min-h-screen, muted page background, and a bg-background header bar (px-6 py-4) with
 * Start tour on the right, outside the sidebar. The chat app at / is not themed (its own header is staff-nav.tsx). The public
 * demo at /realty-demo is outside this layout.
 */

const inter = Inter({ subsets: ["latin"], variable: "--font-realty-sans", display: "swap" });

export default async function RealtyLayout({ children }: { children: ReactNode }) {
  const { email, owner, teacher } = await viewer();
  // Seen on the server for a signed-in viewer; with no email (gate off) the client checks its own localStorage flag.
  const seen = email ? hasSeenTour(email, periskopeRoot()) : false;
  return (
    <div className={`realty-theme flex min-h-screen flex-col md:flex-row bg-muted/30 ${inter.variable}`}>
      {/* Inside the theme's div so the tour's overlay gets the theme's colours and fonts. */}
      <DeskTourProvider owner={owner} teacher={teacher} signedIn={email !== null} autoStart={shouldAutoStart(seen)}>
        <StaffSidebar role={crmRole({ email, owner })} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="bg-background border-b border-border px-6 py-4 flex justify-end">
            <StartTourButton />
          </header>
          <div className="flex-1">{children}</div>
        </div>
      </DeskTourProvider>
    </div>
  );
}
