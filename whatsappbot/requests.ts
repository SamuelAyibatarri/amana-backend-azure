/**
 * Chat-native money requests. Everything lives in WhatsApp — no claim
 * pages, no web round-trips. Requester asks, recipient gets an image
 * card + strict reply words (ACCEPT / REJECT / REJECT AND BLOCK),
 * acceptance runs the standard PIN ceremony, money moves recipient →
 * requester. Privacy (open/contacts/blocked) enforced server-side.
 */

import {
  checkWhatsAppNumbers,
  replyText,
  sendImage,
  type IncomingMessage,
} from "./baileys.ts";
import { getClearance } from "../sessions-manager/clearance.ts";
import {
  cancelMoneyRequest,
  createMoneyRequest,
  minePendingRequest,
  requestPrivacy,
  respondMoneyRequest,
  sweepMoneyRequests,
} from "../sessions-manager/requests.ts";
import {
  clearPending,
  recordTurn,
  setPending,
} from "../sessions-manager/conversation.ts";
import { getBalances, LEDGER_DECIMALS } from "../sessions-manager/transfers.ts";
import { convertSendNgn, getQuote } from "../lib/rates.ts";
import { log } from "../lib/log.ts";
import { maskPhone, renderPinGuard, renderRequest } from "../receipts/receipts.ts";
import { displayPhone } from "./intent.ts";
import {
  PIN_IMAGE_CAPTION,
  PIN_PROMPT,
  type PaymentDetails,
} from "./payments.ts";

const ACCEPT = /^(accept|accept it|yes)$/i;
const REJECT = /^(reject|no|decline)$/i;
const REJECT_BLOCK = /^(reject and block|reject block|block them)$/i;

const BLOCK_ALL = /^block requests$/i;
const CONTACTS_ONLY = /^(only contacts can request me|contacts only)$/i;
const ALLOW_ALL = /^(allow requests from everyone|allow all requests)$/i;
const UNBLOCK = /^unblock ([\d\s+\-().]+)$/i;
const CANCEL_REQUEST = /^(cancel (my |the )?request|cancel it)$/i;

function fmtMinor(minor: number, currency: "SOL" | "USDC"): string {
  const dec = LEDGER_DECIMALS[currency];
  const whole = minor / 10 ** dec;
  return `${Number(whole.toFixed(3))} ${currency}`;
}

/**
 * Privacy + cancel commands. Anchored strict regexes — normal speech
 * never trips them. Returns true when handled.
 */
export async function handleRequestCommand(msg: IncomingMessage): Promise<boolean> {
  const t = msg.text.trim();
  if (BLOCK_ALL.test(t)) {
    const r = await requestPrivacy(msg.from, "blocked");
    await replyText(
      msg.from,
      r.ok
        ? "*Done — requests blocked.*\n\nNobody can request money from you. Say _only contacts can request me_ or _allow requests from everyone_ to change that."
        : "*I couldn't update that right now.*\n\nTry again in a minute.",
    );
    return true;
  }
  if (CONTACTS_ONLY.test(t)) {
    const r = await requestPrivacy(msg.from, "contacts");
    await replyText(
      msg.from,
      r.ok
        ? "*Done — contacts only.*\n\nOnly people you've transacted with can request money from you."
        : "*I couldn't update that right now.*\n\nTry again in a minute.",
    );
    return true;
  }
  if (ALLOW_ALL.test(t)) {
    const r = await requestPrivacy(msg.from, "open");
    await replyText(
      msg.from,
      r.ok
        ? "*Done — requests open.*\n\nAnyone on WhatsApp can request money from you. Say _block requests_ anytime to stop all of them."
        : "*I couldn't update that right now.*\n\nTry again in a minute.",
    );
    return true;
  }
  const unblock = t.match(UNBLOCK);
  if (unblock) {
    const target = unblock[1]!.replace(/\D/g, "");
    const r = await requestPrivacy(msg.from, undefined, target);
    await replyText(
      msg.from,
      r.ok
        ? `*Unblocked ${target}.*\n\nThey can request money from you again (within your privacy setting).`
        : "*I couldn't update that right now.*\n\nTry again in a minute.",
    );
    return true;
  }
  if (CANCEL_REQUEST.test(t)) {
    const mine = await minePendingRequest(msg.from);
    if (!mine) {
      await replyText(msg.from, "*No open request.*\n\nYou have nothing pending to cancel.");
      return true;
    }
    const done = await cancelMoneyRequest(mine.id, msg.from);
    if (!done.ok) {
      await replyText(msg.from, "*I couldn't cancel that right now.*\n\nTry again in a minute.");
      return true;
    }
    await replyText(msg.from, "*Request withdrawn.*\n\nNothing moves.");
    // Tell the other side so they don't answer a dead request.
    void replyText(
      done.recipientPhone ?? "",
      `*Request withdrawn.*\n\n${displayPhone(msg.from)} cancelled their request — nothing moves, no need to reply.`,
    );
    return true;
  }
  return false;
}

