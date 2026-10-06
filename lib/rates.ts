import { log } from "./log.ts";

/**
 * Buy pricing: live crypto/USD from CoinGecko (free, keyless), fixed
 * USD/NGN leg from env. 5-minute cache (polite + fast); stale cache then
 * hardcoded fallback — the bot never blocks on a price feed.
 */

export interface Quote {
  currency: "SOL" | "USDC";
  cryptoPerNgn: number;
  solUsd: number;
  usdcUsd: number;
  usdNgn: number;
  at: string;
  live: boolean;
}

const CACHE_MS = 5 * 60 * 1_000;
const FALLBACK = { solUsd: 119.35, usdcUsd: 1 };

let cache: { solUsd: number; usdcUsd: number; at: number; live: boolean } | null = null;

async function fetchCryptoUsd(): Promise<{
  prices: { solUsd: number; usdcUsd: number };
  live: boolean;
}> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin&vs_currencies=usd",
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    const body = (await res.json()) as {
      solana?: { usd?: number };
      ["usd-coin"]?: { usd?: number };
    };
    const solUsd = Number(body.solana?.usd);
    const usdcUsd = Number(body["usd-coin"]?.usd);
    if (!Number.isFinite(solUsd) || solUsd <= 0) throw new Error("Bad SOL price");
    const prices = {
      solUsd,
      usdcUsd: Number.isFinite(usdcUsd) && usdcUsd > 0 ? usdcUsd : 1,
    };
    cache = { ...prices, at: Date.now(), live: true };
    return { prices, live: true };
  } catch (err) {
    log("warn", "Price fetch failed, using fallback/cache", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (cache) {
      return {
        prices: { solUsd: cache.solUsd, usdcUsd: cache.usdcUsd },
        live: cache.live,
      };
    }
    return { prices: FALLBACK, live: false };
  }
}

/** NGN -> crypto quote for buys. `live=false` means fallback pricing. */
export async function getQuote(currency: "SOL" | "USDC"): Promise<Quote> {
  const usdNgn = Number(process.env.USD_NGN ?? "1360");
  let prices: { solUsd: number; usdcUsd: number };
  let live: boolean;
  if (cache && Date.now() - cache.at < CACHE_MS) {
    prices = { solUsd: cache.solUsd, usdcUsd: cache.usdcUsd };
    live = cache.live;
  } else {
    const fresh = await fetchCryptoUsd();
    prices = fresh.prices;
    live = fresh.live;
  }
  const usd = currency === "SOL" ? prices.solUsd : prices.usdcUsd;
  return {
    currency,
    cryptoPerNgn: 1 / (usd * usdNgn),
    solUsd: prices.solUsd,
    usdcUsd: prices.usdcUsd,
    usdNgn,
    at: new Date().toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
    live,
  };
}

/** Whole crypto units for an NGN amount at a quote. */
export function cryptoForNgn(ngn: number, quote: Quote): number {
  return ngn * quote.cryptoPerNgn;
}

/**
 * Fiat-denominated send conversion: NGN → crypto + confirm-screen label.
 * Pure (quote injected) — the send flow calls getQuote first, then this.
 */
export function convertSendNgn(
  ngn: number,
  currency: "SOL" | "USDC",
  quote: Quote,
): { crypto: number; label: string } {
  const crypto = cryptoForNgn(ngn, quote);
  const usd = currency === "SOL" ? quote.solUsd : quote.usdcUsd;
  const liveFlag = quote.live ? "" : " (last known rate)";
  return {
    crypto,
    label:
      `≈ ${crypto.toFixed(currency === "SOL" ? 5 : 2)} ${currency} ` +
      `@ $${usd}, ₦${quote.usdNgn}/$${liveFlag}`,
  };
}
