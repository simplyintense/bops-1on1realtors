import assert from "node:assert/strict";
import { test } from "node:test";
import { onlineFeedHref, sourceFrom, toSearchParams } from "../../app/realty/search/source.ts";

/**
 * Supply & Demand's source (app/realty/search/source.ts): the default is the WhatsApp groups search, `source=online` is the
 * market's buyer-request feed, and the old /realty/requests URL redirects there with its query kept. The pages are JSX, so
 * the parsing and the redirect target are checked here.
 */

test("source defaults to the WhatsApp groups when absent, blank, or anything but online", () => {
  assert.equal(sourceFrom({}), "groups");
  assert.equal(sourceFrom({ source: "groups" }), "groups");
  assert.equal(sourceFrom({ source: "" }), "groups");
  assert.equal(sourceFrom({ source: "Online" }), "groups", "only the exact value online selects the feed");
  assert.equal(sourceFrom({ source: undefined }), "groups");
});

test("source=online selects the online feed, and the first value counts when repeated", () => {
  assert.equal(sourceFrom({ source: "online" }), "online");
  assert.equal(sourceFrom({ source: ["online", "groups"] }), "online");
  assert.equal(sourceFrom({ source: ["groups", "online"] }), "groups");
});

test("the old requests URL's query carries over to /realty/search?source=online, with source first", () => {
  const old = new URLSearchParams("q=two+beds&area=Invented+Bay&intent=rent&status=any&priceMin=900&priceMax=2500&bedsMin=2&sort=budget&dir=asc");
  const target = onlineFeedHref(old);
  assert.ok(target.startsWith("/realty/search?source=online&"), target);
  const back = new URL(target, "https://bops.example").searchParams;
  assert.equal(back.get("source"), "online");
  for (const [k, v] of old) assert.equal(back.get(k), v, `${k} is kept`);
  assert.equal(back.getAll("source").length, 1, "source appears once");
});

test("an old requests URL with no query redirects to exactly /realty/search?source=online", () => {
  assert.equal(onlineFeedHref(new URLSearchParams()), "/realty/search?source=online");
});

test("an old source param is replaced, not doubled, by the online redirect", () => {
  const target = onlineFeedHref(new URLSearchParams("source=groups&area=Invented+Bay"));
  const back = new URL(target, "https://bops.example").searchParams;
  assert.deepEqual(back.getAll("source"), ["online"]);
  assert.equal(back.get("area"), "Invented Bay");
  assert.equal(sourceFrom(Object.fromEntries(back)), "online", "the redirect lands on the online feed");
});

test("toSearchParams takes the first value of a repeated key and drops missing ones", () => {
  const p = toSearchParams({ q: ["first", "second"], area: "Invented Bay", beds: undefined });
  assert.equal(p.get("q"), "first");
  assert.equal(p.get("area"), "Invented Bay");
  assert.equal(p.has("beds"), false);
});
