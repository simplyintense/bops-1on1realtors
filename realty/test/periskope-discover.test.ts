import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { INTAKE_GROUPS } from "../node/periskope-backfill.ts";
import { discoveryVerdict, looksRealEstate, previewDiscovery, type ApiChat } from "../node/periskope-discover.ts";
import { setConsent } from "../node/periskope-intake.ts";
import { PeriskopeStore } from "../node/periskope-store.ts";
import { pollOnce } from "../node/periskope-poll.ts";

// Invented groups and ids only. No real names, numbers or message text.
const NOW = new Date("2026-11-14T15:00:00.000Z");
const MIN = 60_000;
const COBROKE = INTAKE_GROUPS.find((g) => g.chatName.startsWith("Co-Broke"))!;
const NEW = { chat_id: "120000000001@g.us", chat_name: "Top Notch Realtors", member_count: 40 };
const RENT = { chat_id: "120000000005@g.us", chat_name: "Rentals Trinidad", member_count: 25 };
const SMALL = { chat_id: "120000000002@g.us", chat_name: "Small Realty Chat", member_count: 5 };
const STAFF = { chat_id: "120000000003@g.us", chat_name: "1on1 Realty Staff", member_count: 30 };
const STAFF2 = { chat_id: "120000000007@g.us", chat_name: "Team 1 on 1 Property", member_count: 30 };
const OFF = { chat_id: "120000000004@g.us", chat_name: "Family Dinner Club", member_count: 90 };
const AREA_LOWER = { chat_id: "120000000008@g.us", chat_name: "Area Lovers", member_count: 90 };
const PINNED_IN_LIST = { chat_id: COBROKE.chatId, chat_name: COBROKE.chatName, member_count: 300 };
const CHATS: ApiChat[] = [NEW, RENT, SMALL, STAFF, STAFF2, OFF, AREA_LOWER, PINNED_IN_LIST];

type Fake = ((url: string) => Promise<{ status: number; body: unknown }>) & { urls: string[] };

/** Serves the chat list in pages of `limit`, message lists empty, and member lists empty. Records every URL. */
function fakeFetch(chats: ApiChat[] = CHATS, opts: { chatsStatus?: number } = {}): Fake {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    if (url.startsWith("https://api.periskope.app/v1/chats?")) {
      if (opts.chatsStatus) return { status: opts.chatsStatus, body: { message: "server says something" } };
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset"));
      const limit = Number(u.searchParams.get("limit"));
      const page = chats.slice(offset, offset + limit);
      return { status: 200, body: { from: offset, to: offset + page.length, count: chats.length, chats: page } };
    }
    if (url.includes("/messages")) return { status: 200, body: { messages: [] } };
    return { status: 200, body: { members: {} } };
  }) as Fake;
  f.urls = urls;
  return f;
}

function world(pinnedWithConsent: string[] = INTAKE_GROUPS.map((g) => g.chatId)) {
  return { root: mkdtempSync(join(tmpdir(), "periskope-discover-")), pinnedWithConsent };
}

async function seedConsent(root: string, chatIds: string[]) {
  for (const g of INTAKE_GROUPS.filter((x) => chatIds.includes(x.chatId))) {
    await setConsent({ chatId: g.chatId, groupName: g.chatName, noticeWaivedAt: "2026-11-14T13:39:00.000Z", noticeWaivedBy: "owner", adminOkAt: "2026-11-14T13:39:00.000Z", adminOkBy: "Miles Abraham" }, { root, crm: null });
  }
}

/** The start_time the poll asked for on one group's message list. */
function startTimeFor(urls: string[], chatId: string, at = -1): string | null {
  const hits = urls.filter((u) => u.includes(`/v1/chats/${encodeURIComponent(chatId)}/messages`));
  const u = hits.at(at);
  return u ? new URL(u).searchParams.get("start_time") : null;
}

const chatListCalls = (urls: string[]) => urls.filter((u) => u.startsWith("https://api.periskope.app/v1/chats?")).length;

