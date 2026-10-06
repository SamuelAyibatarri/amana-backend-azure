import { afterEach, describe, expect, test } from "bun:test";
import { requestMagicLink } from "./magiclink.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown = {}) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("requestMagicLink", () => {
  test("sent on ok:true", async () => {
    stubFetch(200, { ok: true });
    expect(await requestMagicLink("2348012345678", "/kyc")).toBe("sent");
  });

  test("cooldown on 429", async () => {
    stubFetch(429, { ok: false, cooldown: true });
    expect(await requestMagicLink("2348012345678")).toBe("cooldown");
  });

  test("failed on non-ok and on throw", async () => {
    stubFetch(500, { ok: false });
    expect(await requestMagicLink("2348012345678")).toBe("failed");
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await requestMagicLink("2348012345678")).toBe("failed");
  });
});
