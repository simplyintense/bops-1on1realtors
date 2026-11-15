import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GATE_COOKIE, gateConfig, makeSession } from "../../lib/gate.ts";
import { MemoryAreaResolver } from "../flow/areas.ts";
import { matchedAt, isStale, LEAD_STALE_MS, leadCardId, leadMessage, leadsView, canSeeLead, firstNameOf, waUrlFor, askLine, type LeadInput, type MatchSeenRow } from "../flow/automatch-leads.ts";
import { shortListingTitle, listingTypeWord } from "../flow/listing-title.ts";
import { applyStatus, isHidden, MATCH_STATUSES, parseStatusPost, STATUS_LABEL, type StatusRow } from "../flow/match-status.ts";
import type { CrmSeam, SeamAgent } from "../flow/crm-seam.ts";
import type { Listing } from "../flow/source.ts";
import { automatchRun } from "../node/automatch.ts";
import { leadAccess, staffLeads } from "../node/automatch-leads.ts";
import { setMatchFollowUp } from "../node/match-status.ts";
import { PeriskopeStore, requestIdOf } from "../node/periskope-store.ts";

/**
 * Automatch lead cards: the message text, the wa.me link, the outcome statuses, who may see a card, the stale rule, the route's
 * lead permission, and that nothing new calls fetch. Invented people, 555-style numbers and listings only.
 */

