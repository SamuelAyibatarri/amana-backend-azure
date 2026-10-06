import { describe, expect, test } from "bun:test";
import {
  clearPending,
  getConvo,
  recallParams,
  recentTexts,
  recordTurn,
  rememberText,
  resetConvo,
  setPending,
} from "./conversation.ts";

let n = 0;
const phone = () => `23480000000${String(10 + n++)}`;

describe("pending lifecycle", () => {
  test("fresh convo idle; set overwrites; clear resets", () => {
    const p = phone();
    expect(getConvo(p).pending.kind).toBe("idle");
    setPending(p, {
      kind: "awaitingConfirm",
      details: { action: "buy", amount: 1, currency: "SOL", recalled: false },
      expiresAt: Date.now() + 60_000,
    });
    expect(getConvo(p).pending.kind).toBe("awaitingConfirm");
    setPending(p, {
      kind: "awaitingPin",
      details: { action: "buy", amount: 1, currency: "SOL", recalled: false },
      expiresAt: Date.now() + 60_000,
    });
    expect(getConvo(p).pending.kind).toBe("awaitingPin");
    clearPending(p);
    expect(getConvo(p).pending.kind).toBe("idle");
  });
  test("expired pending clears but turns survive", () => {
    const p = phone();
    const realNow = Date.now;
    try {
      recordTurn(p, { intent: "send", amount: 5 });
      setPending(p, {
        kind: "awaitingConfirm",
        details: { action: "send", amount: 5, currency: "SOL", recalled: false },
        expiresAt: realNow() + 1_000,
      });
      Date.now = () => realNow() + 2_000;
      expect(getConvo(p).pending.kind).toBe("idle");
      expect(getConvo(p).turns.length).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });
  test("31min silence resets everything", () => {
    const p = phone();
    const realNow = Date.now;
    try {
      recordTurn(p, { intent: "send", amount: 5 });
      rememberText(p, "send 5 sol");
      Date.now = () => realNow() + 31 * 60 * 1_000;
      const convo = getConvo(p);
      expect(convo.pending.kind).toBe("idle");
      expect(convo.turns.length).toBe(0);
      expect(convo.texts.length).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("recordTurn / recallParams", () => {
  test("caps at 10, oldest dropped", () => {
    const p = phone();
    resetConvo(p);
    for (let i = 0; i < 12; i++) {
      recordTurn(p, { intent: "send", amount: i });
    }
    const turns = getConvo(p).turns;
    expect(turns.length).toBe(10);
    expect(turns[0]?.amount).toBe(2);
  });
  test("freshest same-action params; buy/send isolated", () => {
    const p = phone();
    resetConvo(p);
    recordTurn(p, {
      intent: "send",
      amount: 5,
      targetPhoneNumber: "2348031234567",
      currency: "SOL",
    });
    const recalled = recallParams(p, "send");
    expect(recalled.amount).toBe(5);
    expect(recalled.targetPhoneNumber).toBe("2348031234567");
    expect(recallParams(p, "buy")).toEqual({});
  });
  test("empty turns skipped", () => {
    const p = phone();
    resetConvo(p);
    recordTurn(p, { intent: "send" });
    expect(recallParams(p, "send")).toEqual({});
  });
});

describe("rememberText / recentTexts", () => {
  test("caps at 6, truncates >200 chars", () => {
    const p = phone();
    resetConvo(p);
    for (let i = 0; i < 8; i++) rememberText(p, `msg ${i}`);
    const texts = recentTexts(p);
    expect(texts.length).toBe(6);
    expect(texts[0]).toBe("msg 2");
    rememberText(p, "x".repeat(250));
    const last = recentTexts(p).at(-1) ?? "";
    expect(last.length).toBe(201);
    expect(last.endsWith("…")).toBe(true);
  });
  test("returns a copy", () => {
    const p = phone();
    resetConvo(p);
    rememberText(p, "hello");
    const copy = recentTexts(p);
    copy.push("mutated");
    expect(recentTexts(p)).toEqual(["hello"]);
  });
});
