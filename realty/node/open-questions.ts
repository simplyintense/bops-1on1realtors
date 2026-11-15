import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Owner and teacher policy questions on Teach Bops (/realty/learn). Not posts, and not the needs-explanation queue:
 * nothing here enters search.db, the knowledge store or auto-teach matching. Recording an answer is the whole effect.
 * The wording lives in this file; the store keeps only each question's answer, who gave it and when, in
 * open-questions.json under the intake root (0600, in a 0700 directory, replaced by rename).
 */

export type OpenQuestion = {
  id: string;
  question: string;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
};

/** The two seeded questions. Ids are stable: an answer is kept under its id, so the wording can be tidied without losing it. */
export const SEEDED_QUESTIONS: readonly { id: string; question: string }[] = [
  {
    id: "central-locations-maraval",
    question:
      "Should 'Central locations' include Maraval? Right now Bops counts Maraval as central Port of Spain for asks that say 'central locations', which matched a buyer to a Frederick Street commercial building.",
  },
  {
    id: "nearby-rule-15-min-same-market",
    question:
      "Is 'nearby' right as about 15 minutes' drive AND same market? Bops counts Maraval as part of Diego Martin (North West), so Maraval isn't near Woodbrook or St. Clair even though the drive is about 7 minutes.",
  },
];

const FILE = "open-questions.json";
const MAX_ANSWER = 300;

/** Bad input (empty or too long answer). The route turns it into a 400. */
export class OpenQuestionError extends Error {}
/** No seeded question has that id. The route turns it into a 404. */
export class UnknownQuestionError extends Error {}

type Row = { id: string; answer: string | null; answeredBy: string | null; answeredAt: string | null };

function readRows(root: string): Row[] {
  const file = join(root, FILE);
  if (!existsSync(file)) return [];
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { questions?: unknown };
    return Array.isArray(v.questions) ? (v.questions.filter((r) => r && typeof (r as Row).id === "string") as Row[]) : [];
  } catch {
    return [];
  }
}

function writeRows(root: string, rows: Row[]): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ questions: rows }, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/**
 * The seeded questions with their answers. Seeds any that are missing from the file (first read on a fresh root), and
 * writes only then. Existing rows are never replaced, so a saved answer survives every later list.
 */
export function listOpenQuestions(root: string): OpenQuestion[] {
  const rows = readRows(root);
  const byId = new Map(rows.map((r) => [r.id, r]));
  let added = false;
  for (const s of SEEDED_QUESTIONS) {
    if (byId.has(s.id)) continue;
    const row: Row = { id: s.id, answer: null, answeredBy: null, answeredAt: null };
    rows.push(row);
    byId.set(s.id, row);
    added = true;
  }
  if (added) writeRows(root, rows);
  return SEEDED_QUESTIONS.map((s) => {
    const r = byId.get(s.id)!;
    return { id: s.id, question: s.question, answer: r.answer ?? null, answeredBy: r.answeredBy ?? null, answeredAt: r.answeredAt ?? null };
  });
}

/**
 * Records the answer to one seeded question. Last answer wins: a teacher who corrects themselves overwrites the earlier
 * text, answeredBy and answeredAt. Only this file is written; no search, knowledge or matching state is touched.
 */
export function answerOpenQuestion(root: string, id: string, answer: string, by: string, at: Date = new Date()): OpenQuestion {
  if (!SEEDED_QUESTIONS.some((s) => s.id === id)) throw new UnknownQuestionError("That question isn't open.");
  const text = answer.trim();
  if (!text) throw new OpenQuestionError("Write an answer.");
  if (text.length > MAX_ANSWER) throw new OpenQuestionError(`Keep the answer to one line (${MAX_ANSWER} characters at most).`);
  listOpenQuestions(root); // seeds the file first, so the write below keeps every row
  const rows = readRows(root);
  const row = rows.find((r) => r.id === id)!;
  row.answer = text;
  row.answeredBy = by;
  row.answeredAt = at.toISOString();
  writeRows(root, rows);
  return listOpenQuestions(root).find((q) => q.id === id)!;
}
