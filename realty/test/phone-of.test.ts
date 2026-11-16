import assert from "node:assert/strict";
import { test } from "node:test";
import { phoneOf } from "../flow/periskope.ts";

test("phoneOf: T&T WhatsApp ids and typed T&T numbers keep the 1868 handling", () => {
  assert.equal(phoneOf("18685550201@c.us"), "+18685550201");
  assert.equal(phoneOf("868-555-0201"), "+18685550201");
  assert.equal(phoneOf("555-0201"), "+18685550201");
  assert.equal(phoneOf("+1 868 555 0201"), "+18685550201");
  assert.equal(phoneOf("18685550201@s.whatsapp.net"), "+18685550201");
});

test("phoneOf: 12-digit and other international WhatsApp ids are accepted as +<digits>", () => {
  assert.equal(phoneOf("447700900123@c.us"), "+447700900123", "UK, 12 digits");
  assert.equal(phoneOf("5511987654321@c.us"), "+5511987654321", "Brazil, 13 digits");
  assert.equal(phoneOf("4915123456789@c.us"), "+4915123456789", "Germany, 13 digits");
  assert.equal(phoneOf("59171234567@c.us"), "+59171234567", "Bolivia, 11 digits");
  assert.equal(phoneOf("35312345@c.us"), "+35312345", "8 digits, the shortest accepted");
  assert.equal(phoneOf("123456789012345@c.us"), "+123456789012345", "15 digits, the E.164 max");
});

test("phoneOf: ids outside E.164 or not a phone id are rejected", () => {
  assert.equal(phoneOf("1234567@c.us") === "+18681234567", true, "7 digits is still the T&T local rule");
  assert.equal(phoneOf("1234567890123456@c.us"), null, "16 digits is too long");
  assert.equal(phoneOf("012345678901@c.us"), null, "a leading 0 is not a country code");
  assert.equal(phoneOf("447700900123@lid"), null, "a linked-device id is not a phone");
  assert.equal(phoneOf("120363000000000001@g.us"), null, "a group id is not a phone");
  assert.equal(phoneOf(""), null);
  assert.equal(phoneOf("447700900123"), null, "a typed 12-digit number without + stays rejected");
  assert.equal(phoneOf("+447700900123"), "+447700900123", "a typed number with + is accepted");
});
