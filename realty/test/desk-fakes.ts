import type { ToolCaller } from "../flow/areas.ts";

/**
 * Fakes for the staff desk tests: a ToolCaller that records calls, and a fake fetch that speaks the market's Streamable
 * HTTP JSON-RPC (initialize, the initialized notice, tools/call) through MarketClient. No network: the fetch global is
 * never used. Not a test file (no .test.ts), so the runner doesn't pick it up.
 */

/** A tools/call result the way the market sends it: a spoken summary, then the JSON block. */
export const reply = (payload: unknown) => ({
  content: [
    { type: "text", text: "A spoken summary." },
    { type: "text", text: JSON.stringify(payload) },
  ],
});

/** What a fake tool answers: a payload (wrapped as a reply), a ready result, or an Error to throw. */
export type Answer = unknown | Error | ((args: Record<string, unknown>) => unknown);

export type Call = { tool: string; args: Record<string, unknown> };

/** A ToolCaller that answers by tool name and records every call. A tool with no answer returns no hits. */
export function fakeCaller(answers: Record<string, Answer> = {}) {
  const calls: Call[] = [];
  const caller: ToolCaller = {
    async callTool(name, args) {
      calls.push({ tool: name, args });
      const a = answers[name];
      if (a instanceof Error) throw a;
      if (typeof a === "function") return reply((a as (args: Record<string, unknown>) => unknown)(args));
      return reply(a ?? { total: 0, hits: [] });
    },
  };
  return { caller, calls, tools: () => [...new Set(calls.map((c) => c.tool))].sort() };
}

/*
 * Fixture hits, shaped like the market's. The private fields (names, phones, group_ref, source_message_id, notes) are
 * here on purpose: the tests check that none of them reach a row or a view. All numbers and names are made up.
 */

/** A rent request, sent by WhatsApp. */
export const REQ_RENT = {
  id: "req-101",
  received_at: "2026-11-12T14:05:00Z",
  created_at: "2026-11-12T14:06:00Z",
  intent: "rent",
  area: "Westmoorings",
  region: "North West",
  island: "Trinidad",
  property_type: "apartment",
  beds_min: 2,
  baths_min: 1,
  price_min: null,
  price_max: 9000,
  currency: "TTD",
  status: "open",
  sender_agency: "Example Realty",
  source: "whatsapp",
  buyer_name: "Ava Fixture",
  seller_name: "Sam Fixture",
  sender_phone: "+1 868 555 0199",
  source_message_id: "msg-SECRET-42",
  group_ref: "grp-SECRET-7781",
  notes: "Ava Fixture, call +1 868 555 0199 after six",
  area_id: 12,
};

/** A buy request. */
export const REQ_BUY = {
  id: "req-102",
  received_at: "2026-11-11T09:00:00Z",
  intent: "buy",
  area: "Maraval",
  property_type: "townhouse",
  beds_min: 3,
  price_min: 2000000,
  price_max: 2500000,
  currency: "TTD",
  status: "open",
  sender_agency: null,
  buyer_name: "Bo Fixture",
  sender_phone: "+1 868 555 0198",
  source_message_id: "msg-SECRET-43",
  group_ref: "grp-SECRET-7782",
  notes: "Bo Fixture 868 555 0198",
};

/** A USD rent request, with the price as text (the market can send decimals that way). */
export const REQ_USD = {
  id: "req-103",
  received_at: "2026-11-13T08:00:00Z",
  intent: "rent",
  area: "Glencoe",
  price_max: "15000",
  currency: "USD",
  status: "open",
  sender_agency: "Other Agency",
  buyer_name: "Cy Fixture",
  source_message_id: "msg-SECRET-44",
  group_ref: "grp-SECRET-7783",
};

/** A request with no intent: match_buyer can't take it. */
export const REQ_NO_INTENT = { id: "req-104", received_at: "2026-11-13T10:00:00Z", area: "Woodbrook", status: "open" };

/** An older buy request: outside the newest three. */
export const REQ_OLD = { id: "req-105", received_at: "2026-11-01T09:00:00Z", intent: "buy", area: "Woodbrook", status: "open" };

/** A match routed to an agent (route_to is private: it must not reach a view). It carries a score and a grade. */
export const MATCH_ROUTED = {
  title: "3 bed townhouse, Maraval",
  url: "https://other.example/listing/1",
  area: "Maraval",
  price: 2300000,
  currency: "TTD",
  beds: 3,
  source: "otheragency",
  match_reason: "Same area and budget; 3 beds as asked.",
  score: 0.92,
  grade: "A",
  route_to: "agent-private-7",
};

/** A match with nobody routed to it yet. The real tool always sets route_to; "unassigned" means no agent. The reason has a phone number and an email in it. */
export const MATCH_UNASSIGNED = {
  title: "Unassigned flat, Westmoorings",
  url: "https://other.example/listing/2",
  area: "Westmoorings",
  price: "TTD 8,500",
  beds: 2,
  source: "otheragency",
  match_reason: "Call +1 868 555 0199 or ava@example.com about the 2-bed flat",
  score: 0.7,
  grade: "B",
  route_to: "unassigned",
};

/** The live Match shape from tt-market-search: listing_ref, reason, recommended_contact, no title/url/area/price. */
export const MATCH_LIVE = {
  listing_ref: "src:listing-9",
  buyer_ref: "req-101",
  score: 0.81,
  reason: "Fits the budget in Westmoorings.",
  reasons: ["area", "budget"],
  recommended_contact: { url: "https://other.example/listing/9", agency: "Other Agency", phone: "868-555-0000" },
  route_to: "unassigned",
};

const sse = (msg: unknown) => `event: message\ndata: ${JSON.stringify(msg)}\n\n`;

/**
 * A fake market over fetch, for MarketClient. `answers` is by tool name, as fakeCaller's. `http` makes every call answer
 * with that HTTP status; `throws` makes every fetch throw (a timeout, say). Records each tools/call.
 */
export function fakeMarketFetch(o: { answers?: Record<string, Answer>; http?: number; throws?: Error } = {}) {
  const calls: Call[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (o.throws) throw o.throws;
    if (o.http) return new Response("nope", { status: o.http });
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") {
      return new Response(sse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } }), {
        status: 200,
        headers: { "content-type": "text/event-stream", "mcp-session-id": "session-test" },
      });
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    const { name, arguments: args } = body.params as { name: string; arguments: Record<string, unknown> };
    calls.push({ tool: name, args });
    const a = o.answers?.[name];
    if (a instanceof Error) {
      return new Response(sse({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "boom" }] } }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    const payload = typeof a === "function" ? (a as (args: Record<string, unknown>) => unknown)(args) : (a ?? { total: 0, hits: [] });
    return new Response(sse({ jsonrpc: "2.0", id: body.id, result: reply(payload) }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { fetcher, calls, tools: () => [...new Set(calls.map((c) => c.tool))].sort() };
}
