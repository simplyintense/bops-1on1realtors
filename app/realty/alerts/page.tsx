import type { Metadata } from "next";
import { loadAutoMatchAlerts } from "@/realty/node/automatch-alert.ts";
import { ALERT_NAME } from "@/realty/flow/automatch-alert.ts";
import { Notice } from "../notice";
import { viewer } from "../viewer";
import { TestSendButton } from "./test-send-button";
import { CARD_PAGE_SIZE, pageWindow, slicePage, type QueryParams } from "@/realty/flow/pagination.ts";
import { PaginationBar } from "../pagination-bar";

/**
 * Auto-Match Alert preview, for any signed-in staff member: one email per strong match (75 and above) as it would go to the
 * holding agent, with Crystal and Wendy on CC. A BCC is set and is not shown in the preview below, which is the message the agent
 * would see. Live sending stays off until AUTOMATCH_ALERT_ENABLED is on. Only an owner gets the test button: it sends one [TEST]
 * alert to miles@simplyintense.com only, with no CC or BCC, even while that flag is off.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Auto-Match Alert · 1on1 Realtors", robots: { index: false, follow: false } };

export default async function AutoMatchAlertPage({ searchParams }: { searchParams: Promise<QueryParams> }) {
  const { owner } = await viewer();
  const raw = await searchParams;
  const loaded = await loadAutoMatchAlerts().catch(() => null);
  const alertWindow = loaded ? pageWindow({ page: raw.page, pageSize: CARD_PAGE_SIZE, total: loaded.alerts.length }) : null;
  const alerts = loaded && alertWindow ? slicePage(loaded.alerts, alertWindow) : [];
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <p className="rt-eyebrow">Read only</p>
      <h1 className="mt-2 text-3xl font-semibold">{ALERT_NAME}</h1>
      <p className="rt-muted mt-3">
        One email per strong match, addressed to the agent who holds the listing. Live sending stays off until
        AUTOMATCH_ALERT_ENABLED is on.
        {owner ? " You can still send one [TEST] alert to miles@simplyintense.com (no CC or BCC) from this page." : null}
      </p>
      {!loaded ? (
        <div className="mt-6">
          <Notice tone="error">The preview couldn&apos;t load right now.</Notice>
        </div>
      ) : (
        <>
          <p className="rt-muted mt-4 text-sm" data-tour="alerts-summary">
            {loaded.alerts.length} match{loaded.alerts.length === 1 ? "" : "es"} · would send {loaded.plan.send.length} ·
            hold {loaded.plan.suppress.length} as the baseline · already recorded {loaded.plan.skip.length}. On flip,{" "}
            {loaded.flip.wouldSendImmediately} would go immediately. Enabled: {loaded.enabled ? "yes" : "no"}. Transport:{" "}
            {loaded.hasTransport ? "yes" : "no"}.
          </p>
          {owner ? <TestSendButton /> : null}
          {alerts.length && alertWindow ? (
            <>
            <ol className="mt-8 grid gap-8" data-tour="alerts-emails">
              {alerts.map((a) => (
                <li key={`${a.requestId}-${a.listingKey}`} className="rt-card grid gap-3 p-4">
                  <p className="text-sm">
                    <strong>To:</strong> {a.toName} &lt;{a.to}&gt;
                  </p>
                  <p className="text-sm">
                    <strong>Cc:</strong> {a.cc.join(", ")}
                  </p>
                  <p className="text-sm">
                    <strong>From:</strong> {a.from}
                  </p>
                  <p className="text-sm">
                    <strong>Subject:</strong> {a.subject}
                  </p>
                  <iframe title={a.subject} srcDoc={a.html} sandbox="" className="mt-2 h-[32rem] w-full rounded border-0 bg-white" />
                </li>
              ))}
            </ol>
            <PaginationBar path="/realty/alerts" raw={raw} window={alertWindow} />
            </>
          ) : (
            <div className="mt-6">
              <Notice>No new strong matches to preview.</Notice>
            </div>
          )}
        </>
      )}
    </main>
  );
}
