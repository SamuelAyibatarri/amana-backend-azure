import { log, maskPhone } from "../lib/log.ts";

const FRONTEND_URL =
  process.env.FRONTEND_URL ?? "http://localhost:8787";
const SHARED_SECRET = process.env.SHARED_SECRET ?? "";

const TIMEOUT_MS = 5_000;

export type PinResult = "ok" | "wrong" | "no-pin" | "locked" | "unreachable";

/** Static dashboard URL (PIN setup lives there). */
export function dashboardUrl(): string {
  return `${FRONTEND_URL.replace(/\/$/, "")}/dashboard`;
}

/**
 * Verify a 4-digit PIN against the dashboard-set credential in D1.
 * Fail-closed: any error reads as `unreachable` (never as approval).
 */
export async function verifyPin(phone: string, pin: string): Promise<PinResult> {
  if (!SHARED_SECRET) return "unreachable";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${FRONTEND_URL}/api/pin/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amana-secret": SHARED_SECRET,
      },
      body: JSON.stringify({ phone, pin }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      log("warn", "PIN verify non-OK", { phone: maskPhone(phone), status: res.status });
      return "unreachable";
    }
    const body = (await res.json()) as {
      ok?: unknown;
      verified?: unknown;
      noPin?: unknown;
      locked?: unknown;
    };
    if (body.locked === true) return "locked";
    if (body.noPin === true) return "no-pin";
    return body.ok === true && body.verified === true ? "ok" : "wrong";
  } catch (err) {
    log("warn", "PIN verify failed", {
      phone: maskPhone(phone),
      error: err instanceof Error ? err.message : String(err),
    });
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}
