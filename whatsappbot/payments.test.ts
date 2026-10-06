import { describe, expect, test } from "bun:test";
import {
  buildConfirmMessage,
  buildYesNoReprompt,
  displayTarget,
  isActionable,
  isThanks,
  parsePin,
  parseYesNo,
  shortAddress,
} from "./payments.ts";
import type { PaymentDetails } from "./payments.ts";

const sendDetails: PaymentDetails = {
  action: "send",
  amount: 5,
  currency: "SOL",
  targetPhoneNumber: "2348031234567",
  recalled: false,
};

describe("parseYesNo", () => {
  test("yes variants", () => {
    for (const w of ["yes", "YES", " y ", "yep", "YUP", "yeah"]) {
      expect(parseYesNo(w)).toBe("yes");
    }
  });
  test("no variants", () => {
    for (const w of ["no", "N", "nope", "nah", "nevermind", "never mind", "cancel", "  No  "]) {
      expect(parseYesNo(w)).toBe("no");
    }
  });
  test("everything else invalid", () => {
    for (const w of ["", "maybe", "yess", "yes please", "no thanks", "ok", "1234"]) {
      expect(parseYesNo(w)).toBe("invalid");
    }
  });
});

describe("parsePin", () => {
  test("exactly 4 digits", () => {
    expect(parsePin("4444")).toBe("4444");
    expect(parsePin(" 1234 ")).toBe("1234");
    expect(parsePin("0000")).toBe("0000");
  });
  test("rejects non-4-digit", () => {
    expect(parsePin("123")).toBeNull();
    expect(parsePin("12345")).toBeNull();
    expect(parsePin("12a4")).toBeNull();
    expect(parsePin("")).toBeNull();
    expect(parsePin("12 34")).toBeNull();
  });
});

describe("isActionable", () => {
  test("amount required; send needs a target", () => {
    expect(isActionable(sendDetails)).toBe(true);
    expect(isActionable({ ...sendDetails, amount: undefined })).toBe(false);
    expect(
      isActionable({ action: "send", currency: "SOL", recalled: false }),
    ).toBe(false);
    expect(
      isActionable({
        action: "send",
        amount: 1,
        currency: "USDC",
        targetAddress: "4FbrxhGeQ81ptZtkYGMQwAXJL1UaxidrZUfJMQK742vx",
        recalled: false,
      }),
    ).toBe(true);
    expect(
      isActionable({ action: "buy", amount: 2000, currency: "SOL", recalled: false }),
    ).toBe(true);
    expect(
      isActionable({ action: "buy", currency: "SOL", recalled: false }),
    ).toBe(false);
  });
});

describe("shortAddress / displayTarget", () => {
  test("shortAddress truncates long only", () => {
    expect(
      shortAddress("4FbrxhGeQ81ptZtkYGMQwAXJL1UaxidrZUfJMQK742vx"),
    ).toBe("4Fbr…42vx");
    expect(shortAddress("abc")).toBe("abc");
    expect(shortAddress("123456789012")).toBe("123456789012");
  });
  test("displayTarget phone / address / unknown", () => {
    expect(displayTarget(sendDetails)).toBe("08031234567");
    expect(
      displayTarget({
        action: "send",
        amount: 1,
        currency: "SOL",
        targetAddress: "4FbrxhGeQ81ptZtkYGMQwAXJL1UaxidrZUfJMQK742vx",
        recalled: false,
      }),
    ).toBe("sol:4Fbr…42vx");
    expect(
      displayTarget({ action: "send", amount: 1, currency: "SOL", recalled: false }),
    ).toBe("unknown recipient");
  });
});

describe("buildConfirmMessage", () => {
  test("send confirm states amount / unit / target + YES/NO", () => {
    const msg = buildConfirmMessage(sendDetails);
    expect(msg).toContain("Send 5 SOL");
    expect(msg).toContain("08031234567");
    expect(msg).toContain("YES");
    expect(msg).toContain("NO");
  });
  test("fiat-denominated send shows converted crypto + naira + quote", () => {
    const msg = buildConfirmMessage({
      action: "send",
      amount: 3.676,
      currency: "USDC",
      targetPhoneNumber: "2348031234567",
      sendAmountUnit: "NGN",
      sendNgn: 5000,
      sendQuote: "≈ 3.68 USDC @ $1, ₦1360/$",
      recalled: false,
    });
    expect(msg).toContain("Send ≈ 3.676 USDC (₦5,000)");
    expect(msg).toContain("08031234567");
    expect(msg).toContain("≈ 3.68 USDC");
  });
  test("NGN buy names fiat unit + asset + quote", () => {
    const msg = buildConfirmMessage({
      action: "buy",
      amount: 2000,
      currency: "SOL",
      buyAsset: "SOL",
      buyAmountUnit: "NGN",
      buyQuote: "≈ 0.01230 SOL",
      recalled: false,
    });
    expect(msg).toContain("Buy 2,000 NGN of SOL");
    expect(msg).toContain("≈ 0.01230 SOL");
  });
  test("crypto-denominated buy flagged", () => {
    const msg = buildConfirmMessage({
      action: "buy",
      amount: 1,
      currency: "SOL",
      buyAsset: "SOL",
      buyAmountUnit: "SOL",
      recalled: false,
    });
    expect(msg).toContain("Buy 1 SOL");
    expect(msg).toContain("crypto-denominated");
  });
  test("recalled / unverified / unlinked cautions", () => {
    expect(buildConfirmMessage({ ...sendDetails, recalled: true })).toContain(
      "earlier chat",
    );
    expect(
      buildConfirmMessage({ ...sendDetails, numberUnverified: true }),
    ).toContain("couldn't verify");
    expect(
      buildConfirmMessage({ ...sendDetails, recipientLinked: false }),
    ).toContain("isn't on Amana yet");
    expect(buildConfirmMessage(sendDetails)).not.toContain("earlier chat");
  });
});

describe("buildYesNoReprompt", () => {
  test("restates send + buy", () => {
    const send = buildYesNoReprompt(sendDetails);
    expect(send).toContain("Send 5 SOL");
    expect(send).toContain("YES or NO");
    const buy = buildYesNoReprompt({
      action: "buy",
      amount: 2000,
      currency: "SOL",
      buyAsset: "USDC",
      buyAmountUnit: "NGN",
      recalled: false,
    });
    expect(buy).toContain("Buy 2,000 NGN");
    expect(buy).toContain("USDC");
  });
});

describe("isThanks", () => {
  test("canonical forms", () => {
    for (const t of ["Thanks", "thank you", "THX", "ok thanks", "Thanks a lot", "appreciated", "Many thanks!"]) {
      expect(isThanks(t)).toBe(true);
    }
  });
  test("elongation + punctuation noise", () => {
    expect(isThanks("Thank youuuuu ..")).toBe(true);
    expect(isThanks("thanksss!!")).toBe(true);
    expect(isThanks("thaaanks 🙏")).toBe(true);
  });
  test("rejects commands and questions", () => {
    expect(isThanks("thanks, now send 5 sol to 08031234567")).toBe(false);
    expect(isThanks("what do you think")).toBe(false);
    expect(isThanks("")).toBe(false);
    expect(isThanks("thank")).toBe(false);
  });
});
