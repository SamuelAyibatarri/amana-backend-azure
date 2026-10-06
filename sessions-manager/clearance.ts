import { log, maskPhone } from "../lib/log.ts";

const FRONTEND_URL =
  process.env.FRONTEND_URL ?? "http://localhost:8787";
const SHARED_SECRET = process.env.SHARED_SECRET ?? "";

// 5s cap so a slow frontend never leaves the user hanging mid-chat.
const TIMEOUT_MS = 5_000;

export interface Clearance {
  verified: boolean;
  /** "verified" | "pending" | "failed" | "unknown" (never seen). */
  status: string;
  /**
   * Where the answer came from. `unreachable` means the check itself
   * failed (frontend down, timeout, bad secret) — distinct from a
   * frontend that answered "never seen this phone".
   */
  source: "frontend" | "unreachable";
  /** Whether a user row exists — i.e. the number is on Amana. */
  linked: boolean;
  /** Real name from KYC (user row), when set. Bot greets by this first. */
  name?: string;
  /** Chat default currency (functional), when set. */
  defaultCurrency?: "SOL" | "USDC" | "NGN";
}

/**
 * Ask the frontend (D1 single-source) whether a WhatsApp phone has
 * completed KYC. Fail-closed: any error, timeout, or non-OK response
 * returns unverified — money never moves on an ambiguous check.
 */
export async function getClearance(phone: string): Promise<Clearance> {
  const closed: Clearance = {
    verified: false,
    status: "unknown",
    source: "unreachable",
    linked: false,
  };
  if (!SHARED_SECRET) {
    log("warn", "Clearance check skipped: SHARED_SECRET unset", { phone: maskPhone(phone) });
    return closed;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${FRONTEND_URL}/api/kyc/status?phone=${encodeURIComponent(phone)}`,
      { headers: { "x-amana-secret": SHARED_SECRET }, signal: ctrl.signal },
    );
    if (!res.ok) {
      log("warn", "Clearance check non-OK", { phone: maskPhone(phone), status: res.status });
      return closed;
    }
    const body = (await res.json()) as {
      verified?: unknown;
      status?: unknown;
      linked?: unknown;
      name?: unknown;
      defaultCurrency?: unknown;
    };
    const status = typeof body.status === "string" ? body.status : "unknown";
    const dc = body.defaultCurrency;
    return {
      verified: body.verified === true && status === "verified",
      status,
      source: "frontend",
      linked: body.linked === true,
      name:
        typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
      defaultCurrency:
        dc === "SOL" || dc === "USDC" || dc === "NGN" ? dc : undefined,
    };
  } catch (err) {
    log("warn", "Clearance check failed", {
      phone,
      error: err instanceof Error ? err.message : String(err),
    });
    return closed;
  } finally {
    clearTimeout(timer);
  }
}