const NOW = new Date("2026-11-14T12:00:00.000Z");
const HOUR = 3_600_000;
const OWNER = "owner@1on1.example";
const DANA = "dana@1on1.example";
const EVE = "eve@1on1.example";
const GATE = { BOPS_LOGIN_GATE: "google", BOPS_GATE_SECRET: "x".repeat(40), BOPS_ALLOWED_EMAILS: "@1on1.example", GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", BOPS_PUBLIC_URL: "https://bops.example", BOPS_OWNER_EMAILS: OWNER };
const cfg = gateConfig(GATE);
if (!cfg || cfg === "misconfigured") throw new Error("test config");

const KEY = "url:https://1on1realtors.com/property/third-urban";
const RID = "0123456789abcdef01234567";

/** A strong lead (score 90) for a sale ask in Maraval, held by agent 7 unless overridden. */
const LEAD = (over: Partial<LeadInput> = {}, ask: Partial<LeadInput["ask"]> = {}, listing: Partial<LeadInput["listing"]> = {}): LeadInput => ({
  score: 90,
  reason: "Same area (Maraval), 3 beds as asked, TT$3.7m within TT$4.3m budget, posted today",
  listingKey: KEY,
  ask: {
    postId: RID,
    area: "Maraval",
    beds: 3,
    budget: 4_300_000,
    currency: "TTD",
    type: "townhouse",
    listingType: "sale",
    lastSeenAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    senderName: "Dana Tester",
    firm: "Test Realty Co",
    senderPhone: "+18685550199",
    ...ask,
  },
  listing: { title: "THIRD URBAN", url: "https://1on1realtors.com/property/third-urban", price: 3_700_000, currency: "TTD", ttdEquiv: null, agentId: 7, agentName: "Dana Holder", ...listing },
  ...over,
});

const AGENT_ME = { owner: false, agentId: 7 };
const OWNER_ME = { owner: true, agentId: null };

/* ---------------- Message text ---------------- */

test("the message is a lead from the office: it never names a WhatsApp group, scanning, monitoring or Bops", () => {
  const cases = [LEAD(), LEAD({}, { senderName: null, budget: null, beds: null, type: null }), LEAD({}, { currency: "USD", budget: 650_000, listingType: "rent", senderName: "Eve" }), LEAD({}, {}, { url: null, price: null })];
  for (const r of cases) {
    const m = leadMessage(r);
    assert.doesNotMatch(m, /whatsapp|group|scan|monitor|bops|periskope|automatch/i, m);
  }
});

test("the suggested message reads like the example: a first name, the ask, the listing, its link and a viewing", () => {
  assert.equal(
    leadMessage(LEAD()),
    "Hi Dana, I hear you have a client looking for a 3 bed townhouse in Maraval around TT$4.3m. I have Third Urban at TT$3.7m: https://1on1realtors.com/property/third-urban. Happy to set up a viewing.",
  );
});

test("with no usable name the greeting is just \"Hi,\", and with no listing link there's no link", () => {
  const m = leadMessage(LEAD({}, { senderName: "+1 868 555 0199" }, { url: null }));
  assert.match(m, /^Hi, I hear you/);
  assert.doesNotMatch(m, /https?:\/\//);
  assert.equal(firstNameOf("Dana Tester"), "Dana");
  assert.equal(firstNameOf("  Émile  "), "Émile");
  assert.equal(firstNameOf("+1 868 555 0199"), null);
  assert.equal(firstNameOf("A"), null);
  assert.equal(firstNameOf(null), null);
});

test("a USD ask and a rent say so: the money in US$ with TT$, and a month for a rent", () => {
  assert.match(askLine(LEAD({}, { currency: "USD", budget: 650_000 }).ask), /^Looking to buy a 3-bed townhouse in Maraval, asked in US\$ \(US\$650k ≈ TT\$/);
  const rent = leadMessage(LEAD({}, { listingType: "rent", budget: 9000, currency: "TTD" }, { price: 9000 }));
  assert.match(rent, /looking for a 3 bed townhouse in Maraval around TT\$9,000 a month/);
  assert.match(rent, /I have Third Urban at TT\$9,000 a month/);
});

test("the plain ask line: beds, the kind of place, the area and the budget; without a budget, no budget clause", () => {
  assert.equal(askLine(LEAD().ask), "Looking to buy a 3-bed townhouse in Maraval, around TT$4.3m");
  assert.equal(askLine(LEAD({}, { budget: null, beds: null, type: null }).ask), "Looking to buy a property in Maraval");
});

/* ---------------- Short listing titles ---------------- */

test("ALL CAPS cleanup: the development is title-cased, with the structured area, beds and type added", () => {
  assert.equal(
    shortListingTitle({ title: "WEST HILLS, PETIT VALLEY 3BR Apartment For Sale", area: "Petit Valley", beds: 3, type: "apartment" }),
    "West Hills, Petit Valley, 3-bed apartment",
  );
  assert.equal(shortListingTitle({ title: "NEWBURY HILL EXTENSION", area: "Glencoe", beds: 3, type: null }), "Newbury Hill Extension, Glencoe, 3-bed");
  assert.equal(shortListingTitle({ title: "WEST INDIES OF TOBAGO" }), "West Indies of Tobago", "small connectors stay small");
  assert.equal(shortListingTitle({ title: "D'ARCY ST-JAMES" }), "D'Arcy St-James", "apostrophes and hyphens start a new capital");
});

test("boilerplate is stripped: for sale, for rent, for-sale, 3BR, 3 BR, 3-bed, bedroom, the type words, the price and trailing punctuation", () => {
  assert.equal(shortListingTitle({ title: "THIRD URBAN For Sale" }), "Third Urban");
  assert.equal(shortListingTitle({ title: "Westmoorings for-sale" }), "Westmoorings");
  assert.equal(shortListingTitle({ title: "Westmoorings FOR RENT" }), "Westmoorings");
  assert.equal(shortListingTitle({ title: "Westmoorings 3 BR" }), "Westmoorings, 3-bed", "the bed count is kept as beds, not as words");
  assert.equal(shortListingTitle({ title: "Westmoorings 3-bed" }), "Westmoorings, 3-bed");
  assert.equal(shortListingTitle({ title: "Westmoorings - 3BR Townhouse for-sale" }), "Westmoorings, 3-bed townhouse", "the title's beds and type are read, with no structured fields");
  assert.equal(shortListingTitle({ title: "Glencoe, 2 Bedroom Condo," }), "Glencoe, 2-bed condo");
  assert.equal(shortListingTitle({ title: "THIRD URBAN TT$3.7M" }), "Third Urban", "the price is never in the short title");
  assert.doesNotMatch(shortListingTitle({ title: "THIRD URBAN TT$3.7M", beds: 3, area: "Glencoe" }), /TT|\$|3\.7/);
});

test("nothing is said twice: an area already in the name, and beds or a type the title already carries", () => {
  assert.equal(shortListingTitle({ title: "3 bed apartment Westmoorings", area: "Westmoorings", beds: 3, type: "apartment" }), "Westmoorings, 3-bed apartment");
  assert.equal(shortListingTitle({ title: "Maraval 3 bed", area: "Maraval", beds: 3 }), "Maraval, 3-bed");
  assert.equal(shortListingTitle({ title: "WEST HILLS, PETIT VALLEY", area: "Petit Valley" }), "West Hills, Petit Valley");
  assert.equal(shortListingTitle({ title: "Westmoorings Heights", area: "Westmoorings", beds: 2 }), "Westmoorings Heights, 2-bed", "the area is a word already in the name");
  assert.equal(shortListingTitle({ title: "THIRD URBAN", beds: 3, type: "townhouse" }), "Third Urban, 3-bed townhouse");
});

test("missing fields: a name alone is the name; no name falls back to the area and beds; nothing at all is 'Listing'", () => {
  assert.equal(shortListingTitle({ title: "THIRD URBAN", area: null, beds: null, type: null }), "Third Urban");
  assert.equal(shortListingTitle({ title: "THIRD URBAN", area: "Glencoe", beds: null, type: null }), "Third Urban, Glencoe");
  assert.equal(shortListingTitle({ title: "", area: "Maraval", beds: 2, type: "townhouse" }), "Maraval, 2-bed townhouse");
  assert.equal(shortListingTitle({ title: "" }), "Listing");
  assert.equal(shortListingTitle({ title: "   " }), "Listing");
});

test("a street from the address is the name when the title has none, shortened; a long address is never dumped", () => {
  assert.equal(
    shortListingTitle({ title: "", address: "12 Lady Chancellor Road, Maraval", area: "Maraval", beds: 2, type: "apartment" }),
    "Lady Chancellor Road, Maraval, 2-bed apartment",
  );
  assert.equal(shortListingTitle({ title: "", address: "12-14 Lady Chancellor Road, Maraval", area: "Maraval" }), "Lady Chancellor Road, Maraval");
  const long = "Some Very Long Development Name That Goes On And On Forever Road, Maraval";
  assert.equal(shortListingTitle({ title: "", address: long, area: "Maraval" }), "Maraval", "too long for a name: the area stands alone");
});

test("land with no beds: the type word is land and no beds are said", () => {
  assert.equal(shortListingTitle({ title: "LOT 5 GASPAREE LAND FOR SALE", area: "Gasparee", beds: null }), "Lot 5 Gasparee, land");
  assert.equal(shortListingTitle({ title: "Gasparee Land", area: "Gasparee", beds: null, type: "land" }), "Gasparee, land", "the type word is not repeated in the name");
  assert.equal(listingTypeWord("LOT 5 GASPAREE LAND FOR SALE", null), "land");
  assert.equal(listingTypeWord("THIRD URBAN", "commercial"), "commercial", "the CRM's kind counts when the title has no type word");
  assert.equal(listingTypeWord("THIRD URBAN", "rental"), null, "a rental or a sale isn't a type word");
});

test("leadMessage and the card use the short title, and the message still never names a group, scanning, or Bops", () => {
  const withFields = LEAD({}, {}, { title: "WEST HILLS, PETIT VALLEY 3BR Apartment For Sale", area: "Petit Valley", beds: 3, type: "apartment" });
  const m = leadMessage(withFields);
  assert.match(m, /I have West Hills, Petit Valley, 3-bed apartment at TT\$3\.7m: https:\/\/1on1realtors\.com\/property\/third-urban\. Happy/);
  assert.doesNotMatch(m, /WEST HILLS|3BR/);
  assert.doesNotMatch(m, /whatsapp|group|scan|monitor|bops|periskope|automatch/i);
  const card = leadsView([withFields], { owner: true, agentId: null, statuses: [], firstSeen: [], now: NOW }).cards[0];
  assert.equal(card.listing.title, "West Hills, Petit Valley, 3-bed apartment", "the card label agrees with the message");
  assert.equal(card.message, m);
});

test("the card id is stable for the same pair, and differs between listings", () => {
  const id = leadCardId(RID, KEY);
  assert.equal(id, leadCardId(RID, KEY));
  assert.match(id, /^lead-[0-9a-f]{24}-[0-9a-f]{8}$/);
  assert.notEqual(id, leadCardId(RID, "url:https://x.example/b"));
  assert.equal(new URL(`https://bop.example/realty/desk#${id}`).hash, `#${id}`, "a plain fragment: no escaping needed");
});

/* ---------------- wa.me link ---------------- */

test("the wa.me link is the sender's digits only, with the message encoded", () => {
  assert.equal(waUrlFor("+1 (868) 555-0101", "Hi, a b&c"), "https://wa.me/18685550101?text=Hi%2C%20a%20b%26c");
  assert.equal(waUrlFor("+18685550101", "Hi"), "https://wa.me/18685550101?text=Hi");
  assert.equal(waUrlFor("+18685550101", "Hi!\n"), "https://wa.me/18685550101?text=Hi!%0A");
});

test("no usable number, no link: empty, too short, or too long", () => {
  assert.equal(waUrlFor("", "Hi"), null);
  assert.equal(waUrlFor("555-01", "Hi"), null, "fewer than 7 digits");
  assert.equal(waUrlFor("+1 868 555 0101 0000 00", "Hi"), null, "more than 15 digits");
  assert.equal(waUrlFor("abc", "Hi"), null);
});

/* ---------------- Statuses ---------------- */

test("the statuses: the three old values stay valid, and viewing-booked and already-in-touch are added, each with a label", () => {
  assert.deepEqual([...MATCH_STATUSES], ["contacted", "viewing-booked", "not-a-fit", "already-in-touch", "closed"]);
  assert.equal(STATUS_LABEL["viewing-booked"], "Viewing booked");
  assert.equal(STATUS_LABEL["already-in-touch"], "Already in touch");
  for (const s of MATCH_STATUSES) {
    const parsed = parseStatusPost({ requestId: RID, listingKey: KEY, status: s });
    assert.ok(parsed.ok, s);
  }
  assert.equal(parseStatusPost({ requestId: RID, listingKey: KEY, status: "bogus" }).ok, false);
});

test("the new statuses apply like the others: the same again changes nothing, a different one overwrites, and null clears", () => {
  let rows: StatusRow[] = [];
  const set = (status: StatusRow["status"] | null, by = DANA) => {
    const r = applyStatus(rows, { requestId: RID, listingKey: KEY, status, by, at: NOW.toISOString() });
    rows = r.rows;
    return r.changed;
  };
  assert.equal(set("viewing-booked"), true);
  assert.equal(set("viewing-booked", EVE), false, "same again: the first setter stays");
  assert.equal(set("already-in-touch"), true);
  assert.equal(rows[0].status, "already-in-touch");
  assert.equal(set(null), true);
  assert.deepEqual(rows, []);
});

test("hidden: not a fit and closed only; viewing booked, already in touch and contacted stay on the card", () => {
  const f = (status: StatusRow["status"]) => ({ status, by: DANA, at: NOW.toISOString() });
  assert.equal(isHidden(f("not-a-fit")), true);
  assert.equal(isHidden(f("closed")), true);
  assert.equal(isHidden(f("viewing-booked")), false);
  assert.equal(isHidden(f("already-in-touch")), false);
  assert.equal(isHidden(f("contacted")), false);
  assert.equal(isHidden(undefined), false);
});

/* ---------------- Visibility ---------------- */

test("visibility: the holder sees their own listing's card; an owner sees all; another agent sees none", () => {
  assert.equal(canSeeLead(AGENT_ME, 7), true);
  assert.equal(canSeeLead(AGENT_ME, 8), false, "another agent's listing");
  assert.equal(canSeeLead({ owner: false, agentId: 8 }, 7), false);
  assert.equal(canSeeLead(OWNER_ME, 7), true);
  assert.equal(canSeeLead(OWNER_ME, null), true);
});

test("visibility: an unassigned listing (office) is for owners only; a non-agent non-owner sees nothing", () => {
  assert.equal(canSeeLead({ owner: false, agentId: null }, null), false, "a non-agent never matches office");
  assert.equal(canSeeLead(AGENT_ME, null), false, "an agent doesn't get the office's cards");
  assert.equal(canSeeLead(OWNER_ME, null), true);
  const office = LEAD({ listing: { ...LEAD().listing, agentId: null, agentName: null } });
  const forAgent = leadsView([office], { owner: false, agentId: 7, statuses: [], firstSeen: [], now: NOW });
  assert.deepEqual(forAgent.cards, []);
  const forOwner = leadsView([office], { owner: true, agentId: null, statuses: [], firstSeen: [], now: NOW });
  assert.equal(forOwner.cards.length, 1);
  assert.equal(forOwner.cards[0].listing.agent, "Office");
});

test("only strong rows make cards, and a row with no request id makes none", () => {
  const fair = LEAD({ score: 70 });
  const noId = LEAD({}, { postId: null });
  const v = leadsView([fair, noId, LEAD()], { owner: true, agentId: null, statuses: [], firstSeen: [], now: NOW });
  assert.equal(v.cards.length, 1);
  assert.equal(v.cards[0].score, 90);
});

test("not a fit and closed are hidden and counted; show hidden brings them back; viewing booked stays visible", () => {
  const rows = [LEAD(), LEAD({ listingKey: "url:https://x.example/b", listing: { ...LEAD().listing, url: "https://x.example/b", title: "B" } })];
  const statuses: StatusRow[] = [
    { requestId: RID, listingKey: KEY, status: "not-a-fit", by: DANA, at: NOW.toISOString() },
    { requestId: RID, listingKey: "url:https://x.example/b", status: "viewing-booked", by: DANA, at: NOW.toISOString() },
  ];
  const base = { owner: true, agentId: null, statuses, firstSeen: [], now: NOW };
  const hidden = leadsView(rows, base);
  assert.equal(hidden.hidden, 1);
  assert.deepEqual(hidden.cards.map((c) => c.listingKey), ["url:https://x.example/b"]);
  const all = leadsView(rows, { ...base, showHidden: true });
  assert.equal(all.hidden, 0);
  assert.equal(all.cards.length, 2);
});

/* ---------------- Stale ---------------- */

test("match time is the later of the ask's last seen and when Bops first saw the pair", () => {
  const seen = new Date(NOW.getTime() - 3 * 24 * HOUR).toISOString();
  const first = new Date(NOW.getTime() - HOUR).toISOString();
  assert.equal(matchedAt(seen, first), first, "a new listing matching an old ask counts from when it was first seen");
  assert.equal(matchedAt(seen, null), seen, "with no first-seen record, the ask's last seen stands");
  const later = new Date(NOW.getTime() - 5 * 24 * HOUR).toISOString();
  assert.equal(matchedAt(seen, later), seen);
});

test("stale: no outcome and at least two hours since the match; an outcome (even contacted) clears it", () => {
  const at = new Date(NOW.getTime() - LEAD_STALE_MS).toISOString();
  assert.equal(LEAD_STALE_MS, 2 * HOUR);
  assert.equal(isStale(at, null, NOW), true, "exactly two hours, no outcome");
  assert.equal(isStale(new Date(NOW.getTime() - HOUR).toISOString(), null, NOW), false, "one hour is not stale");
  const follow = { status: "contacted" as const, by: DANA, at };
  assert.equal(isStale(at, follow, NOW), false, "contacted is an outcome");
});

test("the card carries the stale label from the rule; the clock is the later of the ask's last seen and the first sighting", () => {
  const old = new Date(NOW.getTime() - 5 * 24 * HOUR).toISOString();
  const first: MatchSeenRow = { requestId: RID, listingKey: KEY, at: new Date(NOW.getTime() - 3 * HOUR).toISOString() };
  const v = leadsView([LEAD({}, { lastSeenAt: old })], { owner: true, agentId: null, statuses: [], firstSeen: [first], now: NOW });
  assert.equal(v.cards[0].stale, true, "an old ask matched by a new listing three hours ago is stale");
  assert.equal(v.cards[0].matchedAt, first.at);
  const fresh = leadsView([LEAD({}, { lastSeenAt: old })], { owner: true, agentId: null, statuses: [], firstSeen: [{ ...first, at: new Date(NOW.getTime() - HOUR).toISOString() }], now: NOW });
  assert.equal(fresh.cards[0].stale, false, "one hour is not stale");
  const recentAsk = leadsView([LEAD()], { owner: true, agentId: null, statuses: [], firstSeen: [first], now: NOW });
  assert.equal(recentAsk.cards[0].matchedAt, LEAD().ask.lastSeenAt, "a fresher ask than its first sighting counts from its last seen");
});

test("the card's wa link is null when the ask has no usable number", () => {
  const v = leadsView([LEAD({}, { senderPhone: "" })], { owner: true, agentId: null, statuses: [], firstSeen: [], now: NOW });
  assert.equal(v.cards[0].waUrl, null);
});

/* ---------------- Node side: the owner's and the agent's view, the route ---------------- */

const LISTING = (over: Partial<Listing> = {}): Listing => ({
  id: "1",
  title: "Test flat, Westmoorings",
  listingType: "rent",
  area: "Westmoorings",
  price: 9000,
  currency: "TTD",
  beds: 2,
  baths: 1,
  agentId: 7,
  status: "active",
  url: "https://1on1realtors.com/property/test-flat-westmoorings",
  ...over,
});

const PLACES = [{ name: "Westmoorings", region: "North West" as const, neighbours: ["Glencoe"] }, { name: "Glencoe", region: "North West" as const, neighbours: ["Westmoorings"] }];
const AREAS = new MemoryAreaResolver(PLACES);

const DANA_AGENT: SeamAgent = { id: 7, name: "Dana Holder", email: DANA, phone: null };
const EVE_AGENT: SeamAgent = { id: 8, name: "Eve Other", email: EVE, phone: null };

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

/** A demand post as the Periskope intake writes it: a strong pair against a listing held by agent 7. Invented data. */
const DEMAND_ROW = {
  messageId: "msg-demand-1",
  chatId: "chat-test@g.us",
  groupName: "Test Group A",
  sentAt: ago(2 * 24 * HOUR),
  category: "buyer_request",
  senderPhone: "+18685550199",
  senderName: "Test Renter",
  area: "Westmoorings",
  price: 9000,
  currency: "TTD",
  beds: 2,
  type: "apartment",
  listingType: "rent",
  originalText: "Looking to rent a 2 bed apartment in Westmoorings, up to TT$9,000",
};
const REQUEST = requestIdOf("msg-demand-1");

function storeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "automatch-leads-"));
  writeFileSync(join(root, "demand.jsonl"), `${JSON.stringify(DEMAND_ROW)}\n`);
  return root;
}

