import { describe, expect, test } from "bun:test";
import {
  displayPhone,
  extractCurrency,
  extractSolAddress,
  fallbackIntent,
  hasInvalidPhone,
  normalizePhone,
  sanitizeIntent,
} from "./intent.ts";
import type { Intent } from "./intent.ts";

const TREASURY = "7ugwHmkCKDqnRFq7pQcFdzKeETd4j2ZVhjfG1Fb6HoBr";
const RECIPIENT = "4FbrxhGeQ81ptZtkYGMQwAXJL1UaxidrZUfJMQK742vx";

describe("normalizePhone", () => {
  test("valid local prefixes", () => {
    expect(normalizePhone("08031234567")).toBe("2348031234567");
    expect(normalizePhone("07031234567")).toBe("2347031234567");
    expect(normalizePhone("09031234567")).toBe("2349031234567");
    expect(normalizePhone("08131234567")).toBe("2348131234567");
  });
  test("+234 / 234 / spaced / dashed / parens / 10-digit core", () => {
    expect(normalizePhone("+2348031234567")).toBe("2348031234567");
    expect(normalizePhone("2348031234567")).toBe("2348031234567");
    expect(normalizePhone("0803 123 4567")).toBe("2348031234567");
    expect(normalizePhone("0803-123-4567")).toBe("2348031234567");
    expect(normalizePhone("(0803)1234567")).toBe("2348031234567");
    expect(normalizePhone("8031234567")).toBe("2348031234567");
  });
  test("rejects 06 / international / short / junk / 14-digit", () => {
    expect(normalizePhone("06031234567")).toBeUndefined();
    expect(normalizePhone("+15551234567")).toBeUndefined();
    expect(normalizePhone("+447911123456")).toBeUndefined();
    expect(normalizePhone("080123")).toBeUndefined();
    expect(normalizePhone("")).toBeUndefined();
    expect(normalizePhone("abcdefghijk")).toBeUndefined();
    expect(normalizePhone("07033671941112")).toBeUndefined();
  });
});

describe("displayPhone", () => {
  test("E.164 to local, passthrough otherwise", () => {
    expect(displayPhone("2348031234567")).toBe("08031234567");
    expect(displayPhone("08031234567")).toBe("08031234567");
  });
});

describe("extractSolAddress", () => {
  test("finds address in sentence + strips punctuation", () => {
    expect(extractSolAddress(`send 1 sol to ${TREASURY} pls`)).toBe(TREASURY);
    expect(extractSolAddress(`(${RECIPIENT}),`)).toBe(RECIPIENT);
  });
  test("32-char minimum holds, 31 rejected", () => {
    expect(extractSolAddress("1".repeat(32))).toBe("1".repeat(32));
    expect(extractSolAddress("1".repeat(31))).toBeUndefined();
  });
  test("rejects junk + non-base58 chars", () => {
    expect(extractSolAddress("hello world")).toBeUndefined();
    expect(extractSolAddress("0".repeat(32))).toBeUndefined();
    expect(extractSolAddress("O".repeat(32))).toBeUndefined();
    expect(extractSolAddress("I".repeat(32))).toBeUndefined();
    expect(extractSolAddress("l".repeat(32))).toBeUndefined();
    expect(extractSolAddress("")).toBeUndefined();
  });
});

describe("extractCurrency", () => {
  test("SOL / USDC / NGN variants", () => {
    expect(extractCurrency("send 5 sol")).toBe("SOL");
    expect(extractCurrency("100 USDC")).toBe("USDC");
    expect(extractCurrency("2000 naira")).toBe("NGN");
    expect(extractCurrency("50 ngn")).toBe("NGN");
    expect(extractCurrency("pay in fiat")).toBe("NGN");
  });
  test("₦ alone never matches (\\b quirk — source frozen, not loosened)", () => {
    expect(extractCurrency("₦5000")).toBeUndefined();
  });
  test("USDC wins on tie, undefined when absent", () => {
    expect(extractCurrency("sol and usdc")).toBe("USDC");
    expect(extractCurrency("hello there")).toBeUndefined();
  });
});

