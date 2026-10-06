import "dotenv/config";
import { Hono } from "hono";
import { handleMessage } from "./whatsappbot/handler.ts";
import { replyText, startWhatsApp } from "./whatsappbot/baileys.ts";
import {
  MIRROR_DECIMALS,
  mirrorMintFor,
  reserveSupply,
  solscanAddress,
  type MirrorCurrency,
} from "./solana/solana.ts";
import { LEDGER_DECIMALS } from "./sessions-manager/transfers.ts";
import {
  receiptTimestamp,
  renderReceipt,
} from "./receipts/receipts.ts";
import { log, maskPhone } from "./lib/log.ts";

// ---------------------------------------------------------------------------
// Env (fail fast with a message naming the fix)
// ---------------------------------------------------------------------------

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy it into amana-backend-azure/.env (see .env placeholders).`,
    );
  }
  return value;
}

const PORT = Number(process.env.PORT ?? "3001");
if (!Number.isInteger(PORT) || PORT <= 0) {
  throw new Error(`Invalid PORT=${process.env.PORT}. Set PORT=3001 in .env.`);
}

const SHARED_SECRET = required("SHARED_SECRET");
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:8787";

/** Constant-time secret compare (timing-attack surface on shared-secret guards). */
function secretsEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

// Buy settlement (called by the frontend Paystack webhook after a
// completed charge). Guarded by SHARED_SECRET. Funds the ledger,
// extends the mirror pool, and delivers the buy receipt in chat.
app.post("/buy/settle", async (c) => {
  if (!secretsEqual(c.req.header("x-amana-secret") ?? "", SHARED_SECRET)) {
    return c.json({ error: "Unauthorized." }, 401);
  }
  let body: {
    reference?: unknown;
    phone?: unknown;
    asset?: unknown;
    crypto?: unknown;
    rateLabel?: unknown;
    ngn?: unknown;
    amountKobo?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be JSON." }, 400);
  }
  const reference = typeof body.reference === "string" ? body.reference : "";
  const phone =
    typeof body.phone === "string" ? body.phone.replace(/\D/g, "") : "";
  const asset = body.asset === "USDC" ? "USDC" : "SOL";
  let crypto =
    typeof body.crypto === "number" && Number.isFinite(body.crypto) && body.crypto > 0
      ? body.crypto
      : 0;
  let rateLabel = typeof body.rateLabel === "string" ? body.rateLabel : "";
  let ngn = typeof body.ngn === "number" ? body.ngn : 0;
  if (!reference || !phone) {
    return c.json({ error: "Bad settle request." }, 400);
  }
  // Web-initiated fundings carry no quote: price here at settle time
  // (receipt prints the executed rate — timing disclosed, not hidden).
  if (!crypto) {
    const kobo =
      typeof body.amountKobo === "number" && body.amountKobo > 0 ? body.amountKobo : 0;
    if (!kobo) return c.json({ error: "Bad settle request." }, 400);
    const { getQuote, cryptoForNgn } = await import("./lib/rates.ts");
    const quote = await getQuote(asset);
    ngn = kobo / 100;
    crypto = cryptoForNgn(ngn, quote);
    const usd = asset === "SOL" ? quote.solUsd : quote.usdcUsd;
    rateLabel =
      `≈ ${crypto.toFixed(asset === "SOL" ? 5 : 2)} ${asset} ` +
      `@ $${usd}, ₦${quote.usdNgn}/$${quote.live ? "" : " (last known rate)"}`;
  }
  // 1. Ledger credit (idempotent on reference — replays never double-fund).
  const fundRes = await fetch(
    `${FRONTEND_URL.replace(/\/$/, "")}/api/transfers/fund`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-amana-secret": SHARED_SECRET,
      },
      body: JSON.stringify({
        phone,
        amount: crypto,
        currency: asset,
        reference,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!fundRes.ok) {
    log("error", "Buy settle: fund failed", { reference, status: fundRes.status });
    return c.json({ error: "Fund failed." }, 502);
  }
  const fund = (await fundRes.json()) as { ok?: unknown; duplicate?: unknown };
  if (fund.ok !== true) {
    log("error", "Buy settle: fund rejected", { reference });
    return c.json({ error: "Fund rejected." }, 502);
  }
  // 2. Mirror pool extension (best-effort; ledger stands regardless).
  if (!fund.duplicate) {
    try {
      const { mintMirror } = await import("./solana/solana.ts");
      await mintMirror(asset, crypto);
    } catch (err) {
      log("error", "Mirror gap: buy funded, mirror mint failed", {
        reference,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // 3. Chat confirmation: text + buy receipt image.
  const cryptoLabel = `${crypto.toFixed(asset === "SOL" ? 5 : 2)} ${asset}`;
  const caption =
    `*✅ Buy confirmed — ₦${Number(ngn).toLocaleString("en-NG")} → ${cryptoLabel}.*\n\n` +
    (rateLabel ? `_${rateLabel}_\n\n` : "") +
    `Reference:\n\`\`\`${reference}\`\`\``;
  await replyText(phone, caption);
  try {
    const png = await renderReceipt({
      kind: "buy",
      amountMinorLabel: `₦${Number(ngn).toLocaleString("en-NG")} → ${cryptoLabel}`,
      reference,
      receiptUrl: `${FRONTEND_URL.replace(/\/$/, "")}/receipt/fund-${reference}`,
      timestamp: receiptTimestamp(),
    });
    const { sendImage } = await import("./whatsappbot/baileys.ts");
    await sendImage(phone, png, caption);
  } catch (err) {
    log("warn", "Buy receipt image failed (text delivered)", {
      reference,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return c.json({ ok: true, duplicate: fund.duplicate === true });
});

// Proof-of-liability: net ledger liabilities vs mirror reserve supply,
// per currency pool. Any judge can hit this + follow the Solscan links.
app.get("/health/mirror", async (c) => {
  try {
    const sumsRes = await fetch(
      `${FRONTEND_URL.replace(/\/$/, "")}/api/transfers/sums`,
      {
        headers: { "x-amana-secret": SHARED_SECRET },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!sumsRes.ok) {
      return c.json({ ok: false, error: "Ledger unreachable." }, 502);
    }
    const { sums } = (await sumsRes.json()) as {
      sums: Record<string, number>;
    };
    const pools: MirrorCurrency[] = ["SOL", "USDC", "NGN"];
    const report = [];
    for (const currency of pools) {
      const mint = mirrorMintFor(currency);
      if (!mint) {
        report.push({ currency, configured: false });
        continue;
      }
      const supply = await reserveSupply(mint);
      // Ledger minor units -> mirror base units (6dp) for comparison.
      const ledgerMinor = BigInt(Math.round(sums[currency] ?? 0));
      const shift = MIRROR_DECIMALS - LEDGER_DECIMALS[currency];
      const ledgerBase =
        shift >= 0
          ? ledgerMinor * 10n ** BigInt(shift)
          : ledgerMinor / 10n ** BigInt(-shift);
      report.push({
        currency,
        configured: true,
        ledgerBase: ledgerBase.toString(),
        mirrorBase: supply.toString(),
        match: ledgerBase === supply,
        mint: solscanAddress(mint),
      });
    }
    const allMatch = report.every((r) => r.match !== false);
    return c.json({ ok: true, allMatch, pools: report });
  } catch (err) {
    log("warn", "Mirror invariant check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ ok: false, error: "Invariant check failed." }, 502);
  }
});

// Dumb WhatsApp relay for the frontend worker. The worker (Better Auth
// magic-link plugin) generates the link; this endpoint only delivers it.
// Guarded by SHARED_SECRET — only the frontend proxy holds it.
app.post("/whatsapp/send", async (c) => {
  if (!secretsEqual(c.req.header("x-amana-secret") ?? "", SHARED_SECRET)) {
    return c.json({ error: "Unauthorized." }, 401);
  }
  let body: { to?: unknown; text?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be JSON { to, text }." }, 400);
  }
  const to = typeof body.to === "string" ? body.to.replace(/\D/g, "") : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (to.length < 7 || to.length > 15 || !text) {
    return c.json({ error: "Provide a valid `to` phone and non-empty `text`." }, 400);
  }
  const sent = await replyText(to, text);
  if (!sent) {
    return c.json({ ok: false, error: "Delivery failed." }, 502);
  }
  log("info", "Relay message sent", { to: maskPhone(to) });
  return c.json({ ok: true });
});

export default {
  port: PORT,
  fetch: app.fetch,
};

// Baileys socket: events arrive in-process (no webhooks, no Evolution).
// QR prints in this terminal on first boot — scan with the bot line.
void startWhatsApp((msg) => {
  void handleMessage(msg).catch((err) =>
    log("error", "Message handler failed", {
      from: msg.from,
      error: String(err),
    }),
  );
});

log("info", "Amana backend listening", {
  port: PORT,
  frontendUrl: FRONTEND_URL,
  sharedSecretSet: SHARED_SECRET.length > 0,
});

// 5-min tick: money-request expiry sweep + single nudges (best-effort;
// a missed tick only delays a reminder, never money).
const SWEEP_MS = 5 * 60 * 1_000;
setInterval(() => {
  void import("./whatsappbot/requests.ts").then(({ tickRequestSweep }) =>
    tickRequestSweep().catch((err) =>
      log("warn", "Request sweep tick failed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    ),
  );
}, SWEEP_MS);
