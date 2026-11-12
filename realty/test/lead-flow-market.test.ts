import assert from "node:assert/strict";
import { test } from "node:test";
import { LeadFlow } from "../flow/flow.ts";
import { hitsFromToolResult, MarketSearch, rpcResult, sseMessages, type MarketCriteria } from "../flow/market-search.ts";
import { DryRunOutbox } from "../flow/outbox.ts";
import { FixtureCrm } from "../flow/source.ts";

/** The co-broke client against a stubbed fetch: SSE and JSON replies, auth, session, filtering, failure. */

const TOKEN = "test-token-not-real-0123";
const criteria: MarketCriteria = { listingType: "rent", area: "Woodbrook", maxPrice: { amount: 9000, currency: "TTD" }, beds: 2 };

const sse = (msg: unknown) => `event: message\ndata: ${JSON.stringify(msg)}\n\n`;

const toolPayload = {
  total: 3,
  hits: [
    { title: "Two-bed flat, Woodbrook", price: 8000, currency: "TTD", area: "Woodbrook", beds: 2, baths: 1, listing_type: "rent", source: "otheragency", url: "https://example.com/a/1" },
    { title: "Our own listing", price: 7000, currency: "TTD", area: "Woodbrook", beds: 2, baths: 1, listing_type: "rent", source: "oneonone", url: "https://example.com/ours" },
    { title: "Bad link", price: 8500, currency: "TTD", area: "Woodbrook", beds: 2, baths: 2, listing_type: "rent", source: "anotheragency", url: "javascript:alert(1)" },
  ],
};

/** A fake MCP server: answers initialize (with a session id), accepts the initialized notice, answers tools/call. */
function fakeServer(opts: { toolReply?: (id: number) => Response; status?: number } = {}) {
  const calls: { method: string; headers: Record<string, string>; body: { method: string; id?: number; params?: { arguments?: unknown } } }[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const headers = Object.fromEntries(Object.entries(init?.headers as Record<string, string>));
    calls.push({ method: body.method, headers, body });
    if (opts.status) return new Response("nope", { status: opts.status });
    if (body.method === "initialize") {
      return new Response(sse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } }), {
        status: 200,
        headers: { "content-type": "text/event-stream", "mcp-session-id": "session-abc" },
      });
    }
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/call") {
      if (opts.toolReply) return opts.toolReply(body.id);
      return new Response(
        sse({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "Found 3 listings in Woodbrook." }, { type: "text", text: JSON.stringify(toolPayload) }] },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    throw new Error(`unexpected ${body.method}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

const cfg = { url: "http://127.0.0.1:8787/mcp", token: TOKEN, timeoutMs: 2000 };

test("parses an SSE reply: data lines, keep-alives skipped, the reply with the matching id", () => {
  const body = `: keep-alive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\ndata: not json\n\n`;
  assert.deepEqual(sseMessages(body).length, 1);
  assert.deepEqual(rpcResult(body, 7), { ok: true });
  assert.throws(() => rpcResult(body, 8), /no reply/);
});

test("a plain JSON reply and a JSON-RPC error both parse", () => {
  assert.deepEqual(rpcResult(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { x: 1 } }), 2), { x: 1 });
  assert.throws(() => rpcResult(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -1 } }), 2), /server error/);
});

test("hits come from the tool's JSON text block; our own listings and unsafe links are dropped", () => {
  const hits = hitsFromToolResult({ content: [{ type: "text", text: "a spoken summary" }, { type: "text", text: JSON.stringify(toolPayload) }] });
  assert.deepEqual(hits.map((h) => h.title), ["Two-bed flat, Woodbrook", "Bad link"]);
  assert.equal(hits[0].listingType, "rent");
  assert.equal(hits[0].source, "otheragency");
  assert.equal(hits[1].url, null, "a javascript: link is never shown");
  assert.deepEqual(hitsFromToolResult({ content: [{ type: "text", text: "no json here" }] }), []);
});

test("hits are capped at five", () => {
  const many = { hits: Array.from({ length: 9 }, (_, i) => ({ title: `Listing ${i}`, source: "agency" })) };
  assert.equal(hitsFromToolResult({ content: [{ type: "text", text: JSON.stringify(many) }] }).length, 5);
});

test("a search runs initialize, the initialized notice, then tools/call, with the bearer token and the session", async () => {
  const { fetcher, calls } = fakeServer();
  const r = await new MarketSearch(cfg, fetcher).search(criteria);
  assert.deepEqual(calls.map((c) => c.method), ["initialize", "notifications/initialized", "tools/call"]);
  for (const c of calls) {
    assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(c.headers.accept, "application/json, text/event-stream");
  }
  assert.equal(calls[2].headers["mcp-session-id"], "session-abc");
  assert.equal((calls[2].body.params as { name: string }).name, "search_market_listings");
  assert.deepEqual((calls[2].body.params as { arguments: unknown }).arguments, { limit: 10, listing_type: "rent", area: "Woodbrook", price_max: 9000, beds_min: 2 });
  assert.equal(r.hits.length, 2);
  assert.equal(r.note, "2 from other agencies");
});

test("the token never shows up in what comes back, even when the search fails", async () => {
  const { fetcher } = fakeServer({ status: 500 });
  const r = await new MarketSearch(cfg, fetcher).search(criteria);
  assert.deepEqual(r.hits, []);
  assert.equal(r.note, "other agencies not checked (unavailable)");
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test("a timeout gives no candidates and a note, never an error", async () => {
  const timeoutFetch = (async () => {
    const e = new Error("The operation timed out.");
    e.name = "TimeoutError";
    throw e;
  }) as unknown as typeof fetch;
  const r = await new MarketSearch(cfg, timeoutFetch).search(criteria);
  assert.deepEqual(r, { hits: [], note: "other agencies not checked (timed out)" });
});

test("the agent's alert lists other agencies' candidates, and not our own listings", async () => {
  const { fetcher } = fakeServer();
  const clock = () => new Date("2026-11-12T13:00:00Z");
  const outbox = new DryRunOutbox({ clock });
  const flow = new LeadFlow({
    crm: FixtureCrm.load(),
    clock,
    outbox,
    market: new MarketSearch(cfg, fetcher),
    timeoutMs: 15 * 60_000,
    admin: { name: "Admin", address: "admin@example.com" },
  });
  await flow.receive({
    ref: "web-0412",
    source: "property_inquiry",
    name: "Sam Fixture",
    phone: "+1 868 555 0201",
    email: null,
    listingId: "L-101",
    listingType: "rent",
    area: "Woodbrook",
    budget: { max: 9000, currency: "TTD" },
    beds: 2,
    message: "",
  });
  const alert = outbox.messages.find((m) => m.kind === "agent_alert")!;
  assert.match(alert.text, /co-broke candidates, 2 from other agencies\)/);
  assert.match(alert.text, /Two-bed flat, Woodbrook · TTD 8,000 · 2 bed · Woodbrook · via otheragency https:\/\/example\.com\/a\/1/);
  assert.doesNotMatch(alert.text, /Our own listing/);
  assert.match(alert.text, /Two-bedroom flat, Woodbrook · TTD 7,000 · 2 bed · Woodbrook \(L-103\)/, "our own matches still come from the CRM");
});

test("a tool error from the server is treated as no candidates", async () => {
  const { fetcher } = fakeServer({
    toolReply: (id) => new Response(sse({ jsonrpc: "2.0", id, result: { isError: true, content: [] } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const r = await new MarketSearch(cfg, fetcher).search(criteria);
  assert.deepEqual(r.hits, []);
  assert.match(r.note, /unavailable/);
});
