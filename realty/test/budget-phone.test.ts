import assert from "node:assert/strict";
import { test } from "node:test";
import { findBudget } from "../extract.ts";

/** findBudget: phone numbers are never prices, and a bare digit range needs money or budget/price context. */

const REGENTS = `🏡✨ FOR RENT | REGENTS TOWERS, WESTMOORINGS ✨🏡

Experience comfortable, upscale living in this beautifully furnished and fully equipped 5th-floor apartment, located in the secure and sought-after gated community of Regents Towers, Westmoorings. 🌴🔑

🏠 Property Features:
🛏️ 3 Bedrooms
🛁 2 Bathrooms
🛋️ Fully Furnished & Equipped
🌅 Beautiful Northern & Eastern Views
📺 Cable Included
📶 Internet Included
🔐 Secure Gated Compound

💰 Rental Price: $18,000 per month

Available mid - end January 2027

📞 For viewings and further information, contact:
Shanna | 332-4780

✨ Enjoy the perfect blend of comfort, convenience, and security in one of Westmoorings’ desirable residential communities!`;

test("the Regents Towers post: the phone 332-4780 is not the price, the $18,000 per month is", () => {
  const b = findBudget(REGENTS);
  assert.deepEqual(b, { min: null, max: 18000, currency: "TTD", period: "month", text: "$18,000 per month" });
});

test("Trinidad phone numbers never become prices, even with the word price in the message", () => {
  for (const phone of ["868-719-5976", "680-1234", "(868) 719-5976", "Shanna | 332-4780", "+1 868 719 5976", "1-868-719-5976", "332-4780"]) {
    assert.equal(findBudget(`Price enquiries welcome, call ${phone}`), null, phone);
    assert.equal(findBudget(`Rental price: ${phone}`), null, phone);
    assert.equal(findBudget(`Asking price budget ${phone} please`), null, phone);
  }
});

test("a phone number next to a real price gives the price", () => {
  const b = findBudget("Rental Price: $18,000 per month. Shanna | 332-4780");
  assert.equal(b?.max, 18000);
  assert.equal(b?.period, "month");
  assert.equal(findBudget("Call 868-719-5976 for the price of $15,000 a month")?.max, 15000);
});

test("a phone-only message with no price is null, even when the word price appears", () => {
  assert.equal(findBudget("Price? Call Shanna 332-4780"), null);
  assert.equal(findBudget("Price on request, 868-719-5976 or (868) 719-5976"), null);
  assert.equal(findBudget("Price: 680-1234"), null);
});

test("a bare digit range without money or budget words is not a price", () => {
  assert.equal(findBudget("3-4 bedrooms please"), null);
  assert.equal(findBudget("a 5 m x 10 m lot"), null);
  assert.equal(findBudget("Lot 12-15 in Maraval, 2 bathrooms"), null);
});

test("valid money ranges still work", () => {
  assert.deepEqual(findBudget("$15,000 - $18,000"), { min: 15000, max: 18000, currency: "TTD", period: null, text: "$15,000 - $18,000" });
  assert.deepEqual(findBudget("TT$1.5M - $2M"), { min: 1_500_000, max: 2_000_000, currency: "TTD", period: null, text: "TT$1.5M - $2M" });
  assert.deepEqual(findBudget("budget 5000-7000"), { min: 5000, max: 7000, currency: "TTD", period: null, text: "5000-7000" });
  assert.equal(findBudget("1.2m-1.5m")?.max, 1_500_000);
  assert.equal(findBudget("1.2m-1.5m")?.min, 1_200_000);
  const slash = findBudget("Budget $7000/7500");
  assert.equal(slash?.min, 7000);
  assert.equal(slash?.max, 7500);
  assert.equal(slash?.currency, "TTD");
});

test("a range in price context counts, and the currency comes from the message", () => {
  assert.equal(findBudget("price: 15,000-18,000")?.min, 15000);
  assert.equal(findBudget("price: 15,000-18,000")?.max, 18000);
  assert.equal(findBudget("Budget US$5000-7000")?.currency, "USD");
});

test("the first valid money range wins, and phone-shaped or bare ranges are skipped on the way", () => {
  const b = findBudget("Rent 332-4780 or 3-4 bedrooms; budget $2,000-2,500 a month");
  assert.equal(b?.min, 2000);
  assert.equal(b?.max, 2500);
  assert.equal(b?.period, "month");
});

test("an explicit currency amount beats a bare uncurrencied digit range in the same message", () => {
  const b = findBudget("price: 5000-7000, or take $18,000 per month");
  assert.equal(b?.max, 18000);
  assert.equal(b?.period, "month");
  // A bare context range still wins when there is no explicit $ / TT$ / US$ amount.
  assert.deepEqual(findBudget("budget 5000-7000"), { min: 5000, max: 7000, currency: "TTD", period: null, text: "5000-7000" });
});