describe("hasInvalidPhone", () => {
  test("valid number clean, invalid flagged, short runs ignored", () => {
    expect(hasInvalidPhone("send to 08031234567")).toBe(false);
    expect(hasInvalidPhone("my number is 06012345678")).toBe(true);
    expect(hasInvalidPhone("call 12345")).toBe(false);
    expect(hasInvalidPhone("no digits here")).toBe(false);
    expect(hasInvalidPhone("07033671941112")).toBe(true);
  });
});

describe("sanitizeIntent", () => {
  const valid: Intent = {
    intent: "send",
    amount: 5,
    targetPhoneNumber: "2348031234567",
    currency: "SOL",
  };
  test("keeps valid fields", () => {
    expect(sanitizeIntent(valid)).toEqual(valid);
  });
  test("drops bad amount / phone / address", () => {
    expect(sanitizeIntent({ intent: "buy", amount: -5 }).amount).toBeUndefined();
    expect(sanitizeIntent({ intent: "buy", amount: 0 }).amount).toBeUndefined();
    expect(sanitizeIntent({ intent: "buy", amount: NaN }).amount).toBeUndefined();
    expect(
      sanitizeIntent({ intent: "send", targetPhoneNumber: "06012345678" })
        .targetPhoneNumber,
    ).toBeUndefined();
    expect(
      sanitizeIntent({ intent: "send", targetAddress: "junk!!" }).targetAddress,
    ).toBeUndefined();
  });
  test("phone wins over address", () => {
    const out = sanitizeIntent({
      intent: "send",
      amount: 1,
      targetPhoneNumber: "08031234567",
      targetAddress: TREASURY,
    });
    expect(out.targetPhoneNumber).toBe("2348031234567");
    expect(out.targetAddress).toBeUndefined();
  });
  test("drops bad enums, keeps buyAmountUnit", () => {
    const raw = {
      intent: "buy",
      amount: 2,
      currency: "BTC",
      buyAsset: "ETH",
      buyAmountUnit: "SOL",
    } as unknown as Intent;
    const out = sanitizeIntent(raw);
    expect(out.currency).toBeUndefined();
    expect(out.buyAsset).toBeUndefined();
    expect(out.buyAmountUnit).toBe("SOL");
  });
  test("keeps + validates amountUnit", () => {
    expect(
      sanitizeIntent({ intent: "send", amountUnit: "NGN" }).amountUnit,
    ).toBe("NGN");
    expect(
      sanitizeIntent({ intent: "send", amountUnit: "EUR" } as unknown as Intent)
        .amountUnit,
    ).toBeUndefined();
  });
  test("socialKind passes through verbatim, junk dropped", () => {
    expect(
      sanitizeIntent({ intent: "social", socialKind: "thanks" }).socialKind,
    ).toBe("thanks");
    expect(
      sanitizeIntent({ intent: "social", socialKind: "greeting" }).socialKind,
    ).toBe("greeting");
    expect(
      sanitizeIntent({ intent: "social", socialKind: "zzz" } as unknown as Intent)
        .socialKind,
    ).toBeUndefined();
    expect(
      sanitizeIntent({ intent: "send" }).socialKind,
    ).toBeUndefined();
  });
});