test("looksRealEstate: the name patterns, the size floor, the internal denylist and the env deny list", () => {
  assert.equal(looksRealEstate(NEW), true, "realtors, with 40 members");
  assert.equal(looksRealEstate({ chat_id: "x@g.us", chat_name: "Rentals", member_count: 20 }), true, "twenty members is enough");
  assert.equal(looksRealEstate({ chat_id: "x@g.us", chat_name: "Rentals", member_count: 19 }), false, "nineteen is not");
  assert.equal(looksRealEstate(OFF), false, "no real-estate word");
  assert.equal(looksRealEstate(AREA_LOWER), false, "AREA is case-sensitive: 'Area' does not count");
  assert.equal(looksRealEstate({ chat_id: "x@g.us", chat_name: "AREA members", member_count: 50 }), true, "uppercase AREA as a word");
  assert.equal(looksRealEstate({ chat_id: "x@g.us", chat_name: "Parenting Forum", member_count: 50 }), false, "rent does not match inside parent");
  assert.equal(looksRealEstate(STAFF), false, "1on1 is the brokerage's staff chat");
  assert.equal(looksRealEstate(STAFF2), false, "1 on 1 with spaces is denied too");
  assert.equal(looksRealEstate({ chat_id: "x@g.us", chat_name: "Property", member_count: 50 }, {}), true);
  assert.equal(looksRealEstate({ chat_id: "x@g.us", chat_name: "Realty", member_count: 50 }, { PERISKOPE_DENY_CHAT_IDS: "y@g.us| x@g.us |z@g.us" }), false, "a denied chat id, with spaces around the bars");
  assert.equal(looksRealEstate({ chat_id: "x@g.us", chat_name: "Realty", member_count: 50 }, { PERISKOPE_DENY_CHAT_IDS: "y@g.us" }), true);
  assert.equal(looksRealEstate({ chat_id: "x@g.us", chat_name: "Realty", member_count: 50 }, { PERISKOPE_DENY_CHAT_IDS: undefined }), true);
  assert.equal(looksRealEstate({ chat_id: "9@s.whatsapp.net", chat_name: "Realty", member_count: 50 }), false, "only group chat ids");
  assert.equal(discoveryVerdict(SMALL).reason, "too_small");
  assert.equal(discoveryVerdict(OFF).reason, "not_real_estate");
  assert.equal(discoveryVerdict(STAFF).reason, "denied_name");
});

test("discovery adds the matching groups, skips small, denylisted and non-matching ones, and pages the list", async () => {
  // A first page of 100 non-matching chats, so the matching ones are only on page two.
  const filler: ApiChat[] = Array.from({ length: 100 }, (_, i) => ({ chat_id: `1300000${String(i).padStart(4, "0")}@g.us`, chat_name: `Family ${i}`, member_count: 50 }));
  const w = world();
  await seedConsent(w.root, w.pinnedWithConsent);
  const fetcher = fakeFetch([...filler, ...CHATS]);
  const r = await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => NOW, fetcher, crm: null });
  assert.equal(r.ok, true);
  assert.deepEqual(fetcher.urls.filter((u) => u.startsWith("https://api.periskope.app/v1/chats?")).map((u) => new URL(u).searchParams.get("offset")), ["0", "100"]);
  assert.ok(fetcher.urls.every((u) => u.startsWith("https://api.periskope.app/v1/")), "only the Periskope GET API");
  assert.deepEqual(r.discovery, { ran: true, ok: true, checked: 108 });
  assert.deepEqual(r.groupsAdded, [
    { group: "Top Notch Realtors", chatId: NEW.chat_id, members: 40, source: "auto" },
    { group: "Rentals Trinidad", chatId: RENT.chat_id, members: 25, source: "auto" },
  ]);

  const roster = JSON.parse(readFileSync(join(w.root, "groups.json"), "utf8")) as { chatId: string; source: string }[];
  const auto = roster.filter((g) => g.source === "auto").map((g) => g.chatId);
  assert.deepEqual(auto, [NEW.chat_id, RENT.chat_id], "only the two that qualify: not the small, staff, off-topic or pinned ones");
  assert.equal(statSync(join(w.root, "groups.json")).mode & 0o777, 0o600);
  assert.ok(roster.some((g) => g.chatId === COBROKE.chatId && g.source === "pinned"), "the roster lists the pinned groups too");

  const added = readFileSync(join(w.root, "groups-added.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(added.length, 2);
  assert.deepEqual(Object.keys(added[0]).sort(), ["at", "chatId", "group", "members", "source"], "names and ids only, no message text");
});

