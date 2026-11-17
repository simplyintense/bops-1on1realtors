import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loadAutoMatchAlerts } from "@/realty/node/automatch-alert.ts";
import { ALERT_NAME } from "@/realty/flow/automatch-alert.ts";
import { Notice } from "../notice";
import { viewer } from "../viewer";
import { TestSendButton } from "./test-send-button";

/**
 * Owners' Auto-Match Alert preview: one email per strong match (75 and above) as it would go to the holding agent, with
 * Crystal and Wendy on CC. A BCC is set and is not shown in the preview below, which is the message the agent would see.
 * Owners only. Live sending stays off until AUTOMATCH_ALERT_ENABLED is on. The test button sends one [TEST] alert to
 * miles@simplyintense.com only, with no CC or BCC, even while that flag is off.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Auto-Match Alert · 1on1 Realtors", robots: { index: false, follow: false } };

export default async function AutoMatchAlertPage() {
  const { email, owner } = await viewer();
  if (!owner) redirect("/realty/desk");
  const loaded = await loadAutoMatchAlerts().catch(() => null);
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <p className="rt-eyebrow">Owners only</p>
      <h1 className="mt-2 text-3xl font-semibold">{ALERT_NAME}</h1>
      <p className="rt-muted mt-3">
        One email per strong match, addressed to the agent who holds the listing. Live sending stays off until
        AUTOMATCH_ALERT_ENABLED is on. You can still send one [TEST] alert to miles@simplyintense.com (no CC or BCC)
        from this page.
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
          <TestSendButton />
          {loaded.alerts.length ? (
            <ol className="mt-8 grid gap-8" data-tour="alerts-emails">
              {loaded.alerts.map((a) => (
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
