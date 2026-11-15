import assert from "node:assert/strict";
import test from "node:test";
import { GATE_COOKIE, gateConfig, makeSession, teachAllowed } from "../../lib/gate.ts";
import { teacherAccess } from "../node/periskope-intake.ts";

/**
 * Who may teach Bops (BOPS_TEACH_EMAILS, lib/gate.ts teachAllowed; the route and page check it through teacherAccess).
 * Invented addresses only.
 */

const TEACHER = "teacher@1on1.example";
const OWNER = "owner@1on1.example";
const AGENT = "agent@1on1.example";
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example", BOPS_OWNER_EMAILS: OWNER };
const WITH_TEACHERS = { ...GATE, BOPS_TEACH_EMAILS: TEACHER };
const cfg = gateConfig(GATE);
if (!cfg || cfg === "misconfigured") throw new Error("test config");

test("teachAllowed: a listed teacher, in any case; the owner and an agent are not teachers unless listed", () => {
  assert.equal(teachAllowed(TEACHER, WITH_TEACHERS), true);
  assert.equal(teachAllowed("TEACHER@1on1.example", WITH_TEACHERS), true, "case-insensitive");
  assert.equal(teachAllowed(OWNER, WITH_TEACHERS), false, "an owner who isn't listed can't teach");
  assert.equal(teachAllowed(AGENT, WITH_TEACHERS), false, "an agent can't teach");
  assert.equal(teachAllowed(null, WITH_TEACHERS), false, "signed out");
  assert.equal(teachAllowed(OWNER, { ...WITH_TEACHERS, BOPS_TEACH_EMAILS: `${TEACHER}, ${OWNER}` }), true, "a comma-separated list");
});

test("teachAllowed: unset or empty means nobody, including the teacher; a domain entry doesn't grant a whole domain", () => {
  assert.equal(teachAllowed(TEACHER, GATE), false, "unset");
  assert.equal(teachAllowed(TEACHER, { ...GATE, BOPS_TEACH_EMAILS: "" }), false, "empty");
  assert.equal(teachAllowed(AGENT, { ...GATE, BOPS_TEACH_EMAILS: "@1on1.example" }), false, "only exact emails are teachers");
});

test("teachAllowed: with the login gate off there's no signed-in email, so nobody teaches over the web", () => {
  assert.equal(teachAllowed(null, { BOPS_TEACH_EMAILS: TEACHER }), false);
  assert.equal(teachAllowed(TEACHER, { BOPS_TEACH_EMAILS: TEACHER }), false, "a misconfigured or off gate is no pass");
  assert.equal(teachAllowed(TEACHER, { ...GATE, BOPS_GATE_SECRET: "short", BOPS_TEACH_EMAILS: TEACHER }), false, "a misconfigured gate says no");
});

test("the teach API: the teacher passes; another signed-in staff member and an owner get 404; signed out gets 401", async () => {
  const req = async (email: string | null) =>
    new Request("https://bops.example/api/realty/learn", { method: "POST", headers: email ? { cookie: `${GATE_COOKIE}=${await makeSession(email, cfg)}` } : {} });
  assert.equal(await teacherAccess(await req(TEACHER), WITH_TEACHERS), null);
  assert.equal((await teacherAccess(await req(AGENT), WITH_TEACHERS))?.status, 404, "a non-teacher gets a 404, not a hint");
  assert.equal((await teacherAccess(await req(OWNER), WITH_TEACHERS))?.status, 404, "an owner who isn't a teacher gets a 404");
  assert.equal((await teacherAccess(await req(null), WITH_TEACHERS))?.status, 401, "signed out: the normal gate answers");
  assert.equal((await teacherAccess(await req(TEACHER), GATE))?.status, 404, "unset list: even the teacher gets a 404");
  assert.equal((await teacherAccess(await req(TEACHER), { ...WITH_TEACHERS, ONEON1_PUBLIC_DEMO: "1" }))?.status, 403, "the public demo is closed first");
});
