import "dotenv/config";
import {
  burnMirrorBase,
  solscanTx,
  type MirrorCurrency,
} from "../solana/solana.ts";

/**
 * One-time mirror rebalance (run locally, once, with backend+frontend up):
 *   bun run scripts/rebalance.ts
 * Burns each pool's unbacked surplus (mirror supply − ledger net) in
 * exact base units, then re-checks `/health/mirror` until allMatch.
 * Logged, on Solscan. Never repeats — mirrorMove keeps the peg after.
 */
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3001";

interface Pool {
  currency: string;
  ledgerBase: string;
  mirrorBase: string;
  match: boolean;
}

async function report(): Promise<{ allMatch: boolean; pools: Pool[] }> {
  const res = await fetch(`${BACKEND}/health/mirror`);
  if (!res.ok) throw new Error(`/health/mirror HTTP ${res.status}`);
  return (await res.json()) as { allMatch: boolean; pools: Pool[] };
}

const before = await report();
console.log(`allMatch before: ${before.allMatch}`);
for (const p of before.pools) {
  const surplus = BigInt(p.mirrorBase) - BigInt(p.ledgerBase);
  console.log(
    `${p.currency}: ledger=${p.ledgerBase} mirror=${p.mirrorBase} surplus=${surplus} match=${p.match}`,
  );
  if (surplus > 0n) {
    const sig = await burnMirrorBase(p.currency as MirrorCurrency, surplus);
    console.log(`  burned ${surplus} base units: ${solscanTx(sig)}`);
  } else if (surplus < 0n) {
    throw new Error(`${p.currency} UNDERBACKED by ${-surplus} — refusing (investigate, never mint blind).`);
  }
}

const after = await report();
console.log(`allMatch after: ${after.allMatch}`);
for (const p of after.pools) {
  console.log(`${p.currency}: ledger=${p.ledgerBase} mirror=${p.mirrorBase} match=${p.match}`);
}
if (!after.allMatch) throw new Error("Still mismatched — investigate before proceeding.");
console.log("Peg holds. Done.");
