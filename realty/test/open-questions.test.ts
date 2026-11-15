import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GATE_COOKIE, gateConfig, makeSession, teachAllowed } from "../../lib/gate.ts";
import { answerOpenQuestion, listOpenQuestions, OpenQuestionError, SEEDED_QUESTIONS, UnknownQuestionError } from "../node/open-questions.ts";
import { teacherAccess } from "../node/periskope-intake.ts";
import { withSearchStore } from "../node/search-store.ts";

/**
 * The two open policy questions on Teach Bops. They are not posts: nothing here reaches the needs-explanation queue,
 * the knowledge store or matching. Invented addresses only. Last answer wins on re-answer (see answerOpenQuestion).
 */

const CENTRAL = "central-locations-maraval";
const NEARBY = "nearby-rule-15-min-same-market";
const TEACHER = "teacher@1on1.example";
const AGENT = "agent@1on1.example";
const AT = new Date("2026-11-14T12:00:00.000Z");

/** A fresh root under its own 0700 directory (mkdtemp's own directory would hide the mode). */
function freshRoot(): string {
  return join(mkdtempSync(join(tmpdir(), "open-questions-")), "periskope");
}

test("listing a fresh root seeds exactly the two questions, unanswered, and they are not in the post queue", () => {
  const root = freshRoot();
  const list = listOpenQuestions(root);
  assert.deepEqual(
    list.map((q) => q.id),
    [CENTRAL, NEARBY],
  );
  for (const q of list) {
    assert.equal(q.answer, null);
    assert.equal(q.answeredBy, null);
    assert.equal(q.answeredAt, null);
  }
  assert.match(list[0].question, /^Should 'Central locations' include Maraval\?/);
  assert.match(list[1].question, /^Is 'nearby' right as about 15 minutes' drive AND same market\?/);
  assert.deepEqual(readdirSync(root).sort(), ["open-questions.json"]);

  const queue = withSearchStore(root, (store) => store.openQueue(50));
  assert.equal(queue.total, 0, "the needs-explanation queue has no open questions in it");
  assert.equal(queue.rows.length, 0);
});

test("answering one records the text, the teacher and the time; the other stays open; a second list keeps the answer and seeds nothing new", () => {
  const root = freshRoot();
  listOpenQuestions(root);
  const saved = answerOpenQuestion(root, CENTRAL, "  No, Maraval is not central.  ", TEACHER, AT);
  assert.equal(saved.id, CENTRAL);
  assert.equal(saved.answer, "No, Maraval is not central.", "trimmed");
  assert.equal(saved.answeredBy, TEACHER);
  assert.equal(saved.answeredAt, AT.toISOString());

  const again = listOpenQuestions(root);
  assert.equal(again.length, 2, "no duplicate seeds");
  const central = again.find((q) => q.id === CENTRAL)!;
  assert.equal(central.answer, "No, Maraval is not central.");
  assert.equal(central.answeredBy, TEACHER);
  assert.equal(central.answeredAt, AT.toISOString());
  const nearby = again.find((q) => q.id === NEARBY)!;
  assert.equal(nearby.answer, null, "the other question stays open");
});

test("answering records only this store: no search database and no knowledge side effect", () => {
  const root = freshRoot();
  answerOpenQuestion(root, NEARBY, "Yes, 15 minutes and the same market.", TEACHER, AT);
  assert.deepEqual(readdirSync(root).sort(), ["open-questions.json"], "no search.db, no knowledge rows");
});

test("re-answering: the last answer wins, with its own teacher and time", () => {
  const root = freshRoot();
  answerOpenQuestion(root, CENTRAL, "Yes, include it.", TEACHER, AT);
  const later = new Date("2026-11-15T09:00:00.000Z");
  answerOpenQuestion(root, CENTRAL, "No, correcting my earlier answer.", AGENT, later);
  const central = listOpenQuestions(root).find((q) => q.id === CENTRAL)!;
  assert.equal(central.answer, "No, correcting my earlier answer.");
  assert.equal(central.answeredBy, AGENT);
  assert.equal(central.answeredAt, later.toISOString());
});

test("bad input: an unknown id is UnknownQuestionError; an empty or over-long answer is OpenQuestionError; nothing is written", () => {
  const root = freshRoot();
  assert.throws(() => answerOpenQuestion(root, "not-a-question", "anything", TEACHER, AT), UnknownQuestionError);
  assert.throws(() => answerOpenQuestion(root, CENTRAL, "   ", TEACHER, AT), OpenQuestionError);
  assert.throws(() => answerOpenQuestion(root, CENTRAL, "x".repeat(301), TEACHER, AT), OpenQuestionError);
  assert.equal(listOpenQuestions(root).find((q) => q.id === CENTRAL)!.answer, null);
});

test("the store is 0700 for its directory and 0600 for its file", () => {
  const root = freshRoot();
  answerOpenQuestion(root, CENTRAL, "Noted.", TEACHER, AT);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, "open-questions.json")).mode & 0o777, 0o600);
  assert.deepEqual(
    SEEDED_QUESTIONS.map((q) => q.id),
    [CENTRAL, NEARBY],
    "the seeded ids are stable",
  );
});

/* The answer route is teacher-only through teacherAccess, the same gate as the teach route (see teach-gate.test.ts). */
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example" };
const WITH_TEACHERS = { ...GATE, BOPS_TEACH_EMAILS: TEACHER };
const cfg = gateConfig(GATE);
if (!cfg || cfg === "misconfigured") throw new Error("test config");

test("the answer route's gate: a teacher passes; a signed-in staff member gets 404; signed out gets 401", async () => {
  assert.equal(teachAllowed(TEACHER, WITH_TEACHERS), true);
  const req = async (email: string | null) =>
    new Request("https://bops.example/api/realty/learn/questions", { method: "POST", headers: email ? { cookie: `${GATE_COOKIE}=${await makeSession(email, cfg)}` } : {} });
  assert.equal(await teacherAccess(await req(TEACHER), WITH_TEACHERS), null);
  assert.equal((await teacherAccess(await req(AGENT), WITH_TEACHERS))?.status, 404);
  assert.equal((await teacherAccess(await req(null), WITH_TEACHERS))?.status, 401);
});