function fakeSeam(listings: Listing[], agents: SeamAgent[]): CrmSeam {
  return {
    connected: true,
    async listings() {
      return { status: "ok", listings };
    },
    async agents() {
      return agents;
    },
  };
}

const GATE_OWNER_AND_AGENTS = (seam: CrmSeam, root: string) => ({ seam, root, areas: AREAS, now: NOW });

/** Who the staff route is signed in as. */
const route = async (body: unknown, email: string | null, root: string, seam: CrmSeam, env: Record<string, string> = GATE) =>
  setMatchFollowUp(
    new Request("https://bops.example/api/realty/match-status", {
      method: "POST",
      headers: { "content-type": "application/json", ...(email ? { cookie: `${GATE_COOKIE}=${await makeSession(email, cfg)}` } : {}) },
      body: JSON.stringify(body),
    }),
    { env, seam, root, areas: AREAS, now: () => NOW },
  );

test("an agent sees their own listing's lead, and an owner sees every lead; the lead's listing key matches the route's", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING()], [DANA_AGENT, EVE_AGENT]);
  const mine = await staffLeads({ email: DANA, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) });
  assert.equal(mine.cards.length, 1);
  assert.equal(mine.cards[0].requestId, REQUEST);
  assert.equal(mine.cards[0].listing.agent, "Dana Holder");
  assert.equal(mine.cards[0].sender.phone, "+18685550199", "the number is shown on the card");
  assert.ok(mine.cards[0].waUrl?.startsWith("https://wa.me/18685550199?text="));

  const other = await staffLeads({ email: EVE, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) });
  assert.deepEqual(other.cards, [], "another agent doesn't see Dana's listing");
  const none = await staffLeads({ email: null, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) });
  assert.deepEqual(none.cards, [], "a signed-out or non-agent viewer sees nothing");
  const owner = await staffLeads({ email: OWNER, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) });
  assert.equal(owner.cards.length, 1);
});

