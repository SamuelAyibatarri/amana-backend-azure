import { hasInvalidPhone, parseIntent } from "./intent.ts";
import { displayPhone } from "./intent.ts";
import {
  checkWhatsAppNumbers,
  replyText,
  sendImage,
  sendPresence,
  type IncomingMessage,
} from "./baileys.ts";
import { getClearance } from "../sessions-manager/clearance.ts";
import { creditTransfer } from "../sessions-manager/transfers.ts";
import {
  getBalances,
  LEDGER_DECIMALS,
  formatAmount,
  minorToWhole,
} from "../sessions-manager/transfers.ts";
import { recordWithdrawal } from "../sessions-manager/transfers.ts";
import { sendSol, solscanTx } from "../solana/solana.ts";
import { burnMirror } from "../solana/solana.ts";
import { convertSendNgn, cryptoForNgn, getQuote } from "../lib/rates.ts";
import {
  maskPhone,
  receiptTimestamp,
  renderPinGuard,
  renderReceipt,
  renderWelcome,
  shortAddress,
} from "../receipts/receipts.ts";
import { greet } from "../lib/greet.ts";
import { greetingName, resolveDisplayName } from "../lib/name.ts";
import { dashboardUrl, verifyPin } from "../sessions-manager/pin.ts";
import { requestMagicLink } from "../sessions-manager/magiclink.ts";
import {
  finalizeRequestAccept,
  handleAwaitingAccept,
  handleRequestCommand,
  startRequestFlow,
} from "./requests.ts";
import {
  clearPending,
  getConvo,
  recallParams,
  recordTurn,
  recentTexts,
  rememberText,
  setPending,
} from "../sessions-manager/conversation.ts";
import {
  PIN_IMAGE_CAPTION,
  PIN_PROMPT,
  PIN_REPROMPT,
  buildConfirmMessage,
  buildYesNoReprompt,
  inviteText,
  isActionable,
  isThanks,
  parsePin,
  parseYesNo,
  socialReplyText,
  type PaymentDetails,
} from "./payments.ts";
import { log } from "../lib/log.ts";

const FRONTEND_URL =
  process.env.FRONTEND_URL ?? "http://localhost:8787";
const SHARED_SECRET = process.env.SHARED_SECRET ?? "";

// WhatsApp markdown only: *bold*, _italic_, ```monospace```.
// Keep lines short, examples on their own line, one idea per message.
const HELP =
  "*Here's what I can do:*\n" +
  "• Buy — _buy 2000 naira of sol_\n" +
  "• Send to a number — _send 0.5 sol to 08031234567_\n" +
  "• Send to an address — _send 0.1 sol to 4Fbr…42vx_ (Solana devnet, Solscan proof)\n" +
  "• Request — _request 5000 naira worth of usdc from 08031234567_\n" +
  "• Balance — _what is my balance?_\n" +
  "• History — _show my history_\n" +
  "Every payment gets a verifiable receipt image.";

// "I've verified", "done my kyc", "verification is complete", ...
const VERIFY_CLAIM = /\bverif/i;

// "I've paid", "done paying" — manual settlement check. Webhooks are
// notifications, not truth: Paystack verify decides. Only acts when a
// checkout is actually outstanding; otherwise falls through.
const PAID_CLAIM =
  /\b(i've paid|i have paid|ive paid|i don pay|done paying|payment done|i just paid|i've completed payment)\b|^paid$/i;

// Correction signals: "not X, I want Y", "instead", "I meant".
// With actionable new params, an awaitingConfirm is amended (not trashed).
const CORRECTION =
  /\b(not? |instead|i meant|i want|rather|make it|change (it|that) to)\b/i;

// "thanks", "thank youuuuu ..", "ok thanks" — gracious ack, not a HELP dump.
// Normalized matcher lives in payments.ts (isThanks) — elongation-proof.

// "do I have an account?", "have I got an account" — answer from data.
const ACCOUNT_QUESTION =
  /\bdo i have\b.*\baccount\b|\bhave i (got|an)\b.*\baccount\b|\bi have an account\?/i;

/**
 * Static KYC URL. No per-user links — the site signs users in itself
 * (Better Auth magic link delivered to their WhatsApp).
 */
function kycUrl(): string {
  return `${FRONTEND_URL.replace(/\/$/, "")}/kyc`;
}

/**
 * Money-movement gate. `buy`/`send` require a verified identity;
 * unverified users get a verification prompt with a fresh magic link —
 * never a send confirmation. Fail-closed via getClearance.
 * Returns true when the caller should stop (user was gated).
 */
async function gateUnverified(msg: IncomingMessage): Promise<boolean> {
  const clearance = await getClearance(msg.from);
  log("info", "Clearance checked", { from: maskPhone(msg.from), ...clearance });
  if (clearance.verified) return false;
  await sendVerifyPrompt(msg.from);
  return true;
}

/**
 * Contextual verify prompt (chat-first onboarding): mint a magic link
 * that signs the user in AND lands on /kyc — one tap, no typing, no
 * "Sign in first" wall. Cooldown reuses the in-chat link; failure falls
 * back to the plain KYC URL (today's behavior).
 */
async function sendVerifyPrompt(to: string, opener?: string): Promise<void> {
  const head = opener ?? "*Verify your identity first.*\n\nBuying and sending unlock after verification.";
  const link = await requestMagicLink(to, "/kyc");
  if (link === "sent") {
    await replyText(
      to,
      `${head}\n\nTap the link I just sent you — it signs you in and opens verification. One tap, expires in 15 minutes.`,
    );
    return;
  }
  if (link === "cooldown") {
    await replyText(
      to,
      `${head}\n\nI already sent you a sign-in link — check WhatsApp (it lasts 15 minutes). Tap it, verify, then come back.`,
    );
    return;
  }
  await replyText(to, `${head}\n\nVerify here:\n` + kycUrl());
}

/**
 * Route one incoming WhatsApp message to a deterministic reply.
 * Every user-facing string is hardcoded here or in payments.ts —
 * the model only fills PaymentDetails, never words replies.
 *
 * Per-user state machine: idle → awaitingConfirm → awaitingPin → idle.
 * Yes/no and PIN replies bypass the model entirely (strict parsers).
 */
