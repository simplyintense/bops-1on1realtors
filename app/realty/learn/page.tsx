import type { Metadata } from "next";
import { dateAst } from "@/realty/node/group-posts.ts";
import { withSearchStore } from "@/realty/node/search-store.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";
import { listOpenQuestions } from "@/realty/node/open-questions.ts";
import { PeriskopeStore } from "@/realty/node/periskope-store.ts";
import { agentFeedbackSummary } from "@/realty/flow/agent-feedback.ts";
import { FLAG_REASON_LABELS, FLAG_SOURCE_LABELS } from "@/realty/flow/flag-match.ts";
import { queueLine } from "@/realty/flow/learn-view.ts";
import { AREAS } from "@/realty/extract.ts";
import { viewer } from "../viewer";
import { QuestionForm } from "./question-form";
import { TeachForm } from "./teach-form";
import { TeachPlaceForm } from "./teach-place-form";
import { PastAnswers, type PastRow } from "./past-answers";
import { PreviewForm } from "./preview-form";
import { PAGE_SIZE, pageWindow, resolvePage, type QueryParams } from "@/realty/flow/pagination.ts";
import { PaginationBar } from "../pagination-bar";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Teach · 1on1 Realtors staff", robots: { index: false, follow: false } };

/**
 * The teach page, open to any signed-in staff member: they see the open questions, the needs-explanation queue, the CRM's flagged
 * matches and the past answers, and can test how the desk reads a sample. Only a teacher (BOPS_TEACH_EMAILS) sees the forms that teach
 * (a place, an answer, not a listing, edit and delete), and the POST, PATCH and DELETE routes check teacherAccess themselves. An answer
 * teaches the desk (saved to the shared knowledge, so it applies to future posts too) and reports what changed. Group names are never
 * shown here. For owners only (ownerAllowed): "What agents told us", the reasons agents gave for their outcomes on the lead cards.
 */
