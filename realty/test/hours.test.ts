import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addBusinessMs,
  businessHoursFromEnv,
  isBusinessTime,
  nextBusinessOpen,
  parseDays,
  parseHours,
  PLACEHOLDER_BUSINESS_HOURS,
  type BusinessHours,
} from "../flow/hours.ts";

/** Business-hours SLA math. Port of Spain is UTC-4 all year, so "-04:00" literals are local time. */

const MIN = 60_000;
const ast = (s: string) => new Date(`${s}-04:00`); // "2026-11-12T09:00" → that instant in Port of Spain
const H = PLACEHOLDER_BUSINESS_HOURS;

test("the default is the PLACEHOLDER: 08:00-17:00, Monday to Friday, Port of Spain, flagged as a placeholder", () => {
  const h = businessHoursFromEnv({});
  assert.deepEqual(h, { start: "08:00", end: "17:00", days: [1, 2, 3, 4, 5], tz: "America/Port_of_Spain", placeholder: true });
  assert.equal(PLACEHOLDER_BUSINESS_HOURS.placeholder, true);
});

test("env overrides: both set → not a placeholder; only one set → still a placeholder, with that part applied", () => {
  const both = businessHoursFromEnv({ ONEON1_BUSINESS_HOURS: "8:30-16:30", ONEON1_BUSINESS_DAYS: "mon,tue,wed,thu,fri,sat" });
  assert.deepEqual(both, { start: "08:30", end: "16:30", days: [1, 2, 3, 4, 5, 6], tz: "America/Port_of_Spain", placeholder: false });

  const hoursOnly = businessHoursFromEnv({ ONEON1_BUSINESS_HOURS: "09:00-18:00" });
  assert.deepEqual([hoursOnly.start, hoursOnly.end, hoursOnly.days, hoursOnly.placeholder], ["09:00", "18:00", [1, 2, 3, 4, 5], true]);

  const daysOnly = businessHoursFromEnv({ ONEON1_BUSINESS_DAYS: "mon-sat" });
  assert.deepEqual([daysOnly.start, daysOnly.end, daysOnly.days, daysOnly.placeholder], ["08:00", "17:00", [1, 2, 3, 4, 5, 6], true]);

  const junk = businessHoursFromEnv({ ONEON1_BUSINESS_HOURS: "17:00-08:00", ONEON1_BUSINESS_DAYS: "someday" });
  assert.deepEqual(junk, { ...H, days: [1, 2, 3, 4, 5] }, "unreadable values fall back to the placeholder");
});

test("parsing hours and days", () => {
  assert.deepEqual(parseHours("08:00-17:00"), { start: "08:00", end: "17:00" });
  assert.deepEqual(parseHours("8:00 - 17:00"), { start: "08:00", end: "17:00" });
  assert.equal(parseHours("17:00-08:00"), null, "no overnight windows");
  assert.equal(parseHours("8-5"), null);
  assert.deepEqual(parseDays("mon-fri"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays("Mon,Tue,Wed,Thu,Fri"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays("fri-mon"), [0, 1, 5, 6], "a range can wrap the weekend");
  assert.equal(parseDays("mon-xyz"), null);
  assert.equal(parseDays(""), null);
});

test("isBusinessTime: start is inside, end is outside, weekends are outside", () => {
  assert.equal(isBusinessTime(ast("2026-11-12T08:00"), H), true, "Thursday at open");
  assert.equal(isBusinessTime(ast("2026-11-12T07:59"), H), false);
  assert.equal(isBusinessTime(ast("2026-11-12T16:59"), H), true);
  assert.equal(isBusinessTime(ast("2026-11-12T17:00"), H), false, "end is exclusive");
  assert.equal(isBusinessTime(ast("2026-11-14T10:00"), H), false, "Saturday");
  assert.equal(isBusinessTime(ast("2026-11-15T10:00"), H), false, "Sunday");
  // 21:00 Thursday local is 01:00 Friday UTC: the local day is what counts.
  assert.equal(isBusinessTime(ast("2026-11-12T21:00"), H), false);
  assert.equal(isBusinessTime(ast("2026-11-13T03:00"), businessHoursFromEnv({ ONEON1_BUSINESS_HOURS: "00:00-24:00", ONEON1_BUSINESS_DAYS: "fri" })), true);
});

test("addBusinessMs: 15 minutes from 09:00 Thursday is 09:15 the same day", () => {
  assert.equal(addBusinessMs(ast("2026-11-12T09:00"), 15 * MIN, H).toISOString(), ast("2026-11-12T09:15").toISOString());
});

test("addBusinessMs: 15 minutes from 16:50 Thursday is 08:05 Friday (10 today, 5 tomorrow)", () => {
  assert.equal(addBusinessMs(ast("2026-11-12T16:50"), 15 * MIN, H).toISOString(), ast("2026-11-13T08:05").toISOString());
});

test("addBusinessMs: from Saturday the count starts at Monday's open", () => {
  assert.equal(addBusinessMs(ast("2026-11-14T11:30"), 15 * MIN, H).toISOString(), ast("2026-11-16T08:15").toISOString());
  assert.equal(addBusinessMs(ast("2026-11-13T16:55"), 15 * MIN, H).toISOString(), ast("2026-11-16T08:10").toISOString(), "Friday late rolls over the weekend");
  assert.equal(addBusinessMs(ast("2026-11-12T06:00"), 15 * MIN, H).toISOString(), ast("2026-11-12T08:15").toISOString(), "before open the same day");
});

test("addBusinessMs: 0 ms inside hours is the same instant; outside hours it is the next open", () => {
  const t = ast("2026-11-12T10:07");
  assert.equal(addBusinessMs(t, 0, H).getTime(), t.getTime());
  assert.equal(addBusinessMs(ast("2026-11-12T18:00"), 0, H).toISOString(), ast("2026-11-13T08:00").toISOString());
});

test("addBusinessMs: a window that runs out exactly at close is due at close; longer windows span days", () => {
  assert.equal(addBusinessMs(ast("2026-11-12T16:45"), 15 * MIN, H).toISOString(), ast("2026-11-12T17:00").toISOString());
  // 10 business hours from Thursday 09:00: 8 h Thursday, 2 h Friday.
  assert.equal(addBusinessMs(ast("2026-11-12T09:00"), 10 * 60 * MIN, H).toISOString(), ast("2026-11-13T10:00").toISOString());
});

test("nextBusinessOpen and a config with no days", () => {
  assert.equal(nextBusinessOpen(ast("2026-11-12T17:00"), H).toISOString(), ast("2026-11-13T08:00").toISOString());
  const none: BusinessHours = { ...H, days: [] };
  assert.throws(() => addBusinessMs(ast("2026-11-12T09:00"), MIN, none));
});
