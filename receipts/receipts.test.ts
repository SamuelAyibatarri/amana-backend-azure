import { describe, expect, test } from "bun:test";
import {
  maskPhone,
  receiptTimestamp,
  renderPinGuard,
  shortAddress,
} from "./receipts.ts";

describe("maskPhone", () => {
  test("E.164 masked to 080…567 shape", () => {
    expect(maskPhone("2348031234567")).toBe("080…567");
    expect(maskPhone("2349067866448")).toBe("090…448");
  });
  test("short input collapses", () => {
    expect(maskPhone("123")).toBe("…");
  });
});

describe("shortAddress", () => {
  test("long truncated, short passthrough", () => {
    expect(shortAddress("4FbrxhGeQ81ptZtkYGMQwAXJL1UaxidrZUfJMQK742vx")).toBe(
      "4Fbr…42vx",
    );
    expect(shortAddress("abc")).toBe("abc");
    expect(shortAddress("123456789012")).toBe("123456789012");
  });
});

describe("receiptTimestamp", () => {
  test("fixed date deterministic + chat shape", () => {
    const d = new Date(2026, 9, 3, 15, 52);
    const a = receiptTimestamp(d);
    const b = receiptTimestamp(new Date(2026, 9, 3, 15, 52));
    expect(a).toBe(b);
    expect(a).toContain("2026");
    expect(a).toMatch(/, \d{2}:\d{2}$/);
  });
  test("different times differ", () => {
    expect(receiptTimestamp(new Date(2026, 9, 3, 15, 52))).not.toBe(
      receiptTimestamp(new Date(2026, 9, 3, 16, 52)),
    );
  });
});

describe("renderPinGuard", () => {
  test("renders non-empty PNG", async () => {
    const png = await renderPinGuard();
    expect(png.length).toBeGreaterThan(10_000);
  }, 30_000);
});
