import type { Metadata } from "next";
import { REALTY_TEAM } from "@/lib/realty-team";
import fixture from "@/realty/fixtures/crm.json";
import { runDemoDay } from "@/realty/flow/demo-day.ts";
import { timeoutMsFromEnv } from "@/realty/flow/flow.ts";
import { localClock, localTime } from "@/realty/flow/messages.ts";
import { FixtureCrm } from "@/realty/flow/source.ts";

/**
 * The 1on1 Realtors demo (the public Vercel demo shows only this page; lib/gate.ts publicDemo). It runs
 * the lead flow's simulated day (realty/flow/demo-day.ts) on the fixture CRM, made-up people only, on
 * each visit, in memory. Nothing is sent and nothing is written: the outbox has no transport and no file
 * here, and market search is off (no outside calls).
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "1on1 Realtors · Bops demo", robots: { index: false, follow: false } };

const KIND: Record<string, string> = {
  client_ack: "Client acknowledgement",
  agent_alert: "Agent alert",
  backup_alert: "Backup agent alert",
  admin_exception: "Admin exception",
  daily_report: "Daily report",
  client_match: "Approved listings for the client",
  weekly_report: "Weekly report",
};

export default async function RealtyDemo() {
  const timeoutMs = timeoutMsFromEnv();
  const day = await runDemoDay({ crm: new FixtureCrm(fixture as unknown as ConstructorParameters<typeof FixtureCrm>[0]), timeoutMs, market: null });
  const { report } = day;

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-10 text-neutral-900">
      <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">Demo · dry run · made-up data · nothing is sent</p>
      <h1 className="mt-2 text-3xl font-semibold">1on1 Realtors: bot team and lead flow</h1>
      <p className="mt-3 text-neutral-600">
        A simulated day (Thu 12 Nov 2026, Port of Spain time) run against a fixture CRM of fictional agents, listings and clients (555 numbers,
        example.com emails). Every new inquiry is acknowledged at once, routed to one agent with a {timeoutMs / 60_000}-minute answer window, then one
        backup, then an admin exception. Below is every message the flow would send. None of them leaves this page.
      </p>

      <h2 className="mt-10 text-xl font-semibold">The bot team</h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {REALTY_TEAM.map((b) => (
          <li key={b.id} className="rounded-lg border border-neutral-200 p-4">
            <div className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-full" style={{ background: b.color }} />
              <span className="font-semibold">{b.name}</span>
              {b.isMain ? <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">Lead</span> : null}
            </div>
            <p className="mt-1 text-sm text-neutral-600">{b.role}</p>
          </li>
        ))}
      </ul>

      <h2 className="mt-10 text-xl font-semibold">The day, step by step</h2>
      <ol className="mt-4 space-y-3">
        {day.steps.map((s, i) => (
          <li key={i} className="rounded-lg border border-neutral-200 p-4">
            <p>
              <span className="font-mono text-sm text-neutral-500">{localClock(s.at.toISOString())}</span> {s.text}
            </p>
            {s.leads.map((l) => (
              <p key={l.id} className="mt-1 font-mono text-xs text-neutral-600">
                {l.id}: {l.state}
                {l.exception ? ` (${l.exception})` : ""}
              </p>
            ))}
          </li>
        ))}
      </ol>

      <h2 className="mt-10 text-xl font-semibold">Outbox: {day.messages.length} messages, none sent</h2>
      <div className="mt-4 space-y-4">
        {day.messages.map((m) => (
          <article key={m.id} className="rounded-lg border border-neutral-200">
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm">
              <span className="font-semibold">
                #{m.id} {KIND[m.kind] ?? m.kind}
              </span>
              <span className="text-neutral-600">
                {m.channel} → {m.to.name} &lt;{m.to.address}&gt;
              </span>
              <span className="ml-auto font-mono text-xs text-neutral-500">
                {localTime(m.at)}
                {m.leadId ? ` · ${m.leadId}` : ""}
              </span>
            </header>
            {m.subject ? <p className="px-4 pt-3 text-sm font-semibold">Subject: {m.subject}</p> : null}
            <pre className="whitespace-pre-wrap px-4 py-3 font-sans text-sm leading-relaxed">{m.text}</pre>
          </article>
        ))}
      </div>

      <h2 className="mt-10 text-xl font-semibold">End of day</h2>
      <p className="mt-2 text-neutral-700">
        {report.totals.leads} leads · {report.totals.accepted} accepted · {report.totals.exceptions} admin exceptions · {report.totals.open} still open
      </p>

      <p className="mt-12 border-t border-neutral-200 pt-4 text-xs text-neutral-500">
        Bops for 1on1 Realtors · demo build. No CRM, email, WhatsApp or SMS is connected. Co-broke matches from other agencies are off in this demo.
      </p>
    </main>
  );
}
