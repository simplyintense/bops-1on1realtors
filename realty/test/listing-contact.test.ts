import assert from "node:assert/strict";
import test from "node:test";
import {
  mailtoHref,
  normalizePhone,
  phoneLabel,
  telHref,
  whatsappHref,
  whatsappText,
} from "../flow/listing-contact.ts";
import { hitsFromToolResult } from "../flow/market-search.ts";

test("normalizePhone: local 7-digit numbers get the 1868 prefix", () => {
  assert.equal(normalizePhone("766-0211"), "18687660211");
});

test("normalizePhone: 10-digit 868 numbers get country code 1", () => {
  assert.equal(normalizePhone("(868) 766-0211"), "18687660211");
});

test("normalizePhone: +1 numbers and spaced forms keep their digits", () => {
  assert.equal(normalizePhone("+1868-3276593"), "18683276593");
  assert.equal(normalizePhone("1 868 327 6593"), "18683276593");
});

test("normalizePhone: a leading 00 international prefix is dropped", () => {
  assert.equal(normalizePhone("001868 327 6593"), "18683276593");
  assert.equal(normalizePhone("00 1 868 766 0211"), "18687660211");
});

test("normalizePhone: other valid lengths (11 to 15 digits) are kept as-is", () => {
  assert.equal(normalizePhone("+44 20 7946 0958"), "442079460958");
});

test("normalizePhone: garbage, empty and short numbers give null", () => {
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone("   "), null);
  assert.equal(normalizePhone("call me"), null);
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone("123456789"), null); // 9 digits: neither local nor long enough
  assert.equal(normalizePhone("8001234567"), null); // 10 digits, not 868
  assert.equal(normalizePhone("1234567890123456"), null); // 16 digits
});

test("telHref and whatsappHref build links from a valid number", () => {
  assert.equal(telHref("766-0211"), "tel:+18687660211");
  assert.equal(whatsappHref("(868) 766-0211"), "https://wa.me/18687660211");
});

test("whatsappHref encodes the prefilled text", () => {
  assert.equal(
    whatsappHref("766-0211", "Hi & welcome? 100%"),
    "https://wa.me/18687660211?text=Hi%20%26%20welcome%3F%20100%25",
  );
  assert.equal(whatsappHref("766-0211", ""), "https://wa.me/18687660211");
});

test("null or invalid phone gives null hrefs and label", () => {
  for (const raw of [null, undefined, "", "n/a", "123"]) {
    assert.equal(telHref(raw), null);
    assert.equal(whatsappHref(raw), null);
    assert.equal(whatsappHref(raw, "hello"), null);
    assert.equal(phoneLabel(raw), null);
  }
});

test("phoneLabel formats 1868 numbers and others", () => {
  assert.equal(phoneLabel("766-0211"), "+1 868 766 0211");
  assert.equal(phoneLabel("+1868-3276593"), "+1 868 327 6593");
  assert.equal(phoneLabel("+44 20 7946 0958"), "+442079460958");
});

test("mailtoHref accepts plausible emails and rejects the rest", () => {
  assert.equal(mailtoHref("agent@example.com"), "mailto:agent@example.com");
  assert.equal(mailtoHref("  agent@example.co.tt "), "mailto:agent@example.co.tt");
  assert.equal(mailtoHref("not an email"), null);
  assert.equal(mailtoHref("a@b"), null);
  assert.equal(mailtoHref(null), null);
});

test("whatsappText includes the title and url, and stays short", () => {
  const text = whatsappText({ title: "3 bed house in Westmoorings", url: "https://example.com/l/1" });
  assert.equal(
    text,
    "Hi, I'm with 1on1 Realtors. Is this listing still available? 3 bed house in Westmoorings https://example.com/l/1",
  );
  assert.equal(
    whatsappText({ title: "Townhouse", url: null }),
    "Hi, I'm with 1on1 Realtors. Is this listing still available? Townhouse",
  );
  const long = whatsappText({ title: "x".repeat(1000), url: "https://example.com/l/2" });
  assert.ok(long.length <= 300, `length ${long.length}`);
  assert.ok(long.endsWith(" https://example.com/l/2"));
});

function toolResult(hits: unknown[]) {
  return {
    content: [
      { type: "text", text: "2 listings found." },
      { type: "text", text: JSON.stringify({ total: hits.length, hits }) },
    ],
  };
}

test("hitsFromToolResult maps agent, agency and contact fields", () => {
  const [hit] = hitsFromToolResult(
    toolResult([
      {
        title: "Villa",
        source: "remax",
        url: "https://example.com/v",
        agent: "Jane Doe",
        agency: "RE/MAX Trinidad",
        agent_phone: "+1868-766-0211",
        agent_email: "jane@example.com",
      },
    ]),
  );
  assert.equal(hit.agent, "Jane Doe");
  assert.equal(hit.agency, "RE/MAX Trinidad");
  assert.equal(hit.agentPhone, "+1868-766-0211");
  assert.equal(hit.agentEmail, "jane@example.com");
});

test("hitsFromToolResult falls back to sender_agency, sender_business_phone and email", () => {
  const [hit] = hitsFromToolResult(
    toolResult([
      {
        title: "Flat",
        source: "pintt",
        sender_agency: "Pin Realty",
        sender_business_phone: "766-0211",
        email: "info@pin.example",
      },
    ]),
  );
  assert.equal(hit.agent, null);
  assert.equal(hit.agency, "Pin Realty");
  assert.equal(hit.agentPhone, "766-0211");
  assert.equal(hit.agentEmail, "info@pin.example");
});

test("hitsFromToolResult picks the first non-empty phone and drops a bad email", () => {
  const [hit] = hitsFromToolResult(
    toolResult([
      {
        title: "Lot",
        source: "trinidadrealtor",
        agent_phone: "  ",
        phone: "",
        agent_whatsapp: "+1868 766 0211",
        whatsapp: "+1868 000 0000",
        agent_email: "not-an-email",
        email: "fallback@example.com",
      },
    ]),
  );
  assert.equal(hit.agentPhone, "+1868 766 0211");
  assert.equal(hit.agentEmail, null);
});

test("hitsFromToolResult gives null for missing contact fields without breaking", () => {
  const [hit] = hitsFromToolResult(toolResult([{ title: "Bare", source: "mybunchofkeys" }]));
  assert.equal(hit.title, "Bare");
  assert.equal(hit.agent ?? null, null);
  assert.equal(hit.agency ?? null, null);
  assert.equal(hit.agentPhone ?? null, null);
  assert.equal(hit.agentEmail ?? null, null);
  assert.equal(telHref(hit.agentPhone), null);
});
