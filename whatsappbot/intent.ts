import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { log } from "../lib/log.ts";

/**
 * AI intent parsing (AGENTS.md contract):
 * - Zod schema enforces the intent enum + optional amount/targetPhoneNumber.
 * - Model-always: Gemini classifies every message (structured output,
 *   Zod-validated, sanitizer-checked). The deterministic keyword parser
 *   below is the fallback (no API key / model failure) — and the unit
 *   under test for validator strictness.
 * - The AI must never generate conversational replies directly; handlers
 *   own every user-facing string.
 */

export const intentSchema = z.object({
  intent: z.enum(["onboarding", "buy", "send", "balance", "history", "request", "unknown"]),
  amount: z.number().positive().optional(),
  targetPhoneNumber: z.string().optional(),
  targetAddress: z.string().optional(),
  currency: z.enum(["SOL", "USDC", "NGN"]).optional(),
  /** Buy asset for "buy X of SOL/USDC" (fiat amount, crypto target). */
  buyAsset: z.enum(["SOL", "USDC"]).optional(),
  /** Unit of a buy amount: "buy 1 SOL" = SOL, "buy 2000 naira" = NGN. */
  buyAmountUnit: z.enum(["NGN", "SOL", "USDC"]).optional(),
  /** Unit of a send amount: "send 5000 naira worth of USDC" = NGN. */
  amountUnit: z.enum(["NGN", "SOL", "USDC"]).optional(),
});

export type Intent = z.infer<typeof intentSchema>;

// JSON Schema mirror for the model's responseSchema parameter.
const intentJsonSchema = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["onboarding", "buy", "send", "balance", "history", "request", "unknown"],
    },
    amount: { type: "number" },
    targetPhoneNumber: { type: "string" },
    targetAddress: { type: "string" },
    currency: { type: "string", enum: ["SOL", "USDC", "NGN"] },
    buyAsset: { type: "string", enum: ["SOL", "USDC"] },
    buyAmountUnit: { type: "string", enum: ["NGN", "SOL", "USDC"] },
    amountUnit: { type: "string", enum: ["NGN", "SOL", "USDC"] },
  },
  required: ["intent"],
} as const;

const MODEL = process.env.GENAI_MODEL ?? "gemini-2.5-flash-lite";

