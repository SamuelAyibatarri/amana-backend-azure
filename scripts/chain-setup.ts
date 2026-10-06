import "dotenv/config";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase58Codec,
} from "@solana/kit";
import {
  ensureFunded,
  ensureMirrorMint,
  loadTreasury,
  solscanAddress,
  type MirrorCurrency,
} from "../solana/solana.ts";

/**
 * One-time chain setup (run locally, once):
 *   bun run scripts/chain-setup.ts
 * Fresh secrets are appended to .env (chmod 600) — never printed.
 * Reuses the existing TREASURY_SECRET when set (never orphans funds).
 * Devnet faucet funds everything; costs zero real money.
 */
const BASE58 = getBase58Codec();
const ENV_PATH = join(import.meta.dir, "..", ".env");

function appendEnv(lines: string[]): void {
  writeFileSync(ENV_PATH, `\n${lines.join("\n")}\n`, { flag: "a" });
  chmodSync(ENV_PATH, 0o600);
}

if (process.env.TREASURY_SECRET) {
  console.log("Reusing TREASURY_SECRET from .env.");
} else {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const freshSecret = BASE58.decode(seed);
  process.env.TREASURY_SECRET = freshSecret;
  appendEnv([`TREASURY_SECRET=${freshSecret}`]);
  console.log("Generated TREASURY_SECRET and appended to .env (not shown).");
}
const treasury = await loadTreasury();

console.log(`TREASURY_ADDRESS=${treasury.address}`);

await ensureFunded(treasury);
console.log("Treasury funded.");

// One liability-matched mirror mint per ledger currency (PLAN.md §1).
// Day-1 supply seeds the pools; per-credit mint/burn keeps the peg after.
const pools: Array<{ currency: MirrorCurrency; supply: number }> = [
  { currency: "SOL", supply: 1_000 },
  { currency: "USDC", supply: 10_000 },
  { currency: "NGN", supply: 1_000_000 },
];
const mintLines: string[] = [];
for (const pool of pools) {
  const mint = await ensureMirrorMint(undefined, pool.supply);
  mintLines.push(`MIRROR_MINT_${pool.currency}=${mint}`);
  console.log(`MIRROR_MINT_${pool.currency} written to .env (not shown).`);
  console.log(`  View: ${solscanAddress(mint)}`);
}
appendEnv(mintLines);
console.log(`View treasury: ${solscanAddress(treasury.address)}`);

// Throwaway test recipient (receives only — needs no funds).
const recipientSeed = crypto.getRandomValues(new Uint8Array(32));
const recipient =
  await createKeyPairSignerFromPrivateKeyBytes(recipientSeed);
appendEnv([
  `TEST_RECIPIENT_ADDRESS=${recipient.address}`,
  `TEST_RECIPIENT_SECRET=${BASE58.decode(recipientSeed)}`,
]);
console.log(`TEST_RECIPIENT_ADDRESS=${recipient.address}`);
console.log("TEST_RECIPIENT_SECRET written to .env (not shown).");
console.log(`  View: ${solscanAddress(recipient.address)}`);