test("an unassigned listing shows as Office and is for owners only", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING({ agentId: 0 })], [DANA_AGENT]);
  const owner = await staffLeads({ email: OWNER, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) });
  assert.equal(owner.cards[0]?.listing.agent, "Office");
  const agent = await staffLeads({ email: DANA, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) });
  assert.deepEqual(agent.cards, []);
});

test("first sight of a pair is recorded once, in Bops's own store, and the stale clock reads it", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING()], [DANA_AGENT]);
  await staffLeads({ email: OWNER, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) });
  await staffLeads({ email: OWNER, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root), now: new Date(NOW.getTime() + HOUR) });
  const store = new PeriskopeStore(root);
  assert.equal(store.matchSeenRows().length, 1, "one row per pair");
  assert.equal(store.matchSeenRows()[0].at, NOW.toISOString(), "the first sighting stands");
});

test("stale on the desk: a card with no outcome two hours after its match is labelled; an outcome clears it", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING()], [DANA_AGENT]);
  await staffLeads({ email: DANA, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) });
  const later = new Date(NOW.getTime() + 2 * HOUR);
  const stale = await staffLeads({ email: DANA, env: GATE, seam, root, areas: AREAS, now: later });
  assert.equal(stale.cards[0].stale, true);
  new PeriskopeStore(root).setMatchStatus({ requestId: REQUEST, listingKey: stale.cards[0].listingKey, status: "contacted", by: DANA, at: later.toISOString() });
  const after = await staffLeads({ email: DANA, env: GATE, seam, root, areas: AREAS, now: later });
  assert.equal(after.cards[0].stale, false);
  assert.equal(after.cards[0].follow?.status, "contacted");
});

