import Link from "next/link";
import { Inter, Playfair_Display } from "next/font/google";
import type { ReactNode } from "react";
import "./realty-theme.css";
import { StaffNav } from "./staff-nav";

/**
 * The staff pages' layout (/realty/*): the 1on1 Realtors theme (realty-theme.css, scoped to .realty-theme), Inter for the UI and
 * Playfair Display for headings (the live site's fonts), then a header with the logo and the staff nav, then the page. The Bops
 * chat app at / is not themed. The public demo at /realty-demo is outside this layout.
 */

const inter = Inter({ subsets: ["latin"], variable: "--font-realty-sans", display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], variable: "--font-realty-serif", display: "swap" });

export default function RealtyLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`realty-theme flex min-h-full flex-col ${inter.variable} ${playfair.variable}`}>
      <header className="rt-header">
        <div className="rt-header-inner">
          <Link href="/realty/desk" aria-label="1on1 Realtors staff desk">
            {/* A static file in public/, as the pages have always shown it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/realty/1on1-realtors-logo.png" alt="1on1 Realtors" className="h-10 w-auto" />
          </Link>
          <StaffNav />
        </div>
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
