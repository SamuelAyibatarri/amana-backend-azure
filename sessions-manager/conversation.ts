import type { PaymentDetails } from "../whatsappbot/payments.ts";

// Short-term conversational memory, one entry per WhatsApp phone.
// In-memory Map: correct for a single bot process. If the bot ever scales
// horizontally this must move to shared storage (Redis/Postgres).

export interface Turn {
  at: number;
  intent: string;
  amount?: number;
  targetPhoneNumber?: string;
  targetAddress?: string;
  currency?: string;
  buyAsset?: "SOL" | "USDC";
  buyAmountUnit?: "NGN" | "SOL" | "USDC";
  /** Send unit + original NGN figure (fiat-denominated sends convert once). */
  sendAmountUnit?: "NGN" | "SOL" | "USDC";
  sendNgn?: number;
  /** Clearance observed when money was discussed. */
  clearance?: string;
  /** What happened: e.g. "gated-unverified", "recalled", "user-cancelled", "pin-approved". */
  outcome?: string;
}

export type PendingState =
  | { kind: "idle" }
  | { kind: "awaitingConfirm"; details: PaymentDetails; expiresAt: number }
  | { kind: "awaitingPin"; details: PaymentDetails; expiresAt: number }
  | { kind: "awaitingAccept"; requestId: string; expiresAt: number }
  | {
      kind: "awaitingPayment";
      details: PaymentDetails;
      reference: string;
      expiresAt: number;
    };

interface Convo {
  turns: Turn[];
  pending: PendingState;
  updatedAt: number;
  /** Raw recent message texts (user side) for model reference resolution. */
  texts: string[];
  /** Last seen WhatsApp pushName (cache key for display-name resolution). */
  pushNameSeen?: string;
  /** Cached display name (null = unusable/empty). Undefined = unresolved. */
  displayName?: string | null;
}

const TTL_MS = 30 * 60 * 1_000; // 30 minutes of silence forgets everything
const MAX_TURNS = 10;

const store = new Map<string, Convo>();

function fresh(): Convo {
  return { turns: [], pending: { kind: "idle" }, updatedAt: Date.now(), texts: [] };
}

/** Fetch the convo, expiring stale pending states on access. */
export function getConvo(phone: string): Convo {
  let convo = store.get(phone);
  if (!convo) {
    convo = fresh();
    store.set(phone, convo);
    return convo;
  }
  if (Date.now() - convo.updatedAt > TTL_MS) {
    return resetConvo(phone);
  }
  if (
    convo.pending.kind !== "idle" &&
    Date.now() > convo.pending.expiresAt
  ) {
    convo.pending = { kind: "idle" };
  }
  convo.updatedAt = Date.now();
  return convo;
}

export function resetConvo(phone: string): Convo {
  const convo = fresh();
  store.set(phone, convo);
  return convo;
}

export function recordTurn(phone: string, turn: Omit<Turn, "at">): void {
  const convo = getConvo(phone);
  convo.turns.push({ ...turn, at: Date.now() });
  if (convo.turns.length > MAX_TURNS) {
    convo.turns.splice(0, convo.turns.length - MAX_TURNS);
  }
}

export function setPending(phone: string, pending: PendingState): void {
  getConvo(phone).pending = pending;
}

export function clearPending(phone: string): void {
  getConvo(phone).pending = { kind: "idle" };
}

/** Remember a raw user text (capped) for pronoun/reference resolution. */
export function rememberText(phone: string, text: string): void {
  const convo = getConvo(phone);
  convo.texts.push(text.length > 200 ? `${text.slice(0, 200)}…` : text);
  if (convo.texts.length > 6) convo.texts.splice(0, convo.texts.length - 6);
}

/** Recent user texts, oldest first. */
export function recentTexts(phone: string): string[] {
  return [...getConvo(phone).texts];
}

/**
 * Freshest params from a recent same-action turn, for follow-ups like
 * "send the money". Only fills gaps — never overrides explicit values.
 */
export function recallParams(
  phone: string,
  action: "buy" | "send",
): { amount?: number; targetPhoneNumber?: string; targetAddress?: string; currency?: string; buyAsset?: "SOL" | "USDC"; buyAmountUnit?: "NGN" | "SOL" | "USDC"; sendAmountUnit?: "NGN" | "SOL" | "USDC"; sendNgn?: number } {
  const convo = getConvo(phone);
  for (let i = convo.turns.length - 1; i >= 0; i--) {
    const t = convo.turns[i]!;
    if (t.intent !== action) continue;
    if (
      t.amount !== undefined ||
      t.targetPhoneNumber !== undefined ||
      t.targetAddress !== undefined
    ) {
      return {
        amount: t.amount,
        targetPhoneNumber: t.targetPhoneNumber,
        targetAddress: t.targetAddress,
        currency: t.currency,
        buyAsset: t.buyAsset,
        buyAmountUnit: t.buyAmountUnit,
        sendAmountUnit: t.sendAmountUnit,
        sendNgn: t.sendNgn,
      };
    }
  }
  return {};
}