export interface RequestIntent {
  amount?: number;
  amountUnit?: "NGN" | "SOL" | "USDC";
  currency?: "SOL" | "USDC" | "NGN";
  targetPhoneNumber?: string;
  targetAddress?: string;
}

/**
 * Requester flow: "request 5000 from 0803". Requester must be verified.
 * Fiat-denominated by default (same conversion as sends). Notifies the
 * recipient with an image card + sets their awaitingAccept state.
 */
export async function startRequestFlow(
  msg: IncomingMessage,
  intent: RequestIntent,
  defaultCurrency: string | undefined,
): Promise<void> {
  const currency =
    intent.currency ??
    (defaultCurrency === "USDC" || defaultCurrency === "SOL" ? defaultCurrency : "SOL");
  if (currency !== "SOL" && currency !== "USDC") {
    await replyText(
      msg.from,
      "*I can only request SOL or USDC.*\n\nTry:\n_request 5000 naira worth of USDC from 08031234567_",
    );
    return;
  }
  const target = intent.targetPhoneNumber;
  if (intent.amount === undefined || !target) {
    const missing = intent.amount === undefined && !target
      ? "*How much, and from who?*\n\nTry:\n_request 5000 naira worth of USDC from 08031234567_"
      : intent.amount === undefined
        ? `*How much?*\n\nGot ${displayPhone(target ?? "")} — now the amount.\nTry:\n_request 5000 naira worth of ${currency} from ${displayPhone(target ?? "")}_`
        : `*From who?*\n\nGot the amount — now the person: a WhatsApp number.\nTry:\n_request ${intent.amount} ${currency} from 08031234567_`;
    await replyText(msg.from, missing);
    return;
  }
  // Requester must be verified (money moves on accept).
  const clearance = await getClearance(msg.from);
  if (!clearance.verified) {
    await replyText(
      msg.from,
      "*Verify your identity first.*\n\nRequesting unlocks after verification.",
    );
    return;
  }
  // Recipient must exist on WhatsApp.
  const seen = await checkWhatsAppNumbers([target]);
  const key = target.replace(/\D/g, "");
  if (seen && seen.get(key) === false && seen.get(`0${key.slice(3)}`) === false) {
    await replyText(
      msg.from,
      `*That number isn't on WhatsApp.*\n\n${displayPhone(target)} doesn't look registered — check the digits.`,
    );
    return;
  }
  // Convert fiat → crypto now (execution-ready minor units).
  const unit = intent.amountUnit ?? currency;
  let amountMinor: number;
  let sendNgn: number | undefined;
  if (unit === "NGN") {
    try {
      const quote = await getQuote(currency);
      const { crypto } = convertSendNgn(intent.amount, currency, quote);
      if (!Number.isFinite(crypto) || crypto <= 0) throw new Error("bad quote");
      amountMinor = Math.round(crypto * 10 ** LEDGER_DECIMALS[currency]);
      sendNgn = Math.round(intent.amount);
    } catch {
      await replyText(
        msg.from,
        "*I can't price that right now.*\n\nNothing happened — try again in a minute.",
      );
      return;
    }
  } else {
    amountMinor = Math.round(intent.amount * 10 ** LEDGER_DECIMALS[currency]);
  }
  if (amountMinor <= 0) {
    await replyText(msg.from, "*That amount is too small.*\n\nTry a bigger figure.");
    return;
  }

  const created = await createMoneyRequest({
    requesterPhone: msg.from,
    recipientPhone: target,
    amountMinor,
    currency,
    sendNgn,
  });
  if (!created.ok || !created.allowed || !created.id) {
    await replyText(
      msg.from,
      created.error === "Requester unverified."
        ? "*Verify your identity first.*\n\nRequesting unlocks after verification."
        : "*That person isn't accepting requests right now.*\n\nNothing was sent.",
    );
    return;
  }

  // Notify the recipient with the image card.
  const whole = amountMinor / 10 ** LEDGER_DECIMALS[currency];
  const fiatNote = sendNgn !== undefined ? `₦${sendNgn.toLocaleString("en-NG")}` : undefined;
  try {
    const png = await renderRequest({
      requesterLabel: maskPhone(msg.from),
      contactKnown: created.contactKnown ?? false,
      amount: whole,
      currency,
      fiatNote,
    });
    setPending(target, {
      kind: "awaitingAccept",
      requestId: created.id,
      expiresAt: Date.now() + 30 * 60 * 1_000,
    });
    await sendImage(
      target,
      png,
      `*${maskPhone(msg.from)} asks for ${Number(whole.toFixed(3))} ${currency}${fiatNote ? ` (${fiatNote})` : ""}.*\n\n` +
        (created.contactKnown
          ? "_You've transacted with this person before._\n\n"
          : "_You've NEVER transacted with this person._\n\n") +
        `Reply ACCEPT (then confirm with your PIN), REJECT, or REJECT AND BLOCK to never hear from them again.`,
    );
  } catch (err) {
    log("warn", "Request image failed (text fallback)", {
      error: err instanceof Error ? err.message : String(err),
    });
    setPending(target, {
      kind: "awaitingAccept",
      requestId: created.id,
      expiresAt: Date.now() + 30 * 60 * 1_000,
    });
    await replyText(
      target,
      `*${maskPhone(msg.from)} asks for ${Number(whole.toFixed(3))} ${currency}.*\n\nReply ACCEPT, REJECT, or REJECT AND BLOCK.`,
    );
  }
  recordTurn(msg.from, {
    intent: "request",
    amount: whole,
    targetPhoneNumber: target,
    currency,
    outcome: "requested",
  });
  await replyText(
    msg.from,
    `*Request sent to ${displayPhone(target)}.*\n\nThey have 7 days to answer — I'll tell you what they decide.`,
  );
}

