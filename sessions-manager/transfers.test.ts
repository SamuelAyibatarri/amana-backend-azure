import { describe, expect, test } from "bun:test";
import { LEDGER_DECIMALS, formatAmount, formatNum, minorToWhole } from "./transfers.ts";

describe("LEDGER_DECIMALS", () => {
  test("frontend contract: SOL 9, USDC 6, NGN 2", () => {
    expect(LEDGER_DECIMALS).toEqual({ SOL: 9, USDC: 6, NGN: 2 });
  });
});

describe("minorToWhole", () => {
  test("unit conversions per currency", () => {
    expect(minorToWhole(1_000_000_000, "SOL")).toBe(1);
    expect(minorToWhole(1_000_000, "USDC")).toBe(1);
    expect(minorToWhole(100, "NGN")).toBe(1);
    expect(minorToWhole(0, "SOL")).toBe(0);
  });
  test("fractional incl. rounding edge", () => {
    expect(minorToWhole(1_500_000_000, "SOL")).toBe(1.5);
    expect(minorToWhole(250, "NGN")).toBe(2.5);
    expect(minorToWhole(1, "SOL")).toBeCloseTo(1e-9, 15);
  });
});

describe("formatNum", () => {
  test("max 3dp trimmed + grouped", () => {
    expect(formatNum(3.67661765)).toBe("3.677");
    expect(formatNum(5)).toBe("5");
    expect(formatNum(0.1)).toBe("0.1");
    expect(formatNum(1234.5678)).toBe("1,234.568");
    expect(formatNum(2000, 2)).toBe("2,000");
  });
  test("non-finite → 0", () => {
    expect(formatNum(NaN)).toBe("0");
    expect(formatNum(Infinity)).toBe("0");
  });
});

describe("formatAmount", () => {
  test("crypto max 3dp with currency", () => {
    expect(formatAmount(3.67661765, "USDC")).toBe("3.677 USDC");
    expect(formatAmount(0.84912, "SOL")).toBe("0.849 SOL");
    expect(formatAmount(43.017158, "USDC")).toBe("43.017 USDC");
    expect(formatAmount(1, "SOL")).toBe("1 SOL");
  });
  test("NGN grouped 2dp with sign", () => {
    expect(formatAmount(198878.5, "NGN")).toBe("₦198,878.5");
    expect(formatAmount(5000, "NGN")).toBe("₦5,000");
  });
  test("dust never shows bare zero", () => {
    expect(formatAmount(0.0000001, "SOL")).toBe("< 0.001 SOL");
    expect(formatAmount(0, "USDC")).toBe("0 USDC");
  });
});
