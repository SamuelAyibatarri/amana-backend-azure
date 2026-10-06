import { log, maskPhone } from "../lib/log.ts";

const FRONTEND_URL =
  process.env.FRONTEND_URL ?? "http://localhost:8787";
const SHARED_SECRET = process.env.SHARED_SECRET ?? "";

const TIMEOUT_MS = 8_000;

export type LinkResult = "sent" | "cooldown" | "failed";

/**
 * Mint a contextual magic link for the sender's own number (chat-first
 * onboarding). The worker's request-link endpoint mints via the framework
 * and relays into this same chat — the user taps once and lands signed
 * in on `callback` (/kyc for verification gates, /dashboard otherwise).
 * Fail-closed: any error reads as `failed` (caller falls back to text).
 */
export async function requestMagicLink(
  phone: string,
  callback: "/kyc" | "/dashboard" = "/kyc",
): Promise<LinkResult> {
  if (!SHARED_SECRET) return "failed";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${FRONTEND_URL}/api/auth/request-link`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amana-secret": SHARED_SECRET,
      },
      body: JSON.stringify({ phone, callbackURL: callback }),
      signal: ctrl.signal,
    });
    if (res.status === 429) return "cooldown";
    if (!res.ok) {
      log("warn", "Magic link request non-OK", {
        phone: maskPhone(phone),
        status: res.status,
      });
      return "failed";
    }
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true ? "sent" : "failed";
  } catch (err) {
    log("warn", "Magic link request failed", {
      phone: maskPhone(phone),
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