test("leadAccess: the holder and an owner may set the outcome; another agent may not; a listing with no agent is the owner's", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING()], [DANA_AGENT, EVE_AGENT]);
  const key = (await automatchRun({ ...GATE_OWNER_AND_AGENTS(seam, root), env: GATE })).result.pairs[0].listingKey;
  assert.equal((await leadAccess(REQUEST, key, { email: DANA, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) }))?.allowed, true);
  assert.equal((await leadAccess(REQUEST, key, { email: OWNER, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) }))?.allowed, true);
  assert.equal((await leadAccess(REQUEST, key, { email: EVE, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) }))?.allowed, false);
  assert.equal(await leadAccess("ffffffffffffffffffffffff", key, { email: DANA, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) }), null);
});

test("the route: the holder sets an outcome on a lead and the record has their email; another agent gets 403; an owner may", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING()], [DANA_AGENT, EVE_AGENT]);
  const key = (await automatchRun({ ...GATE_OWNER_AND_AGENTS(seam, root), env: GATE })).result.pairs[0].listingKey;
  const body = { requestId: REQUEST, listingKey: key, status: "viewing-booked" };
  assert.equal((await route(body, EVE, root, seam)).status, 403);
  const mine = await route(body, DANA, root, seam);
  assert.equal(mine.status, 200);
  assert.equal(new PeriskopeStore(root).matchStatuses()[0].by, DANA);
  assert.equal((await route({ ...body, status: "already-in-touch" }, OWNER, root, seam)).status, 200);
  assert.equal(new PeriskopeStore(root).matchStatuses()[0].status, "already-in-touch");
  assert.equal((await route(body, null, root, seam)).status, 401, "signed out");
});

