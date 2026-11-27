import assert from "node:assert/strict";
import test from "node:test";
import { interpret, postRecordOf, readsAsBuyerAsk } from "../flow/periskope.ts";

/**
 * Buyer asks and inquiries are demand, not supply: the classifier (interpret, postRecordOf) files them under demand, and
 * readsAsBuyerAsk reads the same words for a stored supply row. A genuine offer is supply and never reads as an ask.
 * Invented senders and places only.
 */

const AGENT = "+18685550101";
const SENT = "2026-11-12T13:40:14.000Z";

function stored(body: string, id: string) {
  const message = { messageId: id, chatId: "chat-a@g.us", sender: "18685550101@c.us", senderName: "Test Agent", chatName: "Test Group A", body, hasText: true, textOnly: true, fromMe: false, mediaUrls: [], sentAt: SENT };
  return postRecordOf({ message, phone: AGENT, interpretation: interpret(body), sentAt: SENT });
}

const ASKS = [
  "Any ground floor Westhills for sale?",
  "Hi any ground floor units in west hills available for sale ?",
  "Sale Search: West Hills for sale 3 bedroom Pls send all units Showing next week",
  "Rent Search: 2 bed apartment Westmoorings",
  "WTB 3 bed house Westmoorings for sale",
  "Looking for a 3 bed house in Westmoorings, budget TT$4m",
  "Anyone have a 3 bed house in Westmoorings for sale?",
  "Client looking for 3 bed house Maraval TT$4m",
  "Buyer looking for a 3 bed house in Maraval",
  "Searching for a 2 bed in Westmoorings for rent",
  "Pls send me listings Westmoorings 2 bed",
  "Do you have a 2 bed in Westmoorings for rent?",
];

const OFFERS = [
  "3 bed house in Westmoorings for sale, TT$4,000,000. Call 555 0142.",
  "NEW TO THE MARKET\n3 bed house Westmoorings, asking TT$4.2m",
  "FOR SALE | 3 bed house in Maraval, TT$4m",
  "Any offers considered on this 3 bed house in Westmoorings for sale, TT$4m",
  "Westmoorings apartment for rent, 2 beds, $7,500 a month, available now",
];

test("the live ISO and inquiry phrasings, and the other asks (searches, WTB, requests to be sent units, availability questions), are demand", () => {
  for (const body of ASKS) assert.equal(stored(body, body).set, "demand", body);
});

test("a genuine offer is supply, including one that says 'any offers' and one with a headline", () => {
  for (const body of OFFERS) assert.equal(stored(body, body).set, "supply", body);
});

test("a stored supply row that reads as an ask is caught by readsAsBuyerAsk; an offer is not", () => {
  for (const body of ASKS) assert.equal(readsAsBuyerAsk(body), true, body);
  for (const body of OFFERS) assert.equal(readsAsBuyerAsk(body), false, body);
});

test("a question that names no availability is not an ask by itself: 'interested?' on an offer stays an offer", () => {
  const body = "3 bed house in Westmoorings for sale, TT$4,000,000, interested?";
  assert.equal(stored(body, "q-1").set, "supply");
  assert.equal(readsAsBuyerAsk(body), false);
});