describe("fallbackIntent", () => {
  test("onboarding short hello, long hello unknown", () => {
    expect(fallbackIntent("hello").intent).toBe("onboarding");
    expect(fallbackIntent("start").intent).toBe("onboarding");
    expect(
      fallbackIntent("hello there, how does this thing work today?").intent,
    ).toBe("unknown");
  });
  test("buy 1 SOL is crypto-denominated", () => {
    const out = fallbackIntent("buy 1 SOL");
    expect(out.intent).toBe("buy");
    expect(out.amount).toBe(1);
    expect(out.buyAmountUnit).toBe("SOL");
  });
  test("buy naira of sol splits asset vs unit", () => {
    const out = fallbackIntent("buy 2000 naira of sol");
    expect(out.intent).toBe("buy");
    expect(out.amount).toBe(2000);
    expect(out.buyAsset).toBe("SOL");
    expect(out.buyAmountUnit).toBe("NGN");
    expect(out.currency).toBe("NGN");
  });
  test("k / m / b suffixes", () => {
    expect(fallbackIntent("buy 5k naira").amount).toBe(5000);
    expect(fallbackIntent("buy 1.5m naira").amount).toBe(1500000);
    expect(fallbackIntent("buy 2b naira").amount).toBe(2000000000);
  });
  test("send keeps phone, phone digits never become amount", () => {
    const full = fallbackIntent("send 5 sol to 08031234567");
    expect(full.intent).toBe("send");
    expect(full.amount).toBe(5);
    expect(full.currency).toBe("SOL");
    expect(full.targetPhoneNumber).toBe("2348031234567");
    const noAmount = fallbackIntent("send some money to 09067866448");
    expect(noAmount.intent).toBe("send");
    expect(noAmount.amount).toBeUndefined();
    expect(noAmount.targetPhoneNumber).toBe("2349067866448");
  });
  test("send to address", () => {
    const out = fallbackIntent(`send 2 sol to ${TREASURY}`);
    expect(out.intent).toBe("send");
    expect(out.targetAddress).toBe(TREASURY);
    expect(out.targetPhoneNumber).toBeUndefined();
  });
  test("balance / history / unknown", () => {
    expect(fallbackIntent("what is my balance?").intent).toBe("balance");
    expect(fallbackIntent("how much do I have").intent).toBe("balance");
    expect(fallbackIntent("show my transaction history").intent).toBe("history");
    expect(fallbackIntent("what is the weather").intent).toBe("unknown");
  });
  test("buy verbs: top up / fund / deposit", () => {
    expect(fallbackIntent("top up 3000 naira").intent).toBe("buy");
    expect(fallbackIntent("fund my wallet 3000").intent).toBe("buy");
    expect(fallbackIntent("deposit 3000 naira").intent).toBe("buy");
  });
  test("worth-of send is fiat-denominated", () => {
    const out = fallbackIntent("send 5000 naira worth of USDC to 08031234567");
    expect(out.intent).toBe("send");
    expect(out.amount).toBe(5000);
    expect(out.currency).toBe("USDC");
    expect(out.amountUnit).toBe("NGN");
    expect(out.targetPhoneNumber).toBe("2348031234567");
  });
  test("worth-of without send verb still sends when targeted", () => {
    const out = fallbackIntent("5000 naira worth of sol to 08031234567");
    expect(out.intent).toBe("send");
    expect(out.currency).toBe("SOL");
    expect(out.amountUnit).toBe("NGN");
  });
  test("plain sends carry no amountUnit", () => {
    expect(fallbackIntent("send 0.5 SOL to 08031234567").amountUnit).toBeUndefined();
  });
  test("request intent: target is the person asked", () => {
    const out = fallbackIntent("request 5000 from 08031234567");
    expect(out.intent).toBe("request");
    expect(out.amount).toBe(5000);
    expect(out.targetPhoneNumber).toBe("2348031234567");
  });
  test("request fiat-denominated like sends", () => {
    const out = fallbackIntent("request 5000 naira worth of USDC from 08031234567");
    expect(out.intent).toBe("request");
    expect(out.amount).toBe(5000);
    expect(out.currency).toBe("USDC");
    expect(out.amountUnit).toBe("NGN");
  });
  test("ask-for phrasing is a request, not a send", () => {
    const out = fallbackIntent("ask mum for 5 usdc");
    expect(out.intent).toBe("request");
    expect(out.amount).toBe(5);
    expect(out.currency).toBe("USDC");
  });
});