export default async function LearnPage({ searchParams }: { searchParams: Promise<QueryParams> }) {
  const { teacher, owner } = await viewer();
  const raw = await searchParams;
  const root = periskopeRoot();
  const { queue, queueWindow, past, pastWindow, flags, areas } = withSearchStore(root, (store) => {
    const q = resolvePage(raw.page, PAGE_SIZE, (offset, limit) => store.openQueue(limit, offset));
    const pastWindow = pageWindow({ page: raw.pastPage, pageSize: PAGE_SIZE, total: store.taughtCount() });
    const taught = store.taughtAreas();
    return {
      queue: q.rows,
      queueWindow: q.window,
      past: store.taught(pastWindow.pageSize, pastWindow.offset),
      pastWindow,
      flags: store.openFlags(50),
      areas: [...new Set([...AREAS, ...taught.places.map((p) => p.name)])].sort((a, b) => a.localeCompare(b)),
    };
  });
  const questions = listOpenQuestions(root);
  const told = owner ? agentFeedbackSummary(new PeriskopeStore(periskopeRoot()).matchStatuses()) : null;
  const pastRows: PastRow[] = past.map((t) => ({
    ...t,
    when: t.taughtAt ? dateAst(t.taughtAt) : "",
    means: [t.area, t.development, t.type, t.listingType].filter(Boolean).join(" · ") || t.kind,
  }));

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <p className="rt-eyebrow">{teacher ? "Teachers" : "Read only"}</p>
      <h1 className="mt-2 text-3xl font-semibold">Help the desk learn</h1>
      <p className="rt-muted mt-3">
        Posts too vague to match. Say what one means in a line. If the answer names a term, a place or a type, the desk reads that
        word the same way in every post from now on. Times are AST.
      </p>
      {teacher ? null : <p className="rt-muted mt-2 text-sm">Only teachers can answer here. You can read the queue and the answers.</p>}

      <h2 className="mt-10 text-xl font-semibold">Test how the desk reads this</h2>
      <p className="rt-muted mt-2 text-sm">Paste a place name or a sample post. Nothing is saved.</p>
      <div className="mt-4">
        <PreviewForm />
      </div>

      {teacher ? (
        <section>
          <h2 className="mt-12 text-xl font-semibold">Teach a place</h2>
          <p className="rt-muted mt-2 text-sm">A place&apos;s market, another name for it, and whether it is nearby another place. Used by every search from the next request.</p>
          <div className="mt-4">
            <TeachPlaceForm areas={areas} />
          </div>
        </section>
      ) : null}

      <h2 className="mt-10 text-xl font-semibold" data-tour="learn-questions">Open questions</h2>
      <p className="rt-muted mt-2 text-sm">
        Policy questions for the owner, not posts. An answer is recorded here and changes nothing in matching.
      </p>
      <ol className="mt-4 grid gap-4">
        {questions.map((q) => (
          <li key={q.id} className="rt-card grid gap-2 p-4">
            <p className="text-sm">{q.question}</p>
            {q.answer ? (
              <p className="text-sm">
                <span className="rt-muted">
                  Answer ({q.answeredBy ?? "teacher"}{q.answeredAt ? `, ${dateAst(q.answeredAt)}` : ""}):
                </span>{" "}
                {q.answer}
              </p>
            ) : (
              teacher ? <QuestionForm id={q.id} /> : <p className="rt-muted text-sm">No answer yet.</p>
            )}
          </li>
        ))}
      </ol>

      <h2 className="mt-12 text-xl font-semibold" data-tour="learn-queue">Open ({queueWindow.total})</h2>
      {queue.length === 0 ? <p className="rt-muted mt-3">Nothing waiting. No posts need an explanation.</p> : null}
      <ol className="mt-4 grid gap-4">
        {queue.map((r) => (
          <li key={r.id} className="rt-card grid gap-2 p-4">
            <p className="rt-muted text-xs">{queueLine(r)}</p>
            <p className="whitespace-pre-wrap text-sm">{r.originalText ?? ""}</p>
            <p className="text-sm">
              <span className="rt-muted">Best guess:</span> {r.guess}
            </p>
            {r.explanation ? (
              <p className="rt-muted text-xs">
                Answered {r.explainedAt ? dateAst(r.explainedAt) : ""}: {r.explanation}
              </p>
            ) : null}
            {teacher ? <TeachForm id={r.id} areas={areas} /> : null}
          </li>
        ))}
      </ol>
      <PaginationBar path="/realty/learn" raw={raw} window={queueWindow} />

      <h2 className="mt-12 text-xl font-semibold">Flagged from CRM</h2>
      <p className="rt-muted mt-2 text-sm">Matches the CRM showed a client that were wrong. Read only here: nothing changes matching.</p>
      {flags.length === 0 ? <p className="rt-muted mt-3">Nothing flagged.</p> : null}
      <ol className="mt-4 grid gap-3">
        {flags.map((f) => (
          <li key={f.id} className="rt-card grid gap-1 p-4 text-sm">
            <p>
              <span className="font-medium">{FLAG_REASON_LABELS[f.reason]}</span> · {FLAG_SOURCE_LABELS[f.source]} · {f.listingTitle ?? "No listing title"}
            </p>
            {f.listingLocation ? <p className="rt-muted text-xs">Listing in {f.listingLocation}</p> : null}
            {f.clientLocations.length ? <p className="rt-muted text-xs">Client looking in {f.clientLocations.join(", ")}</p> : null}
            {f.note ? <p className="whitespace-pre-wrap">{f.note}</p> : null}
            <p className="rt-muted text-xs">
              {f.reportedBy ?? "Reported by the CRM"} · {dateAst(f.flaggedAt)}
            </p>
          </li>
        ))}
      </ol>

      <h2 className="mt-12 text-xl font-semibold">Past answers</h2>
      {pastRows.length === 0 ? <p className="rt-muted mt-3">No answers yet.</p> : null}
      {pastRows.length ? (
        <>
          <PastAnswers rows={pastRows} teacher={teacher} />
          <PaginationBar path="/realty/learn" raw={raw} window={pastWindow} param="pastPage" />
        </>
      ) : null}

      {told ? (
        <section>
          <h2 className="mt-12 text-xl font-semibold">What agents told us</h2>
          <p className="rt-muted mt-2 text-sm">
            Why agents gave an outcome on a lead card. Owners only. The reasons that matter are already learned: a listing that&apos;s
            unavailable or a client who isn&apos;t interested is dropped from that match, and a wrong area lowers the nearby pairs of
            those two areas. The rest are recorded for now. Times are AST.
          </p>
          {told.total === 0 ? <p className="rt-muted mt-3">No reasons yet.</p> : null}
          {told.reasons.length ? (
            <ul className="mt-3 flex flex-wrap gap-2 text-sm">
              {told.reasons.map((r) => (
                <li key={r.reason} className="rt-chip">
                  {r.label}: {r.count}
                </li>
              ))}
            </ul>
          ) : null}
          {told.recent.length ? (
            <ol className="mt-4 grid gap-2">
              {told.recent.map((l, i) => (
                <li key={`${l.at}-${i}`} className="rt-card grid gap-1 p-3 text-sm">
                  <p>
                    <span className="font-medium">{l.outcome}</span>
                    {l.reason ? ` · ${l.reason}` : ""} · {l.title}
                  </p>
                  {l.note ? <p className="whitespace-pre-wrap">{l.note}</p> : null}
                  <p className="rt-muted text-xs">
                    {l.who ?? "Signed in"} · {dateAst(l.at)}
                  </p>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