test("an added group gets the owner waiver once and a 7-day backfill on its first fetch, then the normal overlap window", async () => {
  const w = world();
  await seedConsent(w.root, w.pinnedWithConsent);
  const fetcher = fakeFetch();
  await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => NOW, fetcher, crm: null });
  const sevenDaysAgo = new Date(NOW.getTime() - 7 * 86_400_000).toISOString();
  assert.equal(startTimeFor(fetcher.urls, NEW.chat_id), sevenDaysAgo, "the first fetch covers the last seven days");

  const consent = new PeriskopeStore(w.root).consent(NEW.chat_id);
  assert.ok(consent, "a consent record was written");
  assert.equal(consent.noticeWaivedAt, "2026-11-14T13:39:00.000Z", "the standing owner waiver timestamp");
  assert.equal(consent.noticeWaivedBy, "owner");
  assert.equal(consent.adminOkBy, "Miles Abraham");
  assert.equal(consent.noticePostedAt, null, "no notice was posted");
  assert.equal(consent.active, true);

  // Ten minutes later: a regular poll, not another backfill.
  const later = new Date(NOW.getTime() + 10 * MIN);
  await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => later, fetcher, crm: null });
  assert.notEqual(startTimeFor(fetcher.urls, NEW.chat_id), sevenDaysAgo, "not the seven-day window again");
  // No posts yet: the cursor from the first poll (NOW) less the two-minute overlap, but never less than the last hour.
  assert.equal(startTimeFor(fetcher.urls, NEW.chat_id), new Date(later.getTime() - 60 * MIN).toISOString(), "at least the last hour");

  // Hours later with no new posts: the old cursor less the overlap is older than the hour floor, so it is kept.
  const much = new Date(NOW.getTime() + 5 * 60 * MIN);
  await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => much, fetcher, crm: null });
  assert.equal(startTimeFor(fetcher.urls, NEW.chat_id), new Date(NOW.getTime() - 2 * MIN).toISOString(), "the wider of the two windows");
});

test("discovery runs at most once an hour, and a second run adds nothing and rewrites no consent", async () => {
  const w = world();
  await seedConsent(w.root, w.pinnedWithConsent);
  const fetcher = fakeFetch();
  const first = await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => NOW, fetcher, crm: null });
  assert.equal(first.groupsAdded.length, 2);
  const consentBefore = JSON.stringify(new PeriskopeStore(w.root).consents());
  const rosterBefore = readFileSync(join(w.root, "groups.json"), "utf8");

  const tenMin = await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => new Date(NOW.getTime() + 10 * MIN), fetcher, crm: null });
  assert.deepEqual(tenMin.discovery, { ran: false });
  assert.equal(chatListCalls(fetcher.urls), 1, "no second listing inside the hour");

  const hourLater = await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => new Date(NOW.getTime() + 61 * MIN), fetcher, crm: null });
  assert.deepEqual(hourLater.discovery, { ran: true, ok: true, checked: 8 });
  assert.equal(chatListCalls(fetcher.urls), 2, "listed again after the hour");
  assert.deepEqual(hourLater.groupsAdded, [], "idempotent: nothing new");
  assert.equal(readFileSync(join(w.root, "groups.json"), "utf8"), rosterBefore, "the roster is unchanged");
  assert.equal(JSON.stringify(new PeriskopeStore(w.root).consents()), consentBefore, "no consent was rewritten");
  assert.equal(readFileSync(join(w.root, "groups-added.jsonl"), "utf8").trim().split("\n").length, 2, "one line per added group, ever");
});

test("a pinned group with no consent record (Co-Broke) gets the waiver and a 7-day backfill on its first poll", async () => {
  const pinnedWithout = INTAKE_GROUPS.map((g) => g.chatId).filter((id) => id !== COBROKE.chatId);
  const w = world(pinnedWithout);
  await seedConsent(w.root, pinnedWithout);
  assert.equal(new PeriskopeStore(w.root).consent(COBROKE.chatId), null);
  const fetcher = fakeFetch([]);
  const r = await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => NOW, fetcher, crm: null });
  assert.equal(r.ok, true);
  assert.equal(r.groupsAdded.length, 0, "pinned groups are not 'added'");
  const consent = new PeriskopeStore(w.root).consent(COBROKE.chatId);
  assert.equal(consent?.noticeWaivedAt, "2026-11-14T13:39:00.000Z");
  assert.equal(startTimeFor(fetcher.urls, COBROKE.chatId), new Date(NOW.getTime() - 7 * 86_400_000).toISOString());
  const second = await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => new Date(NOW.getTime() + 10 * MIN), fetcher, crm: null });
  assert.equal(second.ok, true);
  assert.equal(new PeriskopeStore(w.root).consents().filter((c) => c.chatId === COBROKE.chatId).length, 1, "one record, not rewritten");
});

test("a failed listing is logged as a code and the poll still runs; the next attempt waits an hour", async () => {
  const w = world();
  await seedConsent(w.root, w.pinnedWithConsent);
  const bad = fakeFetch(CHATS, { chatsStatus: 500 });
  const r = await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => NOW, fetcher: bad, crm: null });
  assert.equal(r.ok, true, "the poll is not broken");
  assert.deepEqual(r.discovery, { ran: true, ok: false, code: "http_500" });
  assert.equal(r.groupsAdded.length, 0);
  assert.ok(bad.urls.some((u) => u.includes(`/v1/chats/${encodeURIComponent(INTAKE_GROUPS[1].chatId)}/messages`)), "the pinned groups are still polled");
  assert.equal(new PeriskopeStore(w.root).consent(NEW.chat_id), null, "nothing was added");

  const again = await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => new Date(NOW.getTime() + 10 * MIN), fetcher: bad, crm: null });
  assert.equal(again.discovery?.ran, false, "throttled after a failure too");
});