/**
 * Recipient replies inside awaitingAccept. ACCEPT runs the standard PIN
 * ceremony (money moves FROM the recipient — their PIN gates it);
 * REJECT / REJECT AND BLOCK settle immediately.
 */
export async function handleAwaitingAccept(
  msg: IncomingMessage,
  requestId: string,
): Promise<void> {
  const t = msg.text.trim();
  if (REJECT_BLOCK.test(t)) {
    const r = await respondMoneyRequest(requestId, msg.from, "reject-block");
    clearPending(msg.from);
    if (!r.ok) {
      await replyText(msg.from, "*I couldn't reach that right now.*\n\nTry again in a minute.");
      return;
    }
    await replyText(
      msg.from,
      "*Done — rejected and blocked.*\n\nThey won't be able to request from you again. Say _unblock ..._ with their number to reverse it.",
    );
    if (r.requesterPhone) {
      void replyText(
        r.requesterPhone,
        "*That person isn't accepting requests right now.*\n\nNothing moved.",
      );
    }
    return;
  }
  if (REJECT.test(t)) {
    const r = await respondMoneyRequest(requestId, msg.from, "reject");
    clearPending(msg.from);
    if (!r.ok) {
      await replyText(msg.from, "*I couldn't reach that right now.*\n\nTry again in a minute.");
      return;
    }
    await replyText(msg.from, "*Rejected.*\n\nNothing moved — they won't hear why.");
    if (r.requesterPhone) {
      void replyText(
        r.requesterPhone,
        "*They declined your request.*\n\nNothing moved.",
      );
    }
    return;
  }
  if (!ACCEPT.test(t)) {
    await replyText(
      msg.from,
      "*I can only take ACCEPT, REJECT, or REJECT AND BLOCK for this:*\n\nACCEPT moves the money (you'll confirm with your PIN next).",
    );
    return;
  }
  // ACCEPT: recipient must be verified (they're about to send money).
  const clearance = await getClearance(msg.from);
  if (!clearance.verified) {
    clearPending(msg.from);
    await replyText(
      msg.from,
      "*Verify your identity first.*\n\nAccepting moves money, so it needs verification.",
    );
    return;
  }
  const r = await respondMoneyRequest(requestId, msg.from, "accept");
  if (!r.ok || !r.request) {
    clearPending(msg.from);
    await replyText(
      msg.from,
      r.replay
        ? "*That request is already settled.*\n\nNothing more to do."
        : "*I couldn't reach that right now.*\n\nTry again in a minute.",
    );
    return;
  }
  // Debit gate: the recipient must actually hold the funds.
  const balances = await getBalances(msg.from);
  const haveMinor = balances?.[r.request.currency as "SOL" | "USDC"] ?? -1;
  if (balances === null || haveMinor < r.request.amountMinor) {
    await replyText(
      msg.from,
      balances === null
        ? "*I can't check your balance right now.*\n\nThe request stays open — try ACCEPT again in a minute."
        : `*Not enough ${r.request.currency} to accept.*\n\nYou have ${fmtMinor(haveMinor, r.request.currency as "SOL" | "USDC")} — that's short of ${fmtMinor(r.request.amountMinor, r.request.currency as "SOL" | "USDC")}. The request stays open; fund up and ACCEPT again, or REJECT.`,
    );
    return;
  }
  // Hand the standard PIN ceremony a send: recipient → requester.
  const dec = LEDGER_DECIMALS[r.request.currency as "SOL" | "USDC"];
  const details: PaymentDetails = {
    action: "send",
    amount: r.request.amountMinor / 10 ** dec,
    currency: r.request.currency as "SOL" | "USDC",
    targetPhoneNumber: r.request.requesterPhone,
    requestId,
    recalled: false,
  };
  clearPending(msg.from);
  setPending(msg.from, {
    kind: "awaitingPin",
    details,
    expiresAt: Date.now() + 30 * 60 * 1_000,
  });
  recordTurn(msg.from, {
    intent: "send",
    amount: details.amount,
    targetPhoneNumber: details.targetPhoneNumber,
    currency: details.currency,
    outcome: "request-accepted",
  });
  try {
    await sendImage(msg.from, await renderPinGuard(), PIN_IMAGE_CAPTION);
  } catch {
    await replyText(msg.from, PIN_PROMPT);
  }
}

/**
 * Called from the send-execution success path when the send settles an
 * accepted request: finalizes the request + notifies the requester.
 */
export async function finalizeRequestAccept(
  requestId: string,
  recipientPhone: string,
): Promise<void> {
  const r = await respondMoneyRequest(requestId, recipientPhone, "finalize-accept");
  if (!r.ok || !r.requesterPhone) {
    log("error", "Request finalize failed after credit moved", { requestId });
    return;
  }
  void replyText(
    r.requesterPhone,
    "*Request accepted — money on the way.*\n\nCheck your balance or history.",
  );
}

/** 5-min bot tick: expiry is silent; nudges get one reminder each. */
export async function tickRequestSweep(): Promise<void> {
  const sweep = await sweepMoneyRequests();
  if (!sweep.ok || !sweep.nudge?.length) return;
  for (const n of sweep.nudge) {
    await replyText(
      n.recipientPhone,
      `*Reminder: ${maskPhone(n.requesterPhone)} asked for ${fmtMinor(n.amountMinor, n.currency as "SOL" | "USDC")}.*\n\nReply ACCEPT, REJECT, or REJECT AND BLOCK. Unanswered requests expire after 7 days.`,
    );
  }
}