test("the route: a listing with no agent is for owners only", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING({ agentId: 0 })], [DANA_AGENT]);
  const key = (await automatchRun({ ...GATE_OWNER_AND_AGENTS(seam, root), env: GATE })).result.pairs[0].listingKey;
  const body = { requestId: REQUEST, listingKey: key, status: "contacted" };
  assert.equal((await route(body, DANA, root, seam)).status, 403);
  assert.equal((await route(body, OWNER, root, seam)).status, 200);
});

test("the route still refuses what isn't on the desk or in an Automatch lead", async () => {
  const root = storeRoot();
  const seam = fakeSeam([LISTING()], [DANA_AGENT]);
  assert.equal((await route({ requestId: "ffffffffffffffffffffffff", listingKey: KEY, status: "contacted" }, OWNER, root, seam)).status, 404);
});

test("nothing new calls fetch: the lead code is read and checked, and the route runs with fetch refused", async () => {
  const files = ["../flow/automatch-leads.ts", "../node/automatch-leads.ts", "../../app/realty/desk/lead-cards.tsx"];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(/, f);
  }
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("no network in tests");
  }) as typeof fetch;
  try {
    const root = storeRoot();
    const seam = fakeSeam([LISTING()], [DANA_AGENT]);
    await staffLeads({ email: DANA, env: GATE, ...GATE_OWNER_AND_AGENTS(seam, root) });
    assert.equal((await route({ requestId: REQUEST, listingKey: (await automatchRun({ ...GATE_OWNER_AND_AGENTS(seam, root), env: GATE })).result.pairs[0].listingKey, status: "contacted" }, DANA, root, seam)).status, 200);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = real;
  }
});
