import { describe, expect, test } from "bun:test";
import { greetingName } from "./name.ts";
import type { ResolvedName } from "./name.ts";

describe("greetingName", () => {
  test("name tier wins", () => {
    const r: ResolvedName = { name: "Samuel", useUserFallback: false, via: "local" };
    expect(greetingName(r)).toBe("Samuel");
  });
  test("User fallback when pushName existed but unusable", () => {
    const r: ResolvedName = { name: null, useUserFallback: true, via: "local" };
    expect(greetingName(r)).toBe("User");
  });
  test("null = bare greeting when no pushName", () => {
    const r: ResolvedName = { name: null, useUserFallback: false, via: "local" };
    expect(greetingName(r)).toBeNull();
  });
  test("name beats fallback flag", () => {
    const r: ResolvedName = { name: "Ada", useUserFallback: true, via: "kyc" };
    expect(greetingName(r)).toBe("Ada");
  });
});
