import type { Metadata } from "next";
import { dateAst } from "@/realty/node/group-posts.ts";
import { withSearchStore } from "@/realty/node/search-store.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";
import { listOpenQuestions } from "@/realty/node/open-questions.ts";
import { PeriskopeStore } from "@/realty/node/periskope-store.ts";
import { agentFeedbackSummary } from "@/realty/flow/agent-feedback.ts";
import { viewer } from "../viewer";
import { QuestionForm } from "./question-form";
import { TeachForm } from "./teach-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Teach · 1on1 Realtors staff", robots: { index: false, follow: false } };

/**
 * The teach page, open to any signed-in staff member: they see the open questions, the needs-explanation queue and the past
 * answers. Only a teacher (BOPS_TEACH_EMAILS) sees the answer forms, and the POST routes check teacherAccess themselves. An
 * answer teaches Bops (saved to the shared knowledge, so it applies to future posts too) and reports what changed. For owners
 * only (ownerAllowed): "What agents told us", the reasons agents gave for their outcomes on the lead cards.
 */
export default async function LearnPage() {
  const { teacher, owner } = await viewer();
  const { queue, past } = withSearchStore(periskopeRoot(), (store) => ({ queue: store.openQueue(200), past: store.taught(100) }));
  const questions = listOpenQuestions(periskopeRoot());
  const told = owner ? agentFeedbackSummary(new PeriskopeStore(periskopeRoot()).matchStatuses()) : null;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <p className="rt-eyebrow">{teacher ? "Teachers" : "Read only"}</p>
      <h1 className="mt-2 text-3xl font-semibold">Help the desk learn</h1>
      <p className="rt-muted mt-3">
        Posts too vague to match. Say what one means in a line. If the answer names a term, a place or a type, the desk reads that
        word the same way in every post from now on. Times are AST.
      </p>
      {teacher ? null : <p className="rt-muted mt-2 text-sm">Only teachers can answer here. You can read the queue and the answers.</p>}

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

      <h2 className="mt-12 text-xl font-semibold" data-tour="learn-queue">Open ({queue.total})</h2>
      {queue.rows.length === 0 ? <p className="rt-muted mt-3">Nothing waiting. No posts need an explanation.</p> : null}
      <ol className="mt-4 grid gap-4">
        {queue.rows.map((r) => (
          <li key={r.id} className="rt-card grid gap-2 p-4">
            <p className="rt-muted text-xs">
              {dateAst(r.lastSentAt)} · {r.groups.join(", ") || "No group"} · {r.senderName ?? "Unnamed sender"} · ×{r.timesSeen}
            </p>
            <p className="whitespace-pre-wrap text-sm">{r.originalText ?? ""}</p>
            <p className="text-sm">
              <span className="rt-muted">Best guess:</span> {r.guess}
            </p>
            {r.explanation ? (
              <p className="rt-muted text-xs">
                Answered {r.explainedAt ? dateAst(r.explainedAt) : ""}: {r.explanation}
              </p>
            ) : null}
            {teacher ? <TeachForm id={r.id} /> : null}
          </li>
        ))}
      </ol>

      <h2 className="mt-12 text-xl font-semibold">Past answers</h2>
      {past.length === 0 ? <p className="rt-muted mt-3">No answers yet.</p> : null}
      {past.length ? (
        <div className="rt-table-wrap mt-3">
          <table className="w-full text-sm">
            <thead className="rt-thead text-left">
              <tr>
                <th className="px-2 py-2">When (AST)</th>
                <th className="px-2 py-2">By</th>
                <th className="px-2 py-2">Term</th>
                <th className="px-2 py-2">Means</th>
                <th className="px-2 py-2">Answer</th>
              </tr>
            </thead>
            <tbody>
              {past.map((t, i) => (
                <tr key={`${t.taughtAt}-${i}`} className="rt-row align-top">
                  <td className="px-2 py-2 whitespace-nowrap">{t.taughtAt ? dateAst(t.taughtAt) : ""}</td>
                  <td className="px-2 py-2">{t.taughtBy ?? ""}</td>
                  <td className="px-2 py-2">{t.term ?? ""}</td>
                  <td className="px-2 py-2">{[t.area, t.development, t.type, t.listingType].filter(Boolean).join(" · ") || t.kind}</td>
                  <td className="px-2 py-2">{t.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
