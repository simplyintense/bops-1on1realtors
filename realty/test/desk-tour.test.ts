import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { GATE_COOKIE, gateConfig, makeSession } from "../../lib/gate.ts";
import { visibleStaffPages, navTourId } from "../../app/realty/staff-pages.ts";
import { buildTourSteps, parseTourState, shouldAutoStart, startTour, tourReducer, type TourStep } from "../../app/realty/tour-steps.ts";
import { hasSeenTour, markTourSeen, TOUR_SEEN_FILE } from "../node/tour-seen.ts";
import { INTAKE_GROUPS } from "../node/periskope-groups.ts";
import { POST } from "../../app/api/realty/tour/route.ts";

/**
 * The guided staff tour: the step list per role (app/realty/tour-steps.ts), the "seen" store (realty/node/tour-seen.ts), and
 * the POST route that marks the signed-in viewer. The overlay itself is JSX (app/realty/desk-tour.tsx) and is checked by
 * build and by hand; here we check what it is given.
 */

const OWNER = "miles@1on1.example";
const AGENT = "kerry@1on1.example";
const AGENT_ONLY = { owner: false, teacher: false };
const OWNER_ONLY = { owner: true, teacher: false };
const TEACHER_ONLY = { owner: false, teacher: true };
const ROLES = { agent: AGENT_ONLY, owner: OWNER_ONLY, teacher: TEACHER_ONLY, ownerAndTeacher: { owner: true, teacher: true } };

const freshRoot = () => mkdtempSync(join(tmpdir(), "desk-tour-"));
const pagesOf = (steps: TourStep[]) => [...new Set(steps.flatMap((s) => (s.page ? [s.page] : [])))];

test("shows on first load: a first-time viewer auto-runs, and the store says nobody has seen it", () => {
  const root = freshRoot();
  assert.equal(shouldAutoStart(false), true);
  assert.equal(hasSeenTour(OWNER, root), false);
  assert.equal(hasSeenTour("", root), false, "an empty email is nobody");
});

test("not after dismiss: once marked, it never auto-runs again, and the email matches case-insensitively", () => {
  const root = freshRoot();
  assert.equal(markTourSeen(AGENT, root, new Date("2026-11-17T10:00:00Z")), true);
  assert.equal(hasSeenTour(AGENT, root), true);
  assert.equal(hasSeenTour("  KERRY@1on1.example ", root), true, "case and spaces are the same viewer");
  assert.equal(hasSeenTour(OWNER, root), false, "one viewer's mark is not another's");
  assert.equal(shouldAutoStart(true), false);
  assert.equal(markTourSeen("kerry@1ON1.example", root), false, "a second mark writes nothing");
  const lines = readFileSync(join(root, TOUR_SEEN_FILE), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { email: AGENT, at: "2026-11-17T10:00:00.000Z" });
});

test("replay: Start tour begins at the welcome card whether or not the tour was seen, with the same steps", () => {
  const root = freshRoot();
  const before = buildTourSteps(OWNER_ONLY);
  markTourSeen(OWNER, root);
  assert.equal(hasSeenTour(OWNER, root), true);
  assert.deepEqual(startTour(), { index: 0 });
  assert.deepEqual(tourReducer(null, { type: "start" }, before.length), { index: 0 });
  assert.deepEqual(buildTourSteps(OWNER_ONLY), before, "seen or not, the same steps");
  assert.equal(before[0].id, "welcome");
  assert.equal(before[0].title, "Welcome to the 1on1 Desk");
  assert.equal(before[0].text, "This desk helps you find buyer matches and listings faster. Here's a quick look around.");
  const last = before[before.length - 1];
  assert.equal(last.target, "start-tour");
  assert.equal(last.text, "That's it. You can replay this tour any time with Start tour.");
});

test("role filtering: an agent sees only Desk and Online search; owners get their pages; teachers get Teach", () => {
  const agent = pagesOf(buildTourSteps(AGENT_ONLY));
  assert.deepEqual(agent, ["/realty/desk", "/realty/market"]);
  assert.ok(!agent.includes("/"), "the Bops chat app is never in the tour");

  const owner = pagesOf(buildTourSteps(OWNER_ONLY));
  for (const page of ["/realty/automatch", "/realty/search", "/realty/posts", "/realty/digest", "/realty/alerts"]) {
    assert.ok(owner.includes(page), `owner includes ${page}`);
  }
  assert.ok(!owner.includes("/realty/learn"), "an owner who isn't a teacher doesn't get Teach");
  assert.ok(!owner.includes("/"));

  const teacher = pagesOf(buildTourSteps(TEACHER_ONLY));
  assert.deepEqual(teacher, ["/realty/desk", "/realty/market", "/realty/learn"]);
  assert.ok(!teacher.includes("/"));

  const both = pagesOf(buildTourSteps(ROLES.ownerAndTeacher));
  assert.ok(both.includes("/realty/learn") && both.includes("/realty/automatch"));
  assert.equal(both.length, 8, "every staff page except the chat app");
});

