/**
 * Deterministic payment functions. The model (orchestrator) only ever fills
 * the PaymentDetails object — every user-facing string is built here, and
 * yes/no + PIN replies are parsed here without ever touching the model.
 */

import { displayPhone } from "./intent.ts";
import { formatNum } from "../sessions-manager/transfers.ts";

export interface PaymentDetails {
  action: "buy" | "send";
  amount?: number;
  /** Unit is ALWAYS set before confirmation — never "4" without "SOL". */
  currency: "SOL" | "USDC" | "NGN";
  targetPhoneNumber?: string; // E.164-ish digits (234...)
  targetAddress?: string; // Solana base58 address
  /** Buy asset for fiat on-ramp ("buy 2000 naira of SOL"). Defaults SOL. */
  buyAsset?: "SOL" | "USDC";
  /** Unit of a buy amount ("buy 1 SOL" = SOL). Defaults NGN. */
  buyAmountUnit?: "NGN" | "SOL" | "USDC";
  /** Unit of a SEND amount ("5000 naira worth of USDC" = NGN). Defaults to currency. */
  sendAmountUnit?: "NGN" | "SOL" | "USDC";
  /** Original NGN figure for fiat-denominated sends (converted at confirm). */
  sendNgn?: number;
  /** Pre-rendered conversion line for the confirm screen (set at confirm time). */
  sendQuote?: string;
  /** NGN equivalent for crypto-denominated buys (set at confirm). */
  buyNgn?: number;
  /** Pre-rendered quote line for the confirm screen (set at confirm time). */
  buyQuote?: string;
  /** False when the recipient number is on WhatsApp but not on Amana. */
  recipientLinked?: boolean;
  /** True when any value was recalled from history rather than said outright. */
  recalled: boolean;
  /** Money-request id when this send settles an accepted request. */
  requestId?: string;
  /**
   * True when the number passed format checks but WhatsApp existence
   * could not be verified (infra hiccup) — extra caution, not a block.
   */
  numberUnverified?: boolean;
}

/** Complete when strict execution could consider it: nothing inferred. */
export function isActionable(d: PaymentDetails): boolean {
  if (d.amount === undefined) return false;
  if (d.action === "send" && !d.targetPhoneNumber && !d.targetAddress) {
    return false;
  }
  return true;
}

/** Shorten a SOL address for chat: AbC1…XyZ9. */
export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

/** Human target: local-format number or shortened address. */
export function displayTarget(d: PaymentDetails): string {
  if (d.targetPhoneNumber) return displayPhone(d.targetPhoneNumber);
  if (d.targetAddress) return `sol:${shortAddress(d.targetAddress)}`;
  return "unknown recipient";
}

/** The confirmation prompt. Deterministic — the model never words this. */
export function buildConfirmMessage(d: PaymentDetails): string {
  const buyWhat =
    (d.buyAmountUnit ?? "NGN") === "NGN"
      ? `Buy ${formatNum(d.amount ?? 0, 2)} NGN of ${d.buyAsset ?? "SOL"}`
      : `Buy ${formatNum(d.amount ?? 0)} ${d.buyAmountUnit} (≈ crypto-denominated)`;
  const sendWhat =
    (d.sendAmountUnit ?? d.currency) === "NGN"
      ? `Send ≈ ${formatNum(d.amount ?? 0)} ${d.currency} (₦${(d.sendNgn ?? 0).toLocaleString("en-NG")}) to ${displayTarget(d)}`
      : `Send ${formatNum(d.amount ?? 0)} ${d.currency} to ${displayTarget(d)}`;
  const what =
    d.action === "send"
      ? `💸 ${sendWhat}${d.sendQuote ? `\n${d.sendQuote}` : ""}`
      : `💸 ${buyWhat}${d.buyQuote ? `\n${d.buyQuote}` : ""}`;
  const caution = d.recalled
    ? "\n_From our earlier chat — check carefully._\n"
    : "\n";
  const existence = d.numberUnverified
    ? "\n_I couldn't verify that number on WhatsApp — double-check it._\n"
    : "\n";
  const unlinked =
    d.action === "send" &&
    d.targetPhoneNumber &&
    d.recipientLinked === false
      ? `\n_${displayTarget(d)} isn't on Amana yet — YES creates an account for them and funds it with ${d.amount} ${d.currency}. NO cancels._\n`
      : "\n";
  return (
    `*Confirm your payment.*\n\n${what}.${caution}${existence}${unlinked}\n` +
    `Reply YES to confirm or NO to cancel.`
  );
}