// Retry budget for transient model errors (spikes clear in seconds;
// a short wait converts a fallback into a real classification).
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000];
const TRANSIENT = /503|429|UNAVAILABLE|high demand|overloaded|try again/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** First 120 chars — enough to answer "why unknown?" from logs. */
function preview(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * Strict Nigerian mobile normalization. Accepts 11-digit local
 * (08031234567), 13-digit international (2348031234567), or 10-digit
 * core (8031234567) — all must resolve to a 234 + 10-digit core starting
 * 7/8/9. Returns E.164-ish digits or undefined. "07033671941112"
 * (14 digits) is NOT a phone number.
 */
export function normalizePhone(value: string): string | undefined {
  let d = value.replace(/[\s\-().+]/g, "");
  if (d.startsWith("234")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);
  if (!/^[789]\d{9}$/.test(d)) return undefined;
  return `234${d}`;
}

/** Display form: 08031234567. */
export function displayPhone(e164: string): string {
  return e164.startsWith("234") ? `0${e164.slice(3)}` : e164;
}

function extractPhone(text: string): string | undefined {
  const compact = text.replace(/[\s\-().+]/g, "");
  const m = compact.match(/\+?(\d{7,16})/);
  return m?.[1] ? normalizePhone(m[1]) : undefined;
}

/** Solana address: base58, 32-44 chars. Full validation lands on-chain. */
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function extractSolAddress(text: string): string | undefined {
  const words = text.split(/[\s,;]+/);
  for (const w of words) {
    const clean = w.replace(/^[(\["']+|[)\]"'.,!?]+$/g, "");
    if (SOL_ADDRESS.test(clean)) return clean;
  }
  return undefined;
}

/** Buy asset from "of SOL/USDC" (or trailing asset word). */
function extractBuyAsset(text: string): "SOL" | "USDC" | undefined {
  const m = text.toLowerCase().match(/\bof\s+(sol|usdc)\b|\b(sol|usdc)\s*$/);
  const raw = m?.[1] ?? m?.[2];
  return raw === "sol" ? "SOL" : raw === "usdc" ? "USDC" : undefined;
}

/** True when the text holds digit runs that look like a number but fail validation. */
export function hasInvalidPhone(text: string): boolean {
  const compact = text.replace(/[\s\-().+]/g, "");
  const runs = compact.match(/\d{7,16}/g) ?? [];
  return runs.some((r) => normalizePhone(r) === undefined);
}

export type Currency = "SOL" | "USDC" | "NGN";

export function extractCurrency(text: string): Currency | undefined {
  const t = text.toLowerCase();
  if (/\b(usdc)\b/.test(t)) return "USDC";
  if (/\b(naira|ngn|₦|fiat)\b/.test(t)) return "NGN";
  if (/\b(sol)\b/.test(t)) return "SOL";
  return undefined;
}

/**
 * Strict extraction order: phone first, then amount from the REMAINDER.
 * Phone digits must never become an amount ("send some money to
 * 09067866448" has no amount — "some" is not a number).
 */
function extractAmountWithoutPhone(text: string): number | undefined {
  // Blank every long digit run (phones, spaced or not) before looking
  // for an amount — phone digits must never become money.
  const rest = text.replace(/\d(?:[\d\s,().-]*\d)?/g, (run) =>
    run.replace(/\D/g, "").length >= 7 ? " " : run,
  );
  const m = rest.match(/(\d[\d,]*\.?\d*)\s*([kmb])?\s*(naira|ngn|₦|sol|usdc|usd|dollar)?/i);
  if (!m) return undefined;
  const n = Number((m[1] ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Magnitude suffixes: 5k = 5000, 1.5m = 1500000. Bare numbers unchanged.
  const suffix = (m[2] ?? "").toLowerCase();
  const mult = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return n * mult;
}

/**
 * Sanitize any classified intent (fallback or model). Amount must be a
 * positive finite number; phone must strictly normalize. Invalid fields
 * are dropped so downstream logic asks or recalls — never hallucinates.
 */
export function sanitizeIntent(raw: Intent): Intent {
  const amount =
    typeof raw.amount === "number" &&
    Number.isFinite(raw.amount) &&
    raw.amount > 0
      ? raw.amount
      : undefined;
  const targetPhoneNumber = raw.targetPhoneNumber
    ? normalizePhone(raw.targetPhoneNumber)
    : undefined;
  const targetAddress =
    !targetPhoneNumber && raw.targetAddress && SOL_ADDRESS.test(raw.targetAddress.trim())
      ? raw.targetAddress.trim()
      : undefined;
  const currency =
    raw.currency === "SOL" || raw.currency === "USDC" || raw.currency === "NGN"
      ? raw.currency
      : undefined;
  // Buy asset: explicit "of SOL/USDC" only, never inferred from currency
  // (in "buy 2000 naira of sol", NGN is the fiat unit, SOL the asset).
  const buyAsset =
    raw.buyAsset === "SOL" || raw.buyAsset === "USDC" ? raw.buyAsset : undefined;
  const clean: Intent = { intent: raw.intent };
  if (amount !== undefined) clean.amount = amount;  if (targetPhoneNumber !== undefined) {
    clean.targetPhoneNumber = targetPhoneNumber;
  }
  if (targetAddress !== undefined) clean.targetAddress = targetAddress;
  if (currency !== undefined) clean.currency = currency;
  if (buyAsset !== undefined) clean.buyAsset = buyAsset;
  const buyAmountUnit =
    raw.buyAmountUnit === "SOL" || raw.buyAmountUnit === "USDC" || raw.buyAmountUnit === "NGN"
      ? raw.buyAmountUnit
      : undefined;
  if (buyAmountUnit !== undefined) clean.buyAmountUnit = buyAmountUnit;
  // Send unit: fiat-denominated sends ("5000 naira worth of USDC").
  // Defaults downstream to the currency itself (crypto-denominated).
  const amountUnit =
    raw.amountUnit === "SOL" || raw.amountUnit === "USDC" || raw.amountUnit === "NGN"
      ? raw.amountUnit
      : undefined;
  if (amountUnit !== undefined) clean.amountUnit = amountUnit;
  return clean;
}

/** Deterministic fallback — also the no-API-key path. */
export function fallbackIntent(text: string): Intent {
  const t = text.toLowerCase();
  const amount = extractAmountWithoutPhone(text);
  const targetPhoneNumber = extractPhone(text);
  const targetAddress = targetPhoneNumber ? undefined : extractSolAddress(text);
  const currency = extractCurrency(text);
  const withCurrency = <T extends Intent>(base: T): T =>
    currency ? { ...base, currency } : base;
  if (/\b(hi|hello|hey|start|join|register|new|begin)\b/.test(t) && t.length < 30) {
    return { intent: "onboarding" };
  }
  if (/\b(buy|purchase|top up|topup|fund|deposit)\b/.test(t)) {
    const buyAsset = extractBuyAsset(text);
    // Crypto-denominated buy: "buy 1 SOL" = 1 SOL, not 1 naira.
    const direct = text.match(
      /\b(?:buy|purchase|fund|deposit)\s+(\d[\d,]*\.?\d*)\s*(sol|usdc)\b/i,
    );
    const buyAmountUnit = direct
      ? (direct[2]!.toUpperCase() as "SOL" | "USDC")
      : ("NGN" as const);
    return withCurrency({
      intent: "buy",
      ...(amount ? { amount } : {}),
      ...(buyAsset ? { buyAsset } : {}),
      buyAmountUnit,
    });
  }
  if (/\b(send|transfer|pay|withdraw|cash out|cashout)\b/.test(t)) {
    // Fiat-denominated send: "5000 naira worth of USDC" = 5000 NGN → USDC.
    // The crypto after "worth of" is the currency; the unit is fiat.
    const worthOf = t.match(/\bworth\s+of\s+(sol|usdc)\b/);
    const asset = worthOf
      ? (worthOf[1]!.toUpperCase() as "SOL" | "USDC")
      : undefined;
    return {
      intent: "send",
      ...(amount ? { amount } : {}),
      ...(targetPhoneNumber ? { targetPhoneNumber } : {}),
      ...(targetAddress ? { targetAddress } : {}),
      ...(asset ?? currency ? { currency: asset ?? currency! } : {}),
      ...(asset ? { amountUnit: "NGN" as const } : {}),
    };
  }
  if (/\b(request|requesting)\b/.test(t) || /\bask\b.*\bfor\b/.test(t)) {
    // Money request: "request 5000 from 0803", "ask mum for 5 usdc".
    // Target = the person asked. Fiat-denominated like sends.
    const worthOf = t.match(/\bworth\s+of\s+(sol|usdc)\b/);
    const asset = worthOf
      ? (worthOf[1]!.toUpperCase() as "SOL" | "USDC")
      : undefined;
    return {
      intent: "request",
      ...(amount ? { amount } : {}),
      ...(targetPhoneNumber ? { targetPhoneNumber } : {}),
      ...(targetAddress ? { targetAddress } : {}),
      ...(asset ?? currency ? { currency: asset ?? currency! } : {}),
      ...(asset ? { amountUnit: "NGN" as const } : {}),
    };
  }
  if (/\b(balance|how much|holdings?)\b/.test(t)) {
    return { intent: "balance" };
  }
  // Verb-less fiat send: "5000 naira worth of sol to 0803" (correction
  // fragment — the model usually catches these; fallback must not balance).
  const bareWorth = t.match(/\bworth\s+of\s+(sol|usdc)\b/);
  if (bareWorth && amount && (targetPhoneNumber || targetAddress)) {
    const asset = bareWorth[1]!.toUpperCase() as "SOL" | "USDC";
    return {
      intent: "send",
      amount,
      ...(targetPhoneNumber ? { targetPhoneNumber } : {}),
      ...(targetAddress ? { targetAddress } : {}),
      currency: asset,
      amountUnit: "NGN" as const,
    };
  }
  if (/\b(history|transactions?|receipts?|statement|activity)\b/.test(t)) {
    return { intent: "history" };
  }
  return { intent: "unknown" };
}

export async function parseIntent(
  text: string,
  history: string[] = [],
): Promise<Intent & { source: "fast" | "model" }> {
  // Model-always: every message is classified by Gemini (structured
  // output, Zod-validated, sanitizer-checked). The deterministic parser
  // is the fallback — no API key, invalid output, or model failure.
  // Validators never loosen: model proposes, rules dispose.
  const fast = sanitizeIntent(fallbackIntent(text));
  const apiKey = process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey) return { ...fast, source: "fast" as const };
  const ai = new GoogleGenAI({ apiKey });
  const context =
    history.length > 0
      ? ` Recent chat (oldest first) for references like "him", "that", "the money":\n${history.slice(-6).join("\n")}`
      : "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await ai.models.generateContent({
        model: MODEL,
        contents:
          `Classify this WhatsApp wallet message. Reply with JSON only: ${text}.` +
          ` Fields: intent is one of onboarding/buy/send/balance/history/request/unknown. amount is a positive number written in digits ("two kay" is 2000). targetPhoneNumber is digits only — resolve names/pronouns ("him", "mum", "that number") against the recent chat when a number appeared there, else omit. targetAddress is a Solana base58 address (32-44 chars) when the recipient is an address, not a phone. currency is SOL, USDC, or NGN when the message names one. buyAsset is SOL or USDC when a buy names its crypto ("buy 2000 naira of sol" → buyAsset SOL). buyAmountUnit is the unit of a buy amount: SOL in "buy 1 SOL" (crypto-denominated), NGN in "buy 2000 naira" (default NGN when unclear). amountUnit is the unit of a SEND amount when fiat and crypto are both named: "send 5000 naira worth of USDC to 0803..." → amount 5000, amountUnit NGN, currency USDC. "send 0.5 SOL" → amountUnit SOL. Default amountUnit to the currency itself when only crypto is named. request is asking someone for money ("request 5000 from 0803", "ask mum for 5 usdc"): targetPhoneNumber is the person ASKED, amountUnit follows the same fiat rule as sends. Corrections ("I meant...", "no, ...", "actually...") inherit the ACTION of the most recent actionable message in history unless a new action verb (buy/send/balance/history/request) appears — "I meant 5000 naira worth of USDC" after a send is a SEND, never a buy.${context}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: intentJsonSchema,
        },
      });
      const parsed = intentSchema.safeParse(JSON.parse(res.text ?? "{}"));
      if (!parsed.success) {
        log("warn", "Intent schema validation failed, using fallback", {
          text: preview(text),
          issues: parsed.error.issues.map((i) => i.message),
        });
        return { ...fast, source: "fast" as const };
      }
      const sanitized = sanitizeIntent(parsed.data);
      if (
        sanitized.targetPhoneNumber !== parsed.data.targetPhoneNumber ||
        sanitized.amount !== parsed.data.amount
      ) {
        log("warn", "Intent field failed strict validation, dropped", {
          text: preview(text),
          raw: parsed.data,
        });
      }
      return { ...sanitized, source: "model" as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transient = TRANSIENT.test(message);
      if (transient && attempt < MAX_ATTEMPTS) {
        log("warn", "Intent model transient error, retrying", {
          attempt,
          error: message.slice(0, 200),
        });
        await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 3_000);
        continue;
      }
      log("warn", "Intent model call failed, using fallback", {
        text: preview(text),
        error: message,
      });
      return { ...fast, source: "fast" as const };
    }
  }
  return { ...fast, source: "fast" as const };
}
