import { BopsApp } from "@/components/app/bops-app";
import "./realty/realty-theme.css";
import { StaffNav } from "./realty/staff-nav";
import { viewer } from "./realty/viewer";

/**
 * The Bops chat app at /. A signed-in staff member gets the staff nav above it, the same nav as /realty/* (staff-pages.ts, where
 * "Bops home" is this page). Signed out, or with the login gate off (the Mac app), it's the app as it was: no header, no change.
 * The realty theme's classes are scoped to the header only, so the chat app itself isn't restyled.
 */
export default async function Home() {
  const { email, owner, teacher } = await viewer();
  if (!email) {
    return (
      <div className="h-screen">
        <BopsApp />
      </div>
    );
  }
  return (
    <div className="flex h-screen flex-col">
      <div className="realty-theme">
        <header className="rt-header">
          <div className="rt-header-inner">
            <StaffNav owner={owner} teacher={teacher} />
          </div>
        </header>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <BopsApp staff={!owner} />
      </div>
    </div>
  );
}