/** Strict re-prompt that restates the exact payment awaiting answer. */
export function buildYesNoReprompt(d: PaymentDetails): string {
  const sendWhat =
    (d.sendAmountUnit ?? d.currency) === "NGN"
      ? `Send ≈ ${formatNum(d.amount ?? 0)} ${d.currency} (₦${(d.sendNgn ?? 0).toLocaleString("en-NG")}) to ${displayTarget(d)}`
      : `Send ${formatNum(d.amount ?? 0)} ${d.currency} to ${displayTarget(d)}`;
  const what =
    d.action === "send"
      ? `💸 ${sendWhat}`
      : `💸 Buy ${(d.buyAmountUnit ?? "NGN") === "NGN" ? `${formatNum(d.amount ?? 0, 2)} NGN` : `${formatNum(d.amount ?? 0)} ${d.buyAmountUnit}`} of ${d.buyAsset ?? "SOL"}`;
  return (
    `*I can only take YES or NO for this:*\n\n${what}.\n\n` +
    `YES confirms, NO cancels and we start over.`
  );
}

export const YES_NO_REPROMPT =
  "*Please reply YES or NO.*\n\nYES to confirm, NO to cancel.";

export const PIN_PROMPT =
  `*Enter your 4-digit PIN to approve.*\n\n` +
  `Reply with 4 digits only.\n\n` +
  `_Make sure no one is looking. After sending, delete your PIN message ` +
  `for everyone (long-press, then Delete) — and consider locking this chat ` +
  `for extra security._`;

/** Short caption paired with the PIN-guard image (same content, terse). */
export const PIN_IMAGE_CAPTION =
  `⚠️ *WAIT — READ THE IMAGE ABOVE FIRST.*\n\n` +
  `*Enter your 4-digit PIN to approve.*\n\n` +
  `Reply with 4 digits only, or NO to cancel.`;

export const PIN_REPROMPT =
  "*That isn't a 4-digit PIN.*\n\nReply with 4 digits only, or NO to cancel.";

const YES = /^(yes|y|yeah|yep|yup)$/i;
const NO = /^(no|n|nope|nah|nevermind|never mind|cancel)$/i;

/**
 * Gracious ack, not a command: "thanks", "thank youuuuu ..", "ok thanks".
 * Normalizes elongation + punctuation so gratitude variants land;
 * length-guarded so "thanks, now send 5 sol" is NOT swallowed.
 */
export function isThanks(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/(.)\1{2,}/g, "$1")
    .trim()
    .replace(/\s+/g, " ");
  if (t.length === 0 || t.length > 40) return false;
  // Strip filler words, then the WHOLE remainder must be gratitude —
  // "thanks, now send 5 sol" must not ack-and-swallow a command.
  const core = t
    .replace(/\b(ok|okay|yeah|yep|a lot|very much|so much)\b/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return /^(thanks|thank you|thank u|thx|appreciated|many thanks)$/.test(core);
}

/** Strict yes/no parser: "yes" | "no" | "invalid". Nothing else passes. */
export function parseYesNo(text: string): "yes" | "no" | "invalid" {
  const t = text.trim();
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  return "invalid";
}

const PIN = /^\d{4}$/;

/** Strict PIN parser: exactly 4 digits, else null. */
export function parsePin(text: string): string | null {
  const t = text.trim();
  return PIN.test(t) ? t : null;
}

/**
 * Fixed replies for model-classified social moments. The model decides
 * *that* it's thanks/an ack; it never words the reply. Pure + tested.
 */
export function socialReplyText(kind: string): string {
  if (kind === "thanks") return "*Anytime. 🤝*";
  return "*Noted.*";
}

/**
 * Recipient invite after a phone credit. Verified recipients are never
 * nagged about KYC — the nag (with link) is for the unverified only.
 * Pure + tested.
 */
export function inviteText(
  senderLocal: string,
  amountLabel: string,
  verified: boolean,
  kycUrl: string,
): string {
  const head = `*${senderLocal} sent you ${amountLabel} on Amana.*\n\nIt's in your account already.`;
  return verified ? head : `${head} Verify your identity and set a PIN to withdraw:\n${kycUrl}`;
}
