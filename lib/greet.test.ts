import { describe, expect, test } from "bun:test";
import { cleanName, greet, lagosHour, slotForHour } from "./greet.ts";

describe("slotForHour", () => {
  test("all 5 slots + boundaries + night-owl wrap", () => {
    expect(slotForHour(0)).toBe("night-owl");
    expect(slotForHour(4)).toBe("night-owl");
    expect(slotForHour(5)).toBe("morning");
    expect(slotForHour(11)).toBe("morning");
    expect(slotForHour(12)).toBe("afternoon");
    expect(slotForHour(16)).toBe("afternoon");
    expect(slotForHour(17)).toBe("evening");
    expect(slotForHour(21)).toBe("evening");
    expect(slotForHour(22)).toBe("late");
    expect(slotForHour(23)).toBe("late");
  });
});

describe("lagosHour", () => {
  test("UTC+1 offset on fixed dates", () => {
    expect(lagosHour(new Date("2026-01-01T00:00:00.000Z"))).toBe(1);
    expect(lagosHour(new Date("2026-07-01T12:00:00.000Z"))).toBe(13);
    expect(lagosHour(new Date("2026-01-01T23:30:00.000Z"))).toBe(0);
  });
});

describe("cleanName", () => {
  test("first token, capitalized", () => {
    expect(cleanName("samuel")).toBe("Samuel");
    expect(cleanName("SAMUEL")).toBe("Samuel");
    expect(cleanName("samuel ayibatarri")).toBe("Samuel");
    expect(cleanName("  ada  ")).toBe("Ada");
    expect(cleanName("o'brien")).toBe("O'brien");
  });
  test("rejects digits / empty / long / symbols", () => {
    expect(cleanName(undefined)).toBeNull();
    expect(cleanName("")).toBeNull();
    expect(cleanName("   ")).toBeNull();
    expect(cleanName("12345")).toBeNull();
    expect(cleanName("08031234567")).toBeNull();
    expect(cleanName("Sam123")).toBeNull();
    expect(cleanName("🎉sam")).toBeNull();
    expect(cleanName("a".repeat(21))).toBeNull();
    expect(cleanName("a".repeat(20))).not.toBeNull();
  });
});

describe("greet", () => {
  const at = (utc: string) => new Date(utc);
  test("slot text per Lagos hour", () => {
    expect(greet(null, at("2026-01-15T03:30:00.000Z"))).toContain("night owl");
    expect(greet(null, at("2026-01-15T08:00:00.000Z"))).toContain("Good morning");
    expect(greet(null, at("2026-01-15T13:00:00.000Z"))).toContain("Good afternoon");
    expect(greet(null, at("2026-01-15T19:00:00.000Z"))).toContain("Good evening");
    expect(greet(null, at("2026-01-15T22:30:00.000Z"))).toContain("Up late");
  });
  test("name included when present, bare otherwise", () => {
    const withName = greet("Samuel", at("2026-01-15T08:00:00.000Z"));
    expect(withName).toContain("Samuel");
    expect(withName).toContain("Good morning");
    expect(greet(null, at("2026-01-15T08:00:00.000Z"))).not.toContain("Samuel");
  });
});