test("a thrown listing error is caught and the poll still completes", async () => {
  const w = world();
  await seedConsent(w.root, w.pinnedWithConsent);
  const boom = Object.assign(async (url: string) => {
    if (url.includes("/v1/chats?")) throw Object.assign(new Error("socket hang up with the key in it?"), { code: "ECONNRESET" });
    return { status: 200, body: { messages: [] } };
  }, {});
  const r = await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => NOW, fetcher: boom, crm: null });
  assert.equal(r.ok, true);
  assert.deepEqual(r.discovery, { ran: true, ok: false, code: "ECONNRESET" }, "a code, never the message");
});

test("PERISKOPE_DENY_CHAT_IDS keeps a group out, and stops polling an already-added one", async () => {
  const w = world();
  await seedConsent(w.root, w.pinnedWithConsent);
  const denied = await pollOnce({ root: w.root, env: { PERISKOPE_DENY_CHAT_IDS: RENT.chat_id }, apiKey: "test-key", now: () => NOW, fetcher: fakeFetch(), crm: null });
  assert.deepEqual(denied.groupsAdded.map((g) => g.chatId), [NEW.chat_id], "the denied one is not added");

  // Added earlier; now denied. The poll must not fetch it.
  const w2 = world();
  await seedConsent(w2.root, w2.pinnedWithConsent);
  await pollOnce({ root: w2.root, env: {}, apiKey: "test-key", now: () => NOW, fetcher: fakeFetch(), crm: null });
  const fetcher = fakeFetch();
  await pollOnce({ root: w2.root, env: { PERISKOPE_DENY_CHAT_IDS: NEW.chat_id }, apiKey: "test-key", now: () => new Date(NOW.getTime() + 10 * MIN), fetcher, crm: null });
  assert.equal(fetcher.urls.some((u) => u.includes(encodeURIComponent(NEW.chat_id))), false, "a denied chat is not polled");
});

test("the poll's JSON log fields carry names, ids and counts only", async () => {
  const w = world();
  await seedConsent(w.root, w.pinnedWithConsent);
  const r = await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => NOW, fetcher: fakeFetch(), crm: null });
  const line = JSON.stringify(r.groupsAdded.map((x) => ({ group: x.group, chatId: x.chatId, members: x.members, source: x.source })));
  assert.deepEqual(JSON.parse(line), [
    { group: "Top Notch Realtors", chatId: NEW.chat_id, members: 40, source: "auto" },
    { group: "Rentals Trinidad", chatId: RENT.chat_id, members: 25, source: "auto" },
  ]);
  assert.equal(line.includes("test-key"), false);
});

test("a roster file with garbage is ignored, not fatal", async () => {
  const w = world();
  await seedConsent(w.root, w.pinnedWithConsent);
  writeFileSync(join(w.root, "groups.json"), "{ not json", { mode: 0o600 });
  const r = await pollOnce({ root: w.root, env: {}, apiKey: "test-key", now: () => NOW, fetcher: fakeFetch(), crm: null });
  assert.equal(r.ok, true);
  assert.equal(r.groupsAdded.length, 2);
});

test("the dry run says what would be included and why, without writing anything", () => {
  const roster = [{ chatId: RENT.chat_id, chatName: RENT.chat_name, memberCount: 25, addedAt: NOW.toISOString(), source: "auto" as const }];
  const rows = previewDiscovery(CHATS, {}, roster);
  const why = Object.fromEntries(rows.map((r) => [r.group, [r.included, r.reason]]));
  assert.deepEqual(why["Top Notch Realtors"], [true, "included"]);
  assert.deepEqual(why["Rentals Trinidad"], [false, "already_added"]);
  assert.deepEqual(why["Small Realty Chat"], [false, "too_small"]);
  assert.deepEqual(why["1on1 Realty Staff"], [false, "denied_name"]);
  assert.deepEqual(why["Family Dinner Club"], [false, "not_real_estate"]);
  assert.deepEqual(why[COBROKE.chatName], [false, "already_pinned"]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["chatId", "group", "included", "members", "reason"], "names, ids and counts only");
  assert.deepEqual(previewDiscovery([{ chat_id: NEW.chat_id, chat_name: NEW.chat_name, member_count: 40 }], { PERISKOPE_DENY_CHAT_IDS: NEW.chat_id }, [])[0].reason, "denied_chat");
});