export async function handleMessage(msg: IncomingMessage): Promise<void> {
  // Early typing presence — covers model inference + clearance time so the
  // user sees activity immediately. sendPresence never throws. The shorter
  // pause inside replyText then bridges classification to send.
  void sendPresence(msg.from, "composing", 2500);
  const pending = getConvo(msg.from).pending;

  // --- Confirmation gate: model never sees these replies. ---
  if (pending.kind === "awaitingConfirm") {
    // Amendment: correction signal + actionable new params replaces the
    // pending payment (re-quoted, re-gated) instead of forcing NO + restart.
    if (CORRECTION.test(msg.text)) {
      const amended = await parseIntent(msg.text, recentTexts(msg.from));
      rememberText(msg.from, msg.text);
      const fresh: PaymentDetails = {
        ...pending.details,
        recalled: true,
      };
      if (amended.intent === "buy" || amended.intent === "send") {
        if (amended.amount !== undefined) fresh.amount = amended.amount;
        if (amended.targetPhoneNumber !== undefined) {
          fresh.targetPhoneNumber = amended.targetPhoneNumber;
          fresh.targetAddress = undefined;
        }
        if (amended.targetAddress !== undefined) {
          fresh.targetAddress = amended.targetAddress;
          fresh.targetPhoneNumber = undefined;
        }
        if (amended.currency !== undefined) fresh.currency = amended.currency;
        if (amended.buyAsset !== undefined) fresh.buyAsset = amended.buyAsset;
        if (amended.buyAmountUnit !== undefined) {
          fresh.buyAmountUnit = amended.buyAmountUnit;
        }
        if (amended.amountUnit !== undefined) {
          fresh.sendAmountUnit = amended.amountUnit;
        }
        // Crypto-denominated restatement without an asset word inherits it.
        if (
          fresh.action === "buy" &&
          (fresh.buyAmountUnit ?? "NGN") !== "NGN" &&
          amended.buyAsset === undefined
        ) {
          fresh.buyAsset = pending.details.buyAsset ?? "SOL";
        }
      }
      const changed =
        JSON.stringify({ ...fresh, recalled: false }) !==
        JSON.stringify({ ...pending.details, recalled: false });
      if (
        changed &&
        (fresh.action === "buy" || fresh.action === "send") &&
        isActionable(fresh)
      ) {
        if (await gateUnverified(msg)) {
          clearPending(msg.from);
          return;
        }
        if (fresh.action === "buy" && fresh.amount !== undefined) {
          try {
            const quote = await getQuote(fresh.buyAsset ?? "SOL");
            const qUsd = fresh.buyAsset === "SOL" ? quote.solUsd : quote.usdcUsd;
            if ((fresh.buyAmountUnit ?? "NGN") === "NGN") {
              const crypto = cryptoForNgn(fresh.amount, quote);
              fresh.buyQuote =
                `≈ ${crypto.toFixed(qUsd === quote.solUsd ? 5 : 2)} ${quote.currency} ` +
                `@ $${qUsd}, ₦${quote.usdNgn}/$${quote.live ? "" : " (last known rate)"}`;
            } else {
              const ngn = fresh.amount * qUsd * quote.usdNgn;
              fresh.buyNgn = Math.round(ngn);
              fresh.buyQuote =
                `≈ ₦${Math.round(ngn).toLocaleString("en-NG")} ` +
                `@ $${qUsd}, ₦${quote.usdNgn}/$${quote.live ? "" : " (last known rate)"}`;
            }
          } catch {
            // Confirming without a fresh quote — approval re-quotes.
          }
        }
        if (fresh.action === "send" && fresh.amount !== undefined) {
          // Restated figure is in the pending unit; a fresh amount clears
          // any prior conversion so it re-converts below (never double).
          if (amended.amount !== undefined) {
            fresh.amount = amended.amount;
            fresh.sendNgn = undefined;
            fresh.sendQuote = undefined;
          }
          if (
            fresh.sendNgn === undefined &&
            (fresh.sendAmountUnit ?? fresh.currency) === "NGN" &&
            (fresh.currency === "SOL" || fresh.currency === "USDC")
          ) {
            let converted = false;
            try {
              const quote = await getQuote(fresh.currency);
              const { crypto, label } = convertSendNgn(
                fresh.amount,
                fresh.currency,
                quote,
              );
              if (Number.isFinite(crypto) && crypto > 0) {
                fresh.sendNgn = Math.round(fresh.amount);
                fresh.amount = crypto;
                fresh.sendQuote = label;
                converted = true;
              }
            } catch {
              // Fall through to refusal — approval re-quotes.
            }
            if (!converted) {
              recordTurn(msg.from, {
                intent: fresh.action,
                amount: fresh.amount,
                currency: fresh.currency,
                outcome: "quote-unavailable",
              });
              await replyText(
                msg.from,
                "*I can't re-price that right now.*\n\nNothing moved — NO cancels, or amend again.",
              );
              return;
            }
          }
          const balances = await getBalances(msg.from);
          const haveMinor = balances?.[fresh.currency] ?? -1;
          const wantMinor = Math.round(
            fresh.amount * 10 ** LEDGER_DECIMALS[fresh.currency],
          );
          if (balances === null || haveMinor < wantMinor) {
            recordTurn(msg.from, {
              intent: fresh.action,
              amount: fresh.amount,
              currency: fresh.currency,
              outcome: "insufficient",
            });
            await replyText(
              msg.from,
              balances === null
                ? "*I can't check your balance right now.*\n\nNothing moved — try again in a minute."
                : `*Not enough ${fresh.currency} for the new amount.*\n\nNothing moved — NO cancels, or amend again.`,
            );
            return;
          }
        }
        setPending(msg.from, {
          kind: "awaitingConfirm",
          details: fresh,
          expiresAt: Date.now() + 30 * 60 * 1_000,
        });
        recordTurn(msg.from, {
          intent: fresh.action,
          amount: fresh.amount,
          targetPhoneNumber: fresh.targetPhoneNumber,
          targetAddress: fresh.targetAddress,
          currency: fresh.currency,
          sendAmountUnit: fresh.sendAmountUnit,
          sendNgn: fresh.sendNgn,
          clearance: "verified",
          outcome: "amended",
        });
        await replyText(
          msg.from,
          `*Updated ✓ — confirm the new payment.*\n\n${buildConfirmMessage(fresh)}`,
        );
        return;
      }
      // Correction signal but nothing actionable: fall through to YES/NO.
    }
    const answer = parseYesNo(msg.text);
    if (answer === "yes") {
      setPending(msg.from, {
        kind: "awaitingPin",
        details: pending.details,
        expiresAt: Date.now() + 30 * 60 * 1_000,
      });
      recordTurn(msg.from, { intent: "confirmed", outcome: "confirmed" });
      // PIN-guard image on every PIN prompt; text fallback if render fails.
      try {
        await sendImage(msg.from, await renderPinGuard(), PIN_IMAGE_CAPTION);
      } catch (err) {
        log("warn", "PIN-guard image failed (text delivered)", {
          error: err instanceof Error ? err.message : String(err),
        });
        await replyText(msg.from, PIN_PROMPT);
      }
      return;
    }
    if (answer === "no") {
      clearPending(msg.from);
      recordTurn(msg.from, {
        intent: pending.details.action,
        amount: pending.details.amount,
        targetPhoneNumber: pending.details.targetPhoneNumber,
        outcome: "user-cancelled",
      });
      await replyText(
        msg.from,
        "*Payment cancelled.*\n\nNothing moved. Say the word when you're ready.",
      );
      return;
    }
    await replyText(msg.from, buildYesNoReprompt(pending.details));
    return;
  }

  // --- PIN gate: 4 digits checked against the dashboard-set PIN, or NO. ---
  // --- Request accept gate: strict ACCEPT/REJECT replies only. ---
  if (pending.kind === "awaitingAccept") {
    await handleAwaitingAccept(msg, pending.requestId);
    return;
  }

  if (pending.kind === "awaitingPin") {
    if (parseYesNo(msg.text) === "no") {
      clearPending(msg.from);
      recordTurn(msg.from, {
        intent: pending.details.action,
        outcome: "user-cancelled",
      });
      await replyText(
        msg.from,
        "*Payment cancelled.*\n\nNothing moved. Say the word when you're ready.",
      );
      return;
    }
    const pin = parsePin(msg.text);
    if (!pin) {
      await replyText(msg.from, PIN_REPROMPT);
      return;
    }
    // Real verification: the PIN lives in D1, set on the dashboard.
    const pinCheck = await verifyPin(msg.from, pin);
    if (pinCheck === "no-pin") {
      clearPending(msg.from);
      recordTurn(msg.from, {
        intent: pending.details.action,
        outcome: "pin-not-set",
      });
      await replyText(
        msg.from,
        "*You haven't set a PIN yet.*\n\nSet one on your dashboard, then start over:\n" +
          dashboardUrl(),
      );
      return;
    }
    if (pinCheck === "locked") {
      clearPending(msg.from);
      recordTurn(msg.from, {
        intent: pending.details.action,
        outcome: "pin-locked",
      });
      await replyText(
        msg.from,
        "*Too many wrong PINs — locked for 15 minutes.*\n\nWait it out, or reset your PIN on the dashboard:\n" +
          dashboardUrl(),
      );
      return;
    }
    if (pinCheck === "wrong") {
      recordTurn(msg.from, {
        intent: pending.details.action,
        outcome: "pin-wrong",
      });
      await replyText(
        msg.from,
        "*Wrong PIN.*\n\nTry again, or NO to cancel. 5 misses lock you out for 15 minutes.",
      );
      return;
    }
    if (pinCheck === "unreachable") {
      recordTurn(msg.from, {
        intent: pending.details.action,
        outcome: "pin-unchecked",
      });
      await replyText(
        msg.from,
        "*I can't reach PIN verification right now.*\n\nNothing moved — try again in a minute, or NO to cancel.",
      );
      return;
    }
    // PIN correct. Re-check clearance live — the world may have
    // changed since confirmation.
    if (await gateUnverified(msg)) {
      clearPending(msg.from);
      recordTurn(msg.from, {
        intent: pending.details.action,
        amount: pending.details.amount,
        targetPhoneNumber: pending.details.targetPhoneNumber,
        targetAddress: pending.details.targetAddress,
        currency: pending.details.currency,
        outcome: "pin-approved-but-unverified",
      });
      return;
    }
    clearPending(msg.from);
    // Approval re-check: balances may have moved since confirmation.
    // Same refusal, no ceremony — the money never leaves.
    if (
      pending.details.action === "send" &&
      pending.details.amount !== undefined
    ) {
      const balances = await getBalances(msg.from);
      const haveMinor = balances?.[pending.details.currency] ?? -1;
      const wantMinor = Math.round(
        pending.details.amount * 10 ** LEDGER_DECIMALS[pending.details.currency],
      );
      if (balances === null || haveMinor < wantMinor) {
        recordTurn(msg.from, {
          intent: pending.details.action,
          amount: pending.details.amount,
          targetPhoneNumber: pending.details.targetPhoneNumber,
          targetAddress: pending.details.targetAddress,
          currency: pending.details.currency,
          outcome:
            balances === null ? "balance-unchecked" : "insufficient-at-approval",
        });
        await replyText(
          msg.from,
          balances === null
            ? "*I can't check your balance right now.*\n\nNothing moved — try again in a minute."
            : `*Balance moved — not enough ${pending.details.currency} anymore.*\n\nNothing moved. Check your balance and try again.`,
        );
        return;
      }
    }
    // Phone sends settle internally: provision + credit the recipient,
    // invite them to claim. Nothing on-chain yet — the transfer row is
    // the ledger seed.
    if (
      pending.details.action === "send" &&
      pending.details.targetPhoneNumber &&
      pending.details.amount !== undefined
    ) {
      const credit = await creditTransfer({
        senderPhone: msg.from,
        recipientPhone: pending.details.targetPhoneNumber,
        amount: pending.details.amount,
        currency: pending.details.currency,
        // Phone sends move liability between users — mirror leg is
        // net-zero (single-tx mint+burn), never a mint.
        netZero: true,
      });
      if (!credit.ok) {
        recordTurn(msg.from, {
          intent: pending.details.action,
          amount: pending.details.amount,
          targetPhoneNumber: pending.details.targetPhoneNumber,
          currency: pending.details.currency,
          clearance: "verified",
          outcome: "credit-failed",
        });
        await replyText(
          msg.from,
          "*Couldn't move the money — try again in a minute.*\n\nNothing left your account.",
        );
        return;
      }
      const local = displayPhone(pending.details.targetPhoneNumber);
      // Accepted money request: finalize it + tell the requester.
      if (pending.details.requestId) {
        await finalizeRequestAccept(pending.details.requestId, msg.from);
      }
      // Invite the recipient (one per transfer — the credit is idempotent
      // per approval, so no spam loop). Verified recipients are never
      // nagged about KYC — the nag is for the unverified only.
      const inviteClearance = await getClearance(pending.details.targetPhoneNumber);
      void replyText(
        pending.details.targetPhoneNumber,
        inviteText(
          displayPhone(msg.from),
          formatAmount(pending.details.amount ?? 0, pending.details.currency),
          inviteClearance.verified,
          kycUrl(),
        ),
      );
      recordTurn(msg.from, {
        intent: pending.details.action,
        amount: pending.details.amount,
        targetPhoneNumber: pending.details.targetPhoneNumber,
        currency: pending.details.currency,
        clearance: "verified",
        outcome: credit.recipientCreated ? "credited-new-account" : "credited",
      });
      await replyText(
        msg.from,
        credit.recipientCreated
          ? `*Sent ${formatAmount(pending.details.amount ?? 0, pending.details.currency)} to ${local}.*\n\nThey weren't on Amana — an account was created and funded for them. We've invited them to verify and withdraw.`
          : `*Sent ${formatAmount(pending.details.amount ?? 0, pending.details.currency)} to ${local}.*\n\nIt's in their Amana account.`,
      );
      // Image receipt with the same text as caption (masked phones).
      // Render/send failures fall back to the text already delivered.
      if (credit.transferId) {
        try {
          const caption =
            `*🧾 Receipt — sent ${formatAmount(pending.details.amount ?? 0, pending.details.currency)} to ${maskPhone(pending.details.targetPhoneNumber)}.*\n\n` +
            `Transfer ID:\n\`\`\`${credit.transferId}\`\`\``;
          const png = await renderReceipt({
            kind: "credit",
            amount: pending.details.amount,
            currency: pending.details.currency,
            fromPhone: msg.from,
            toPhone: pending.details.targetPhoneNumber,
            transferId: credit.transferId,
            receiptUrl: `${FRONTEND_URL.replace(/\/$/, "")}/receipt/${credit.transferId}`,
            timestamp: receiptTimestamp(),
          });
          await sendImage(msg.from, png, caption);
        } catch (err) {
          log("warn", "Credit receipt image failed (text delivered)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }
    // Buy: quote fresh, initialize Paystack checkout, deliver the link.
    // Settlement lands via webhook → /buy/settle (credit + mirror).
    if (pending.details.action === "buy" && pending.details.amount !== undefined) {
      const asset = pending.details.buyAsset ?? "SOL";
      const unit = pending.details.buyAmountUnit ?? "NGN";
      try {
        const quote = await getQuote(asset);
        const usd = asset === "SOL" ? quote.solUsd : quote.usdcUsd;
        const liveFlag = quote.live ? "" : " (last known rate)";
        // NGN-denominated: convert to crypto. Crypto-denominated: the
        // amount IS the crypto; NGN is derived for the Paystack charge.
        const ngn =
          unit === "NGN"
            ? pending.details.amount
            : Math.round(pending.details.amount * usd * quote.usdNgn);
        const crypto =
          unit === "NGN"
            ? cryptoForNgn(ngn, quote)
            : pending.details.amount;
        const rateLabel =
          unit === "NGN"
            ? `≈ ${crypto.toFixed(asset === "SOL" ? 5 : 2)} ${asset} ` +
              `@ $${usd}, ₦${quote.usdNgn}/$${liveFlag}`
            : `${crypto} ${asset} ≈ ₦${ngn.toLocaleString("en-NG")} ` +
              `@ $${usd}, ₦${quote.usdNgn}/$${liveFlag}`;
        const initRes = await fetch(
          `${FRONTEND_URL.replace(/\/$/, "")}/api/payments/initialize`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-amana-secret": SHARED_SECRET,
            },
            body: JSON.stringify({
              amountKobo: Math.round(ngn * 100),
              email: `${msg.from}@amana.whatsapp`,
              metadata: {
                kind: "buy",
                phone: msg.from,
                asset,
                ngn,
                crypto,
                rateLabel,
                quotedAt: quote.at,
              },
            }),
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (!initRes.ok) {
          throw new Error(`initialize ${initRes.status}`);
        }
        const init = (await initRes.json()) as {
          ok?: unknown;
          authorization_url?: unknown;
          reference?: unknown;
        };
        if (init.ok !== true || typeof init.authorization_url !== "string") {
          throw new Error("initialize rejected");
        }
        clearPending(msg.from);
        recordTurn(msg.from, {
          intent: "buy",
          amount: ngn,
          currency: "NGN",
          clearance: "verified",
          outcome: "checkout-sent",
        });
        // Remember the outstanding checkout: "I've paid" verifies it
        // against Paystack (webhook-independent). NO cancels.
        setPending(msg.from, {
          kind: "awaitingPayment",
          details: pending.details,
          reference:
            typeof init.reference === "string" ? init.reference : "",
          expiresAt: Date.now() + 30 * 60 * 1_000,
        });
        await replyText(
          msg.from,
          `*Pay ₦${ngn.toLocaleString("en-NG")} to receive ${rateLabel}.*\n\nCheckout (test mode — use a Paystack test card):\n${init.authorization_url}\n\nI'll confirm here the moment it lands.`,
        );
      } catch (err) {
        log("error", "Buy initialize failed", {
          from: msg.from,
          error: err instanceof Error ? err.message : String(err),
        });
        recordTurn(msg.from, {
          intent: "buy",
          amount: pending.details.amount,
          currency: "NGN",
          clearance: "verified",
          outcome: "checkout-failed",
        });
        await replyText(
          msg.from,
          "*Couldn't start checkout — try again in a minute.*\n\nNothing was charged.",
        );
      }
      return;
    }
    // SOL and USDC settle on-chain from treasury stock (native / SPL
    // legs); NGN has no chain leg — refused deterministically.
    if (
      pending.details.action === "send" &&
      pending.details.targetAddress &&
      pending.details.amount !== undefined
    ) {
      const short = `${pending.details.targetAddress.slice(0, 4)}…${pending.details.targetAddress.slice(-4)}`;
      const asset = pending.details.currency;
      if (asset !== "SOL" && asset !== "USDC") {
        recordTurn(msg.from, {
          intent: pending.details.action,
          amount: pending.details.amount,
          targetAddress: pending.details.targetAddress,
          currency: pending.details.currency,
          clearance: "verified",
          outcome: "address-non-crypto-refused",
        });
        await replyText(
          msg.from,
          `*I can only send SOL or USDC to Solana addresses — not ${pending.details.currency}.*\n\n` +
            `Send ${pending.details.currency} to a phone number instead.`,
        );
        return;
      }
      const minorUnits = asset === "SOL" ? 1_000_000_000 : 1_000_000;
      try {
        const { sendUsdc } = await import("../solana/solana.ts");
        const sig =
          asset === "SOL"
            ? await sendSol(pending.details.targetAddress, pending.details.amount)
            : await sendUsdc(pending.details.targetAddress, pending.details.amount);
        // Withdrawal landed — retire the matching mirror from the
        // reserve. A burn failure is a mirror-gap (logged, reconciled
        // later); the chain movement itself is truth.
        try {
          await burnMirror(asset, pending.details.amount);
        } catch (burnErr) {
          log("error", "Mirror gap: crypto sent, mirror burn failed", {
            from: msg.from,
            error: burnErr instanceof Error ? burnErr.message : String(burnErr),
          });
        }
        // Record the withdrawal so net liabilities stay exact
        // (proof-of-liability invariant). Best-effort.
        void recordWithdrawal({
          senderPhone: msg.from,
          address: pending.details.targetAddress,
          amountMinor: Math.round(pending.details.amount * minorUnits),
          currency: asset,
          signature: sig,
        });
        recordTurn(msg.from, {
          intent: pending.details.action,
          amount: pending.details.amount,
          targetAddress: pending.details.targetAddress,
          currency: pending.details.currency,
          clearance: "verified",
          outcome: "sent-onchain",
        });
        await replyText(
          msg.from,
          `*Sent ${formatAmount(pending.details.amount ?? 0, asset)} to ${short} — on Solana devnet.*\n\n_Proof:_\n${solscanTx(sig)}`,
        );
        // Image receipt (masked, QR to Solscan). Text above already
        // delivered — failures here are logged, not retried.
        try {
          const url = solscanTx(sig);
          const png = await renderReceipt({
            kind: "onchain",
            amount: pending.details.amount,
            toAddress: pending.details.targetAddress,
            signature: sig,
            solscanUrl: url,
            timestamp: receiptTimestamp(),
            unit: asset,
          });
          await sendImage(
            msg.from,
            png,
            `*🧾 Receipt — ${formatAmount(pending.details.amount ?? 0, asset)} to ${short}.*\n\n_Verify:_\n${url}`,
          );
        } catch (err) {
          log("warn", "On-chain receipt image failed (text delivered)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (err) {
        log("error", "On-chain send failed", {
          from: msg.from,
          error: err instanceof Error ? err.message : String(err),
        });
        recordTurn(msg.from, {
          intent: pending.details.action,
          amount: pending.details.amount,
          targetAddress: pending.details.targetAddress,
          currency: pending.details.currency,
          clearance: "verified",
          outcome: "onchain-failed",
        });
        await replyText(
          msg.from,
          "*The chain didn't take it — nothing left your account.*\n\nTry again in a minute, or NO to cancel.",
        );
      }
      return;
    }
    recordTurn(msg.from, {
      intent: pending.details.action,
      amount: pending.details.amount,
      targetPhoneNumber: pending.details.targetPhoneNumber,
      targetAddress: pending.details.targetAddress,
      currency: pending.details.currency,
      clearance: "verified",
      outcome: "pin-approved",
    });
    await replyText(
      msg.from,
      "*Approved.*\n\nOn-chain execution lands next — _nothing moved yet._",
    );
    return;
  }

  // "Do I have an account?" — answer from data, not classification.
  if (PAID_CLAIM.test(msg.text) && pending.kind === "awaitingPayment") {
    if (parseYesNo(msg.text) === "no") {
      clearPending(msg.from);
      recordTurn(msg.from, { intent: "buy", outcome: "user-cancelled" });
      await replyText(
        msg.from,
        "*Payment cancelled.*\n\nNothing moved. Say the word when you're ready.",
      );
      return;
    }
    await replyText(msg.from, "*Checking your payment…*");
    try {
      const checkRes = await fetch(
        `${FRONTEND_URL.replace(/\/$/, "")}/api/payments/check`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-amana-secret": SHARED_SECRET,
          },
          body: JSON.stringify({ phone: msg.from }),
          signal: AbortSignal.timeout(25_000),
        },
      );
      const check = (await checkRes.json()) as {
        ok?: unknown;
        settled?: unknown;
        reason?: unknown;
      };
      if (check.ok === true && check.settled === true) {
        // Settlement posts its own confirmation + receipt in chat.
        clearPending(msg.from);
        recordTurn(msg.from, {
          intent: "buy",
          amount: pending.details.amount,
          currency: pending.details.currency,
          clearance: "verified",
          outcome: "paid-claim-settled",
        });
        return;
      }
      if (check.reason === "no-pending") {
        // Webhook (or an earlier check) already settled it — stale state.
        clearPending(msg.from);
        recordTurn(msg.from, { intent: "buy", outcome: "paid-claim-stale" });
        await replyText(
          msg.from,
          "*No pending payment on my side.*\n\nIf you just paid, the confirmation may already be on its way — give it a minute.",
        );
        return;
      }
      recordTurn(msg.from, { intent: "buy", outcome: "paid-claim-pending" });
      await replyText(
        msg.from,
        "*Not seeing it yet.*\n\nIf you just paid, wait a minute and say _I've paid_ again — or NO to cancel.",
      );
    } catch (err) {
      log("warn", "Paid-claim check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      await replyText(
        msg.from,
        "*Couldn't reach payments right now.*\n\nNothing moved — try _I've paid_ again in a minute.",
      );
    }
    return;
  }

  // (Thanks/greetings are model-classified as the `social` intent —
  // isThanks survives only as the no-model fallback in `unknown` below.)

  if (ACCOUNT_QUESTION.test(msg.text)) {
    const clearance = await getClearance(msg.from);
    log("info", "Clearance checked", { from: maskPhone(msg.from), ...clearance });
    recordTurn(msg.from, {
      intent: "account-question",
      clearance: clearance.status,
      outcome: "answered",
    });
    if (clearance.source === "unreachable") {
      await replyText(
        msg.from,
        "*I can't check right now.*\n\nMy records are unreachable — try again in a minute.",
      );
      return;
    }
    if (clearance.status === "unknown") {
      await replyText(
        msg.from,
        "*No account yet.*\n\nSay hello and I'll set you up — then I'll send your verification link here.",
      );
      return;
    }
    if (clearance.verified) {
      await replyText(msg.from, "*Yes — and you're verified.*\n\n" + HELP);
      return;
    }
    await sendVerifyPrompt(msg.from);
    return;
  }

  // Request privacy/cancel commands (strict, anchored — normal speech safe).
  if (await handleRequestCommand(msg)) return;

  // Verification claims bypass classification entirely: whatever the model
  // says ("I've verified", "is my account verified?"), answer from a live
  // clearance check — never from the claim, never from the label.
  if (VERIFY_CLAIM.test(msg.text)) {
    const clearance = await getClearance(msg.from);
    log("info", "Clearance checked", { from: maskPhone(msg.from), ...clearance });
    recordTurn(msg.from, {
      intent: "verify-claim",
      clearance: clearance.status,
      outcome: clearance.verified ? "claim-confirmed" : "claim-rejected",
    });
    if (clearance.verified) {
      await replyText(
        msg.from,
        "*You're verified — welcome aboard.*\n\n" + HELP,
      );
      return;
    }
    await sendVerifyPrompt(
      msg.from,
      "*I checked just now and I can't confirm your verification yet.*\n\nFinish the steps, then tell me.",
    );
    return;
  }

  const intent = await parseIntent(msg.text, recentTexts(msg.from));
  rememberText(msg.from, msg.text);
  log("info", "Intent parsed", {
    from: maskPhone(msg.from),
    textLen: msg.text.length,
    ...intent,
  });

  switch (intent.intent) {
    case "onboarding": {
      // Greet from data + time + name. Verified users get a plain
      // greeting (no status nag); first contact gets the welcome image
      // once; pending users get the KYC nudge.
      const clearance = await getClearance(msg.from);
      recordTurn(msg.from, {
        intent: "onboarding",
        clearance: clearance.status,
        outcome: clearance.verified ? "welcome-back" : "welcomed",
      });
      const resolved = await resolveDisplayName(msg.from, msg.pushName, clearance.name);
      log("info", "Display name resolved", {
        from: maskPhone(msg.from),
        via: resolved.via,
        hasName: resolved.name !== null,
      });
      const hello = greet(greetingName(resolved));
      if (clearance.verified) {
        await replyText(msg.from, `${hello}\n\nWelcome back.\n\n${HELP}`);
        return;
      }
      if (clearance.source === "unreachable") {
        await replyText(
          msg.from,
          `${hello}\n\nYour wallet lives here in chat.\n\n` +
            "I can't check records right now — try again in a minute.",
        );
        return;
      }
      if (clearance.status !== "unknown") {
        await replyText(
          msg.from,
          `${hello}\n\nYour wallet lives here in chat.\n\n` +
            "Verify your identity here to unlock buying and sending:\n" +
            kycUrl(),
        );
        return;
      }
      await replyText(
        msg.from,
        `${hello} 👋\n\n*Welcome to Amana* — your wallet lives right here in chat.\n\n` +
          `Buy crypto with naira. Send to any phone number or Solana address. ` +
          `Every payment gets a receipt you can verify.\n\n` +
          `*Start here:*\n` +
          `1. Verify your identity (link below) — unlocks buying + sending\n` +
          `2. Set a 4-digit transaction PIN on your dashboard\n` +
          `3. Say _"send 0.5 SOL to 0803..."_ and follow the prompts\n\n` +
          `Your money moves only when *you* confirm with your PIN. Nobody else can spend it — not even us.\n\n` +
          "Verify your identity here to unlock buying and sending:\n" +
          kycUrl(),
      );
      // First-contact welcome image (once — returning users skip it).
      try {
        const png = await renderWelcome(kycUrl());
        await sendImage(
          msg.from,
          png,
          "*Start here:* verify with the link or QR, set a transaction PIN on your dashboard, then say _send 0.5 SOL to 08031234567_.",
        );
      } catch (err) {
        log("warn", "Welcome image failed (text delivered)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    case "buy":
    case "send": {
      // Functional default currency (settings): fills unnamed units.
      // Chat always prints the unit — nothing inferred silently.
      const userDefault = (await getClearance(msg.from)).defaultCurrency;
      const details: PaymentDetails = {
        action: intent.intent,
        amount: intent.amount,
        currency:
          intent.currency ??
          (intent.intent === "send" ? (userDefault ?? "SOL") : "NGN"),
        targetPhoneNumber: intent.targetPhoneNumber,
        targetAddress: intent.targetAddress,
        // Buy asset: explicit "of SOL/USDC", else default currency when
        // crypto, else SOL. Never NGN (fiat in).
        buyAsset:
          intent.intent === "buy"
            ? (intent.buyAsset ??
              (userDefault === "USDC" || userDefault === "SOL" ? userDefault : "SOL"))
            : undefined,
        // Buy amount unit: "buy 1 SOL" is crypto-denominated, else NGN.
        buyAmountUnit:
          intent.intent === "buy"
            ? (intent.buyAmountUnit ?? "NGN")
            : undefined,
        // Send amount unit: "5000 naira worth of USDC" is NGN-denominated
        // (converted at confirm); otherwise the currency itself.
        sendAmountUnit:
          intent.intent === "send"
            ? (intent.amountUnit ??
              intent.currency ??
              (userDefault === "USDC" || userDefault === "SOL" ? userDefault : "SOL"))
            : undefined,
        recalled: false,
      };
      // Fill gaps from recent same-action history ("send the money").
      // Recalled values are flagged — they always face confirmation.
      if (
        details.amount === undefined ||
        (intent.intent === "send" &&
          !details.targetPhoneNumber &&
          !details.targetAddress)
      ) {
        const recalled = recallParams(msg.from, intent.intent);
        if (details.amount === undefined && recalled.amount !== undefined) {
          details.amount = recalled.amount;
          details.recalled = true;
        }
        if (!details.targetPhoneNumber && recalled.targetPhoneNumber) {
          details.targetPhoneNumber = recalled.targetPhoneNumber;
          details.recalled = true;
        }
        if (!details.targetAddress && recalled.targetAddress) {
          details.targetAddress = recalled.targetAddress;
          details.recalled = true;
        }
        if (intent.intent === "buy" && !intent.buyAsset && recalled.buyAsset) {
          details.buyAsset = recalled.buyAsset;
          details.recalled = true;
        }
        if (intent.intent === "buy" && !intent.buyAmountUnit && recalled.buyAmountUnit) {
          details.buyAmountUnit = recalled.buyAmountUnit;
          details.recalled = true;
        }
        if (intent.intent === "send" && !intent.amountUnit && recalled.sendAmountUnit) {
          details.sendAmountUnit = recalled.sendAmountUnit;
          details.recalled = true;
        }
        // Recalled fiat send: amount is already converted crypto — carry
        // the NGN figure so the confirm screen still shows it.
        if (
          intent.intent === "send" &&
          details.sendNgn === undefined &&
          recalled.sendNgn !== undefined &&
          details.amount !== undefined
        ) {
          details.sendNgn = recalled.sendNgn;
        }
      }
      // NGN rail is fiction until bank cash-out exists (PLAN.md): refuse
      // deterministically, before confirmation ceremony.
      if (details.action === "send" && details.currency === "NGN") {
        recordTurn(msg.from, {
          intent: intent.intent,
          amount: details.amount,
          targetPhoneNumber: details.targetPhoneNumber,
          targetAddress: details.targetAddress,
          currency: details.currency,
          outcome: "ngn-refused",
        });
        await replyText(
          msg.from,
          "*NGN sends aren't live yet.*\n\nNaira moves with bank cash-out, which is coming — for now, send SOL or USDC.",
        );
        return;
      }
      if (!isActionable(details)) {
        recordTurn(msg.from, {
          intent: intent.intent,
          amount: details.amount,
          targetPhoneNumber: details.targetPhoneNumber,
          targetAddress: details.targetAddress,
          currency: details.currency,
          outcome: "missing-params",
        });
        // Name exactly what's missing and echo what was captured —
        // never a blanket "need everything" when half was given.
        // An invalid number is reported as invalid, not as missing.
        const missingAmount = details.amount === undefined;
        const missingTarget =
          intent.intent === "send" &&
          !details.targetPhoneNumber &&
          !details.targetAddress;
        // Echo the stated figure in its own unit (fiat sends show ₦,
        // converted crypto shows at confirm — never "5000 USDC").
        const gapAmt =
          details.action === "send" &&
          (details.sendAmountUnit ?? details.currency) === "NGN" &&
          (details.currency === "SOL" || details.currency === "USDC") &&
          details.amount !== undefined
            ? `₦${details.amount.toLocaleString("en-NG")} (≈ ${details.currency})`
            : `${details.amount} ${details.currency}`;
        let gap: string;
        if (missingTarget && hasInvalidPhone(msg.text)) {
          gap =
            `*That recipient doesn't look right.*\n\n` +
            `I need a Nigerian mobile number — 11 digits starting with 0, ` +
            `e.g. 08031234567 — or a Solana address (base58, 32-44 chars).\nTry:\n_send ${details.amount ?? "0.5"} ${details.currency} to 08031234567_ or _send ${details.amount ?? "0.5"} ${details.currency} to 4Fbr…42vx_`;
        } else if (intent.intent === "buy" || (missingAmount && !missingTarget)) {
          gap =
            `*How much?*\n\n` +
            (details.targetPhoneNumber
              ? `Got the number ${displayPhone(details.targetPhoneNumber)} — now the amount.\nTry:\n_send 0.5 ${details.currency} to ${displayPhone(details.targetPhoneNumber)}_`
              : `Try:\n_buy 2000 naira of sol_`);
        } else if (missingTarget && !missingAmount) {
          gap =
            `*Who to?*\n\nGot the amount ${gapAmt} — now the recipient: a number or a Solana address.\nTry:\n_send ${details.amount} ${details.currency} to 08031234567_\n_or_\n_send ${details.amount} ${details.currency} to 4Fbr…42vx_`;
        } else {
          gap =
            `*I need an amount and a recipient.*\n\nA number or a Solana address works.\nTry:\n_send 0.5 SOL to 08031234567_`;
        }
        await replyText(msg.from, gap);
        return;
      }
      // Strict order: clearance BEFORE confirmation — never confirm a
      // payment for an unverified user.
      if (await gateUnverified(msg)) {
        recordTurn(msg.from, {
          intent: intent.intent,
          amount: details.amount,
          targetPhoneNumber: details.targetPhoneNumber,
          targetAddress: details.targetAddress,
          currency: details.currency,
          outcome: "gated-unverified",
        });
        return;
      }
      // Phone targets must exist on WhatsApp. Addresses skip this
      // (on-chain validity lands with the wallet engine).
      if (details.targetPhoneNumber) {
        const seen = await checkWhatsAppNumbers([details.targetPhoneNumber]);
        const key = details.targetPhoneNumber.replace(/\D/g, "");
        const exists = seen?.get(key) ?? seen?.get(`0${key.slice(3)}`);
        if (seen && exists === false) {
          recordTurn(msg.from, {
            intent: intent.intent,
            amount: details.amount,
            targetPhoneNumber: details.targetPhoneNumber,
            currency: details.currency,
            outcome: "unknown-recipient",
          });
          await replyText(
            msg.from,
            `*That number isn't on WhatsApp.*\n\n${displayPhone(details.targetPhoneNumber)} doesn't look like a registered account — check the digits and try again.`,
          );
          return;
        }
        if (!seen) details.numberUnverified = true;
        // On WhatsApp but maybe not on Amana — the confirm screen says so.
        const recipient = await getClearance(details.targetPhoneNumber);
        if (recipient.source === "frontend") {
          details.recipientLinked = recipient.linked;
        }
      }
      // Fiat-denominated send ("5000 naira worth of USDC"): convert NGN
      // → crypto at confirm time. The confirm screen shows the converted
      // figure + rate; the debit gate and execution below run on crypto.
      // sendNgn set means already converted (recalled) — never double.
      if (
        details.action === "send" &&
        details.amount !== undefined &&
        details.sendNgn === undefined &&
        (details.sendAmountUnit ?? details.currency) === "NGN" &&
        (details.currency === "SOL" || details.currency === "USDC")
      ) {
        let converted = false;
        try {
          const quote = await getQuote(details.currency);
          const { crypto, label } = convertSendNgn(
            details.amount,
            details.currency,
            quote,
          );
          if (Number.isFinite(crypto) && crypto > 0) {
            details.sendNgn = Math.round(details.amount);
            details.amount = crypto;
            details.sendQuote = label;
            converted = true;
          }
        } catch (err) {
          log("warn", "Send conversion failed (refusing)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (!converted) {
          recordTurn(msg.from, {
            intent: intent.intent,
            amount: details.amount,
            targetPhoneNumber: details.targetPhoneNumber,
            targetAddress: details.targetAddress,
            currency: details.currency,
            outcome: "quote-unavailable",
          });
          await replyText(
            msg.from,
            "*I can't price that right now.*\n\nNothing moved — try again in a minute.",
          );
          return;
        }
      }
      // Debit gate at confirm: refuse above net liabilities, fail fast.
      // (Approval re-checks — the 30-min window can move balances.)
      if (details.action === "send" && details.amount !== undefined) {
        const balances = await getBalances(msg.from);
        if (!balances) {
          recordTurn(msg.from, {
            intent: intent.intent,
            amount: details.amount,
            targetPhoneNumber: details.targetPhoneNumber,
            targetAddress: details.targetAddress,
            currency: details.currency,
            outcome: "balance-unchecked",
          });
          await replyText(
            msg.from,
            "*I can't check your balance right now.*\n\nNothing moved — try again in a minute.",
          );
          return;
        }
        const haveMinor = balances[details.currency] ?? 0;
        const wantMinor = Math.round(
          details.amount * 10 ** LEDGER_DECIMALS[details.currency],
        );
        if (haveMinor < wantMinor) {
          const have = formatAmount(
            minorToWhole(haveMinor, details.currency),
            details.currency,
          );
          recordTurn(msg.from, {
            intent: intent.intent,
            amount: details.amount,
            targetPhoneNumber: details.targetPhoneNumber,
            targetAddress: details.targetAddress,
            currency: details.currency,
            outcome: "insufficient",
          });
          await replyText(
            msg.from,
            `*Not enough ${details.currency}.*\n\nYou have ${have} — that's short of ${formatAmount(details.amount ?? 0, details.currency)}. Buy first or lower the amount.`,
          );
          return;
        }
      }
      setPending(msg.from, {
        kind: "awaitingConfirm",
        details,
        expiresAt: Date.now() + 30 * 60 * 1_000,
      });
      // Buy confirms show a live ≈ quote (execution re-quotes; the
      // receipt prints the rate actually used). Crypto-denominated buys
      // ("buy 1 SOL") flip the math: NGN equivalent shown, crypto exact.
      if (details.action === "buy" && details.amount !== undefined) {
        try {
          const quote = await getQuote(details.buyAsset ?? "SOL");
          const usd = quote.currency === "SOL" ? quote.solUsd : quote.usdcUsd;
          const liveFlag = quote.live ? "" : " (last known rate)";
          if ((details.buyAmountUnit ?? "NGN") === "NGN") {
            const crypto = cryptoForNgn(details.amount, quote);
            details.buyQuote =
              `≈ ${crypto.toFixed(quote.currency === "SOL" ? 5 : 2)} ${quote.currency} ` +
              `@ $${usd}, ₦${quote.usdNgn}/$${liveFlag}`;
          } else {
            const ngn = details.amount * usd * quote.usdNgn;
            details.buyNgn = Math.round(ngn);
            details.buyQuote =
              `≈ ₦${Math.round(ngn).toLocaleString("en-NG")} ` +
              `@ $${usd}, ₦${quote.usdNgn}/$${liveFlag}`;
          }
        } catch (err) {
          log("warn", "Buy quote failed (confirming without)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      recordTurn(msg.from, {
        intent: intent.intent,
        amount: details.amount,
        targetPhoneNumber: details.targetPhoneNumber,
        targetAddress: details.targetAddress,
        currency: details.currency,
        buyAsset: details.buyAsset,
        buyAmountUnit: details.buyAmountUnit,
        sendAmountUnit: details.sendAmountUnit,
        sendNgn: details.sendNgn,
        clearance: "verified",
        outcome: details.recalled ? "recalled" : "confirming",
      });
      await replyText(msg.from, buildConfirmMessage(details));
      return;
    }
    case "balance": {
      recordTurn(msg.from, { intent: "balance" });
      const balances = await getBalances(msg.from);
      if (!balances) {
        await replyText(
          msg.from,
          "*I can't check your balance right now.*\n\nTry again in a minute.",
        );
        return;
      }
      // Net-worth view: per-asset lines with fiat equivalents, plus a
      // total. No NGN row — the naira rail is fiction until bank
      // cash-out exists (PLAN.md), so only its valuation shows.
      const fPlain = (minor: number, c: "SOL" | "USDC"): string =>
        formatAmount(minorToWhole(minor, c), c);
      try {
        const { getQuote } = await import("../lib/rates.ts");
        const quote = await getQuote("SOL");
        const f = (minor: number, c: "SOL" | "USDC"): string => {
          const whole = minorToWhole(minor, c);
          const usd = c === "SOL" ? quote.solUsd : quote.usdcUsd;
          return `${formatAmount(whole, c)} (≈ ₦${Math.round(whole * usd * quote.usdNgn).toLocaleString("en-NG")})`;
        };
        const total = Math.round(
          minorToWhole(balances.SOL, "SOL") * quote.solUsd * quote.usdNgn +
            minorToWhole(balances.USDC, "USDC") * quote.usdcUsd * quote.usdNgn,
        );
        await replyText(
          msg.from,
          `*💰 Your balance:*\n• ${f(balances.SOL, "SOL")}\n• ${f(balances.USDC, "USDC")}\n*Worth ≈ ₦${total.toLocaleString("en-NG")} total*${quote.live ? "" : "\n_(last known rate)_"}`,
        );
      } catch {
        await replyText(
          msg.from,
          `*💰 Your balance:*\n• ${fPlain(balances.SOL, "SOL")}\n• ${fPlain(balances.USDC, "USDC")}`,
        );
      }
      return;
    }
    case "request": {
      const userDefault = (await getClearance(msg.from)).defaultCurrency;
      recordTurn(msg.from, {
        intent: "request",
        amount: intent.amount,
        targetPhoneNumber: intent.targetPhoneNumber,
        currency: intent.currency,
        outcome: "started",
      });
      await startRequestFlow(
        msg,
        {
          amount: intent.amount,
          amountUnit: intent.amountUnit,
          currency: intent.currency as "SOL" | "USDC" | "NGN" | undefined,
          targetPhoneNumber: intent.targetPhoneNumber,
        },
        userDefault ?? undefined,
      );
      return;
    }
    case "history": {
      recordTurn(msg.from, { intent: "history" });
      let items: Array<{
        amountMinor: number;
        currency: string;
        status: string;
        direction: string;
        senderPhone: string | null;
        recipientPhone: string | null;
        recipientAddress: string | null;
        createdAt: string;
      }> = [];
      try {
        const res = await fetch(
          `${FRONTEND_URL.replace(/\/$/, "")}/api/transfers/history?phone=${encodeURIComponent(msg.from)}&limit=10`,
          {
            headers: { "x-amana-secret": SHARED_SECRET },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (res.ok) {
          const body = (await res.json()) as { ok?: unknown; items?: typeof items };
          if (body.ok === true && Array.isArray(body.items)) items = body.items;
        }
      } catch (err) {
        log("warn", "History fetch failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (items.length === 0) {
        await replyText(
          msg.from,
          "*No transactions yet.*\n\nYour history will appear here after your first buy.",
        );
        return;
      }
      const decimals: Record<string, number> = { SOL: 9, USDC: 6, NGN: 2 };
      const lines = items.slice(0, 8).map((t) => {        const whole =
          t.amountMinor / 10 ** (decimals[t.currency] ?? 2);
        const arrow = t.direction === "in" ? "📩" : "📤";
        const party =
          t.direction === "in"
            ? t.senderPhone === "PAYSTACK"
              ? "Paystack"
              : maskPhone(t.senderPhone ?? "")
            : t.recipientPhone
              ? maskPhone(t.recipientPhone)
              : shortAddress(t.recipientAddress ?? "");
        const kind = t.status === "withdrawn" ? "withdrew" : t.direction === "in" ? "from" : "to";
        return `${arrow} ${formatAmount(whole, t.currency)} ${kind} ${party}`;
      });
      await replyText(msg.from, `*📋 Recent activity:*\n${lines.join("\n")}`);
      return;
    }
    case "social": {
      const kind = intent.socialKind ?? "other";
      if (kind === "thanks") {
        recordTurn(msg.from, { intent: "social", outcome: "thanks-acknowledged" });
        await replyText(msg.from, socialReplyText("thanks"));
        return;
      }
      if (kind === "greeting") {
        const clearance = await getClearance(msg.from);
        const resolved = await resolveDisplayName(msg.from, msg.pushName, clearance.name);
        recordTurn(msg.from, {
          intent: "social",
          clearance: clearance.status,
          outcome: "greeted",
        });
        await replyText(
          msg.from,
          `${greet(greetingName(resolved))}\n\nSay the word — buy, send, request, balance, history.`,
        );
        return;
      }
      recordTurn(msg.from, { intent: "social", outcome: "ack-acknowledged" });
      await replyText(msg.from, socialReplyText(kind));
      return;
    }
    case "unknown":
    default: {
      // No-model fallback: deterministic thanks read (the model owns
      // social language whenever a key is configured).
      if (isThanks(msg.text)) {
        recordTurn(msg.from, { intent: "thanks", outcome: "acknowledged" });
        await replyText(msg.from, "*Anytime. 🤝*");
        return;
      }
      recordTurn(msg.from, { intent: "unknown" });
      await replyText(msg.from, `*Didn't catch that.*\n\n${HELP}`);
      return;
    }
  }
}
