import { answerOpenQuestion, OpenQuestionError, UnknownQuestionError } from "@/realty/node/open-questions.ts";
import { staffEmail, teacherAccess } from "@/realty/node/periskope-intake.ts";
import { periskopeRoot } from "@/realty/node/periskope-root.ts";

export const dynamic = "force-dynamic";

/**
 * Teachers only (BOPS_TEACH_EMAILS; anyone else gets a 404). Records the answer to one of the two open policy questions on
 * Teach Bops. Recording only: it does not change matching, areas or the knowledge store. Last answer wins.
 *   POST { id, answer }
 *     → 200 { id, question, answer, answeredBy, answeredAt }
 *     → 400 { error } bad input · 404 { error } not a teacher, or not an open question
 */
export async function POST(request: Request) {
  const denied = await teacherAccess(request);
  if (denied) return Response.json(denied.body, { status: denied.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send a JSON object." }, { status: 400 });
  }
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return Response.json({ error: "Send the question id." }, { status: 400 });
  const answer = typeof o.answer === "string" ? o.answer : "";
  const by = (await staffEmail(request)) ?? "teacher";
  try {
    return Response.json(answerOpenQuestion(periskopeRoot(), o.id, answer, by));
  } catch (e) {
    if (e instanceof OpenQuestionError) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof UnknownQuestionError) return Response.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
