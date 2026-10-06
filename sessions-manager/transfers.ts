import { log } from "../lib/log.ts";
import { mintMirror } from "../solana/solana.ts";

const FRONTEND_URL =
  process.env.FRONTEND_URL ?? "http://localhost:8787";
const SHARED_SECRET = process.env.SHARED_SECRET ?? "";

const TIMEOUT_MS = 8_000;

export interface CreditResult {
  ok: boolean;
  transferId?: string;
  recipientCreated?: boolean;
  /** Mirror-mint signature when the liability peg was extended. */
  mirrorSig?: string;
  /** True when the ledger credited but the mirror mint failed. */
  mirrorGap?: boolean;
}

/**
 * Internal credit: provision both users if absent, write a completed
 * transfer row. Value is final at insert — no chain involved.
 * Afterwards the liability-matched mirror pool is extended (best-effort:
 * the ledger always stands; a failed mint is logged as a mirror-gap for
 * the future reconciliation job, never retried inline).
 *
 * netZero (phone sends): liability changes hands, never totals — the
 * mirror leg is a single-tx mint+burn (supply unchanged) instead of a
 * mint. Buys (new money in) keep the default mint-only path.
 */
export async function creditTransfer(args: {
  senderPhone: string;
  recipientPhone: string;
  amount: number;
  currency: "SOL" | "USDC" | "NGN";
  netZero?: boolean;
}): Promise<CreditResult> {
  if (!SHARED_SECRET) return { ok: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let transferId: string | undefined;
  let recipientCreated = false;
  try {
    const res = await fetch(`${FRONTEND_URL}/api/transfers/credit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amana-secret": SHARED_SECRET,
      },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log("warn", "Transfer credit non-OK", { status: res.status });
      return { ok: false };
    }
    const body = (await res.json()) as {
      ok?: unknown;
      transferId?: unknown;
      recipientCreated?: unknown;
    };
    if (body.ok !== true) return { ok: false };
    transferId = typeof body.transferId === "string" ? body.transferId : undefined;
    recipientCreated = body.recipientCreated === true;
  } catch (err) {
    log("warn", "Transfer credit failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
  try {
    if (args.netZero) {
      const { mirrorMove } = await import("../solana/solana.ts");
      const mirrorSig = await mirrorMove(args.currency, args.amount);
      return { ok: true, transferId, recipientCreated, mirrorSig };
    }
    const mirrorSig = await mintMirror(args.currency, args.amount);
    return { ok: true, transferId, recipientCreated, mirrorSig };
  } catch (err) {
    log("error", "Mirror gap: ledger credited, mirror mint failed", {
      transferId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: true, transferId, recipientCreated, mirrorGap: true };
  }
}

/** Ledger minor-unit decimals per currency (frontend DECIMALS contract). */
export const LEDGER_DECIMALS = { SOL: 9, USDC: 6, NGN: 2 } as const;

/** Net position per currency, in minor units. Null when unreachable. */
export async function getBalances(
  phone: string,
): Promise<Record<"SOL" | "USDC" | "NGN", number> | null> {
  if (!SHARED_SECRET) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${FRONTEND_URL}/api/transfers/balance?phone=${encodeURIComponent(phone)}`,
      {
        headers: { "x-amana-secret": SHARED_SECRET },
        signal: ctrl.signal,
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok?: unknown;
      balances?: Record<string, unknown>;
    };
    if (body.ok !== true || !body.balances) return null;
    const num = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    return {
      SOL: num(body.balances.SOL),
      USDC: num(body.balances.USDC),
      NGN: num(body.balances.NGN),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Whole units for display. */
export function minorToWhole(minor: number, currency: "SOL" | "USDC" | "NGN"): number {
  return minor / 10 ** LEDGER_DECIMALS[currency];
}

/**
 * Trimmed number: max `maxDp` decimals (default 3), thousands grouped.
 * Pure display — never feeds ledger math.
 */
export function formatNum(whole: number, maxDp = 3): string {
  if (!Number.isFinite(whole)) return "0";
  return whole.toLocaleString("en-NG", { maximumFractionDigits: maxDp });
}

/**
 * Chat/display amount: crypto max 3dp trimmed, NGN 2dp grouped.
 * Display rounding only — ledger math stays in minor units. Dust that
 * rounds to zero shows as `< 0.001` rather than a lying `0`.
 */
export function formatAmount(whole: number, currency: string): string {
  if (!Number.isFinite(whole)) return currency === "NGN" ? "₦0" : `0 ${currency}`;
  if (currency === "NGN") return `₦${formatNum(whole, 2)}`;
  const shown = formatNum(whole, 3);
  if (shown === "0" && whole !== 0) return `< 0.001 ${currency}`;
  return `${shown} ${currency}`;
}

/**
 * Record a landed on-chain withdrawal so net liabilities stay exact.
 * Best-effort: the chain movement is truth; a failed record is logged.
 */
export async function recordWithdrawal(args: {
  senderPhone: string;
  address: string;
  amountMinor: number;
  currency: "SOL" | "USDC" | "NGN";
  signature: string;
}): Promise<boolean> {
  if (!SHARED_SECRET) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${FRONTEND_URL}/api/transfers/withdraw`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amana-secret": SHARED_SECRET,
      },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log("warn", "Withdrawal record non-OK", { status: res.status });
      return false;
    }
    return ((await res.json()) as { ok?: unknown }).ok === true;
  } catch (err) {
    log("warn", "Withdrawal record failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