test("steps navigate: each step has a page, pages come in nav order, and each page starts with its nav link", () => {
  for (const [name, role] of Object.entries(ROLES)) {
    const steps = buildTourSteps(role);
    const navOrder = visibleStaffPages(role).filter((p) => p.href !== "/").map((p) => p.href);
    const seq = steps.flatMap((s) => (s.page ? [s.page] : []));
    const grouped = [...new Set(seq)];
    assert.deepEqual(grouped, navOrder, `${name}: pages in nav order, each grouped together`);
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] !== seq[i - 1]) assert.ok(!seq.slice(0, i).includes(seq[i]), `${name}: ${seq[i]} is not split across the tour`);
    }
    for (const href of navOrder) {
      const first = steps.find((s) => s.page === href);
      assert.equal(first?.target, navTourId(href), `${name}: ${href} starts on its nav link`);
    }
    const ids = steps.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${name}: step ids are unique`);
    const welcome = steps[0];
    const closing = steps[steps.length - 1];
    assert.equal(welcome.page, null, "the welcome card doesn't navigate");
    assert.equal(closing.page, null, "the closing card doesn't navigate");
    assert.equal(welcome.card, "centre");
    assert.equal(closing.card, "centre");
  }
});

test("reducer: next walks to the end and then ends the tour, back stops at the welcome card, skip ends it from any step", () => {
  const count = 3;
  assert.deepEqual(tourReducer({ index: 0 }, { type: "next" }, count), { index: 1 });
  assert.equal(tourReducer({ index: 2 }, { type: "next" }, count), null, "Done on the last step");
  assert.deepEqual(tourReducer({ index: 0 }, { type: "back" }, count), { index: 0 });
  assert.deepEqual(tourReducer({ index: 2 }, { type: "back" }, count), { index: 1 });
  assert.equal(tourReducer({ index: 1 }, { type: "skip" }, count), null);
  assert.equal(tourReducer(null, { type: "next" }, count), null);
});

test("saved in-progress state: only a valid step index is resumed", () => {
  assert.deepEqual(parseTourState('{"index":4}'), { index: 4 });
  assert.equal(parseTourState(null), null);
  assert.equal(parseTourState("not json"), null);
  assert.equal(parseTourState('{"index":-1}'), null);
  assert.equal(parseTourState('{"index":1.5}'), null);
  assert.equal(parseTourState('{"step":2}'), null);
});

test("copy: no step says a banned word or names a WhatsApp group, for any role (case-insensitive)", () => {
  const banned = ["bops", "periskope", "score", "webhook", "fly", "supabase"];
  const groupNames = INTAKE_GROUPS.map((g) => g.chatName.toLowerCase());
  for (const [name, role] of Object.entries(ROLES)) {
    for (const s of buildTourSteps(role)) {
      const copy = `${s.title} ${s.text}`.toLowerCase();
      for (const word of banned) assert.ok(!copy.includes(word), `${name}: "${word}" in "${s.id}": ${copy}`);
      for (const g of groupNames) assert.ok(!copy.includes(g), `${name}: group name in "${s.id}"`);
    }
  }
});

test("every spotlight target is on a page: each data-tour id in the steps exists in the realty source", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f)) files.push(p);
    }
  };
  const appRealty = fileURLToPath(new URL("../../app/realty", import.meta.url));
  walk(appRealty);
  const source = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const navSource = readFileSync(join(appRealty, "staff-nav.tsx"), "utf8");
  assert.ok(navSource.includes("data-tour={navTourId(p.href)}"), "nav links carry their data-tour id");
  const targets = new Set(Object.values(ROLES).flatMap((r) => buildTourSteps(r).map((s) => s.target)));
  for (const t of targets) {
    if (!t || t.startsWith("nav-")) continue;
    assert.ok(new RegExp(`(data-tour|tour)="${t}"`).test(source), `data-tour="${t}" is in the source`);
  }
  assert.ok(source.includes(`data-tour="start-tour"`), "the Start tour button has its id");
});

test("route: no session is 401 and the body's email is ignored; a signed-in viewer is marked from the cookie only", async () => {
  const root = freshRoot();
  const keys = ["BOPS_LOGIN_GATE", "BOPS_GATE_SECRET", "BOPS_ALLOWED_EMAILS", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "BOPS_PUBLIC_URL", "BOPS_OWNER_EMAILS", "PERISKOPE_ROOT", "ONEON1_PUBLIC_DEMO"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const env = {
    BOPS_LOGIN_GATE: "google",
    BOPS_GATE_SECRET: "x".repeat(40),
    BOPS_ALLOWED_EMAILS: "@1on1.example",
    GOOGLE_OAUTH_CLIENT_ID: "id",
    GOOGLE_OAUTH_CLIENT_SECRET: "secret",
    BOPS_PUBLIC_URL: "https://bops.example",
    BOPS_OWNER_EMAILS: OWNER,
    PERISKOPE_ROOT: root,
    ONEON1_PUBLIC_DEMO: "0",
  };
  try {
    Object.assign(process.env, env);
    const url = "https://bops.example/api/realty/tour";
    const anon = await POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: AGENT }) }));
    assert.equal(anon.status, 401);
    assert.equal(hasSeenTour(AGENT, root), false, "a body email is never recorded");
    assert.equal(existsSync(join(root, TOUR_SEEN_FILE)), false);

    const cfg = gateConfig(env);
    if (!cfg || cfg === "misconfigured") throw new Error("test config");
    const cookie = `${GATE_COOKIE}=${await makeSession(AGENT, cfg)}`;
    const ok = await POST(new Request(url, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ email: OWNER }) }));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { seen: true, recorded: true });
    assert.equal(hasSeenTour(AGENT, root), true, "the cookie's viewer is marked");
    assert.equal(hasSeenTour(OWNER, root), false, "the body's email is not");
    const again = await POST(new Request(url, { method: "POST", headers: { cookie } }));
    assert.deepEqual(await again.json(), { seen: true, recorded: false });
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
