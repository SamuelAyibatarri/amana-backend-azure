import { describe, expect, test } from "bun:test";
import { convertSendNgn, cryptoForNgn } from "./rates.ts";
import type { Quote } from "./rates.ts";

const solQuote: Quote = {
  currency: "SOL",
  cryptoPerNgn: 1 / (119.35 * 1360),
  solUsd: 119.35,
  usdcUsd: 1,
  usdNgn: 1360,
  at: "fixed",
  live: false,
};

const usdcQuote: Quote = {
  currency: "USDC",
  cryptoPerNgn: 1 / (1 * 1360),
  solUsd: 119.35,
  usdcUsd: 1,
  usdNgn: 1360,
  at: "fixed",
  live: false,
};

describe("cryptoForNgn", () => {
  test("SOL math", () => {
    expect(cryptoForNgn(1360, solQuote)).toBeCloseTo(1 / 119.35, 10);
    expect(cryptoForNgn(0, solQuote)).toBe(0);
  });
  test("USDC math", () => {
    expect(cryptoForNgn(2720, usdcQuote)).toBeCloseTo(2, 10);
    expect(cryptoForNgn(100, usdcQuote)).toBeCloseTo(100 / 1360, 10);
  });
  test("zero / negative pass through (no guard in impl)", () => {
    expect(cryptoForNgn(0, usdcQuote)).toBe(0);
    expect(cryptoForNgn(-100, usdcQuote)).toBeCloseTo(-100 / 1360, 10);
  });
});

describe("convertSendNgn", () => {
  test("USDC conversion + label", () => {
    const { crypto, label } = convertSendNgn(5000, "USDC", usdcQuote);
    expect(crypto).toBeCloseTo(5000 / 1360, 10);
    expect(label).toContain("USDC");
    expect(label).toContain("₦1360/$");
  });
  test("SOL uses 5dp + sol price", () => {
    const { crypto, label } = convertSendNgn(1360, "SOL", solQuote);
    expect(crypto).toBeCloseTo(1 / 119.35, 10);
    expect(label).toContain("$119.35");
  });
  test("stale quote flagged", () => {
    const { label } = convertSendNgn(100, "USDC", { ...usdcQuote, live: true });
    expect(label).not.toContain("last known rate");
    const stale = convertSendNgn(100, "USDC", usdcQuote);
    expect(stale.label).toContain("last known rate");
  });
});
