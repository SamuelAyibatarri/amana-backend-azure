import { log, maskPhone } from "../lib/log.ts";

const FRONTEND_URL =
  process.env.FRONTEND_URL ?? "http://localhost:8787";
const SHARED_SECRET = process.env.SHARED_SECRET ?? "";

const TIMEOUT_MS = 8_000;

async function post<T>(path: string, body: unknown): Promise<{ res: Response; json: T }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${FRONTEND_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amana-secret": SHARED_SECRET,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = (await res.json()) as T;
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

export interface CreateResult {
  ok: boolean;
  allowed?: boolean;
  id?: string;
  contactKnown?: boolean;
  error?: string;
}

/** Create a money request (privacy enforced server-side). */
export async function createMoneyRequest(args: {
  requesterPhone: string;
  recipientPhone: string;
  amountMinor: number;
  currency: "SOL" | "USDC";
  sendNgn?: number;
}): Promise<CreateResult> {
  if (!SHARED_SECRET) return { ok: false, error: "unreachable" };
  try {
    const { res, json } = await post<CreateResult>("/api/requests/create", args);
    if (!res.ok && res.status !== 200) return { ok: false, error: "unreachable" };
    return json;
  } catch (err) {
    log("warn", "Request create failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "unreachable" };
  }
}

export type RespondAction = "accept" | "reject" | "reject-block" | "finalize-accept";

export interface RespondResult {
  ok: boolean;
  status?: string;
  replay?: boolean;
  blocked?: boolean;
  requesterPhone?: string;
  request?: {
    id: string;
    requesterPhone: string;
    amountMinor: number;
    currency: string;
    sendNgn: number | null;
  };
}

/** Respond to a request (accept = fetch execution details; finalize after credit). */
export async function respondMoneyRequest(
  id: string,
  phone: string,
  action: RespondAction,
): Promise<RespondResult> {
  if (!SHARED_SECRET) return { ok: false };
  try {
    const { json } = await post<RespondResult>("/api/requests/respond", {
      id,
      phone,
      action,
    });
    return json;
  } catch (err) {
    log("warn", "Request respond failed", {
      phone: maskPhone(phone),
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

/** Requester's latest pending outgoing request (for cancel). */
export async function minePendingRequest(
  phone: string,
): Promise<{ id: string; recipientPhone: string; amountMinor: number; currency: string } | null> {
  if (!SHARED_SECRET) return null;
  try {
    const { res, json } = await post<{
      ok?: unknown;
      request?: { id: string; recipientPhone: string; amountMinor: number; currency: string } | null;
    }>("/api/requests/mine", { phone });
    if (!res.ok || json.ok !== true) return null;
    return json.request ?? null;
  } catch (err) {
    log("warn", "Request mine failed", {
      phone: maskPhone(phone),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Cancel a pending outgoing request. Returns the recipient to notify. */
export async function cancelMoneyRequest(
  id: string,
  phone: string,
): Promise<{ ok: boolean; recipientPhone?: string }> {
  if (!SHARED_SECRET) return { ok: false };
  try {
    const { json } = await post<{ ok?: unknown; recipientPhone?: string }>(
      "/api/requests/cancel",
      { id, phone },
    );
    return { ok: json.ok === true, recipientPhone: json.recipientPhone };
  } catch (err) {
    log("warn", "Request cancel failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

/** Privacy controls: open | contacts | blocked, plus unblock. */
export async function requestPrivacy(
  phone: string,
  privacy?: "open" | "contacts" | "blocked",
  unblock?: string,
): Promise<{ ok: boolean; privacy?: string; unblocked?: string }> {
  if (!SHARED_SECRET) return { ok: false };
  try {
    const { json } = await post<{ ok?: unknown; privacy?: string; unblocked?: string }>(
      "/api/requests/settings",
      { phone, privacy, unblock },
    );
    return {
      ok: json.ok === true,
      privacy: json.privacy,
      unblocked: json.unblocked,
    };
  } catch (err) {
    log("warn", "Request settings failed", {
      phone: maskPhone(phone),
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

export interface SweepNudge {
  id: string;
  requesterPhone: string;
  recipientPhone: string;
  amountMinor: number;
  currency: string;
}

/** Expiry + single-nudge sweep (bot 5-min tick). */
export async function sweepMoneyRequests(): Promise<{
  ok: boolean;
  expired?: number;
  nudge?: SweepNudge[];
}> {
  if (!SHARED_SECRET) return { ok: false };
  try {
    const { json } = await post<{ ok?: unknown; expired?: number; nudge?: SweepNudge[] }>(
      "/api/requests/sweep",
      {},
    );
    return { ok: json.ok === true, expired: json.expired, nudge: json.nudge };
  } catch (err) {
    log("warn", "Request sweep failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}
