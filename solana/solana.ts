import {
  address,
  airdropFactory,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  devnet,
  generateKeyPairSigner,
  getBase58Codec,
  lamports,
  pipe,
  createTransactionMessage,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getBurnCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMintInstruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { getCreateAccountInstruction } from "@solana-program/system";
import { log } from "../lib/log.ts";

/**
 * Solana Devnet via @solana/kit functional pipelines (no web3.js).
 * Treasury signs and pays — users never hold SOL for fees (gasless story).
 * TREASURY_SECRET is the base58 32-byte seed (backend .env only, demo
 * grade — KMS/HSM is post-hackathon).
 */

const rpc = createSolanaRpc(devnet("https://api.devnet.solana.com"));
const rpcSubscriptions = createSolanaRpcSubscriptions(
  devnet("wss://api.devnet.solana.com"),
);
const sendAndConfirm = sendAndConfirmTransactionFactory({
  rpc,
  rpcSubscriptions,
});
const airdrop = airdropFactory({ rpc, rpcSubscriptions });

const BASE58 = getBase58Codec();

let treasuryCache: KeyPairSigner | null = null;

/** Treasury signer from TREASURY_SECRET (base58 32-byte seed). */
export async function loadTreasury(): Promise<KeyPairSigner> {
  if (treasuryCache) return treasuryCache;
  const secret = process.env.TREASURY_SECRET;
  if (!secret) {
    throw new Error(
      "Missing TREASURY_SECRET. Run `bun run scripts/chain-setup.ts` once, then copy it into .env.",
    );
  }
  treasuryCache = await createKeyPairSignerFromPrivateKeyBytes(BASE58.encode(secret));
  return treasuryCache;
}

export function solscanTx(signature: string): string {
  return `https://solscan.io/tx/${signature}?cluster=devnet`;
}

export function solscanAddress(addr: string): string {
  return `https://solscan.io/account/${addr}?cluster=devnet`;
}

async function buildAndSend(
  feePayer: KeyPairSigner,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
): Promise<string> {
  const { value: lifetime } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  // Signing erases the specific lifetime from the type; re-narrow to the
  // blockhash form this pipeline always builds.
  assertIsTransactionWithBlockhashLifetime(signed);
  await sendAndConfirm(signed, { commitment: "confirmed" });
  return getSignatureFromTransaction(signed);
}

/** Airdrop when the treasury falls below `minSol` (devnet faucet, free). */
export async function ensureFunded(
  signer: KeyPairSigner,
  minSol = 0.5,
): Promise<void> {
  const { value: balance } = await rpc
    .getBalance(signer.address, { commitment: "confirmed" })
    .send();
  if (balance >= BigInt(Math.round(minSol * 1_000_000_000))) return;
  log("info", "Treasury low — requesting devnet airdrop", {
    address: signer.address,
  });
  await airdrop({
    commitment: "confirmed",
    recipientAddress: signer.address,
    lamports: lamports(2_000_000_000n),
  });
}

/**
 * Real devnet SOL send. Throws on invalid address or chain failure —
 * callers must treat this as "nothing moved" and say so.
 */
export async function sendSol(
  destination: string,
  amountSol: number,
): Promise<string> {
  let to: Address;
  try {
    to = address(destination.trim());
  } catch {
    throw new Error(`Not a valid Solana address: ${destination}`);
  }
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error(`Invalid SOL amount: ${amountSol}`);
  }
  const treasury = await loadTreasury();
  await ensureFunded(treasury);
  const ix = getTransferSolInstruction({
    source: treasury,
    destination: to,
    amount: BigInt(Math.round(amountSol * 1_000_000_000)),
  });
  const sig = await buildAndSend(treasury, [ix]);
  log("info", "Devnet SOL sent", { to, amountSol, signature: sig });
  return sig;
}

/**
 * Mirror mint (AMANA test token, 6 decimals). Returns the mint address.
 * Pass an existing mint to skip creation; otherwise creates mint +
 * treasury ATA + test supply in one confirmed transaction batch.
 */
export async function ensureMirrorMint(
  existing?: string,
  supplyWhole = 1_000_000,
): Promise<Address> {
  if (existing) return address(existing.trim());
  const treasury = await loadTreasury();
  await ensureFunded(treasury);
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  const [ata] = await findAssociatedTokenPda({
    mint: mint.address,
    owner: treasury.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const createMint = getCreateAccountInstruction({
    payer: treasury,
    newAccount: mint,
    lamports: rent,
    space,
    programAddress: TOKEN_PROGRAM_ADDRESS,
  });
  const initMint = getInitializeMintInstruction({
    mint: mint.address,
    decimals: 6,
    mintAuthority: treasury.address,
  });
  await buildAndSend(treasury, [createMint, initMint]);
  const createAta = getCreateAssociatedTokenIdempotentInstruction({
    payer: treasury,
    ata,
    owner: treasury.address,
    mint: mint.address,
  });
  const mintTo = getMintToCheckedInstruction({
    mint: mint.address,
    token: ata,
    mintAuthority: treasury,
    amount: BigInt(Math.round(supplyWhole * 1_000_000)),
    decimals: 6,
  });
  await buildAndSend(treasury, [createAta, mintTo]);
  log("info", "Mirror mint created + supplied", {
    mint: mint.address,
    ata,
    supplyWhole,
  });
  return mint.address;
}

// ---------------------------------------------------------------------------
// Liability-matched mirror pools (PLAN.md §1/§6).
// One mint per ledger currency; reserve supply must equal summed user
// liabilities. Mint on ledger credit, burn on chain withdrawal.
// ---------------------------------------------------------------------------

export type MirrorCurrency = "SOL" | "USDC" | "NGN";

export const MIRROR_DECIMALS = 6;

const MIRROR_MINT_ENV: Record<MirrorCurrency, string> = {
  SOL: "MIRROR_MINT_SOL",
  USDC: "MIRROR_MINT_USDC",
  NGN: "MIRROR_MINT_NGN",
};

/** Mint address for a currency pool, or null when not configured. */
export function mirrorMintFor(currency: MirrorCurrency): Address | null {
  const raw = process.env[MIRROR_MINT_ENV[currency]];
  if (!raw) return null;
  try {
    return address(raw.trim());
  } catch {
    return null;
  }
}

/** Treasury reserve ATA for a mirror mint (derived, never stored). */
export async function reserveAta(mint: Address): Promise<Address> {
  const treasury = await loadTreasury();
  const [ata] = await findAssociatedTokenPda({
    mint,
    owner: treasury.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

function toMirrorUnits(amountWhole: number): bigint {
  return BigInt(Math.round(amountWhole * 10 ** MIRROR_DECIMALS));
}

/**
 * Mint mirror tokens into the reserve on ledger credit. Throws when the
 * pool is unconfigured or the chain rejects — callers log a mirror-gap
 * (ledger stands; the peg understates, never overstates).
 */
export async function mintMirror(
  currency: MirrorCurrency,
  amountWhole: number,
): Promise<string> {
  const mint = mirrorMintFor(currency);
  if (!mint) throw new Error(`Mirror pool not configured for ${currency}.`);
  const treasury = await loadTreasury();
  await ensureFunded(treasury);
  const ata = await reserveAta(mint);
  const createAta = getCreateAssociatedTokenIdempotentInstruction({
    payer: treasury,
    ata,
    owner: treasury.address,
    mint,
  });
  const mintTo = getMintToCheckedInstruction({
    mint,
    token: ata,
    mintAuthority: treasury,
    amount: toMirrorUnits(amountWhole),
    decimals: MIRROR_DECIMALS,
  });
  const sig = await buildAndSend(treasury, [createAta, mintTo]);
  log("info", "Mirror minted on credit", { currency, amountWhole, sig });
  return sig;
}

/**
 * Burn mirror from the reserve on chain withdrawal. Throws on failure —
 * callers must only burn after the withdrawal itself landed.
 */
export async function burnMirror(
  currency: MirrorCurrency,
  amountWhole: number,
): Promise<string> {
  return burnMirrorBase(currency, toMirrorUnits(amountWhole));
}

/**
 * Burn an exact base-unit amount (rebalance precision — no float).
 * Throws when the pool is unconfigured or the chain rejects.
 */
export async function burnMirrorBase(
  currency: MirrorCurrency,
  amountBase: bigint,
): Promise<string> {
  const mint = mirrorMintFor(currency);
  if (!mint) throw new Error(`Mirror pool not configured for ${currency}.`);
  if (amountBase <= 0n) throw new Error(`Nothing to burn for ${currency}.`);
  const treasury = await loadTreasury();
  await ensureFunded(treasury);
  const ata = await reserveAta(mint);
  const burn = getBurnCheckedInstruction({
    account: ata,
    mint,
    authority: treasury,
    amount: amountBase,
    decimals: MIRROR_DECIMALS,
  });
  const sig = await buildAndSend(treasury, [burn]);
  log("info", "Mirror burned on withdrawal", { currency, amountBase: amountBase.toString(), sig });
  return sig;
}

/**
 * Net-zero internal leg for phone-to-phone sends: mint + burn the same
 * amount in ONE transaction. Liability changes hands, never totals —
 * supply before == supply after, by construction. Throws on failure
 * (caller logs a mirror-gap; the ledger always stands).
 */
export async function mirrorMove(
  currency: MirrorCurrency,
  amountWhole: number,
): Promise<string> {
  const mint = mirrorMintFor(currency);
  if (!mint) throw new Error(`Mirror pool not configured for ${currency}.`);
  const units = toMirrorUnits(amountWhole);
  if (units <= 0n) throw new Error(`Nothing to move for ${currency}.`);
  const treasury = await loadTreasury();
  await ensureFunded(treasury);
  const ata = await reserveAta(mint);
  const mintTo = getMintToCheckedInstruction({
    mint,
    token: ata,
    mintAuthority: treasury,
    amount: units,
    decimals: MIRROR_DECIMALS,
  });
  const burn = getBurnCheckedInstruction({
    account: ata,
    mint,
    authority: treasury,
    amount: units,
    decimals: MIRROR_DECIMALS,
  });
  const sig = await buildAndSend(treasury, [mintTo, burn]);
  log("info", "Mirror net-zero move (internal send)", { currency, amountWhole, sig });
  return sig;
}

/** Current reserve supply (base units) for invariant checks. */
export async function reserveSupply(mint: Address): Promise<bigint> {
  const ata = await reserveAta(mint);
  const { value } = await rpc
    .getTokenAccountBalance(ata, { commitment: "confirmed" })
    .send();
  return BigInt(value.amount);
}

// ---------------------------------------------------------------------------
// Treasury USDC stock (Circle devnet mint, USDC_MINT). Real withdrawals.
// ---------------------------------------------------------------------------

export const USDC_DECIMALS = 6;

function usdcMint(): Address {
  const raw = process.env.USDC_MINT;
  if (!raw) throw new Error("USDC_MINT is not configured.");
  return address(raw.trim());
}

/**
 * Real devnet USDC send from treasury stock. Creates the recipient ATA
 * idempotently in the same transaction. Throws on failure.
 */
export async function sendUsdc(
  destination: string,
  amountWhole: number,
): Promise<string> {
  let owner: Address;
  try {
    owner = address(destination.trim());
  } catch {
    throw new Error(`Not a valid Solana address: ${destination}`);
  }
  if (!Number.isFinite(amountWhole) || amountWhole <= 0) {
    throw new Error(`Invalid USDC amount: ${amountWhole}`);
  }
  const mint = usdcMint();
  const treasury = await loadTreasury();
  await ensureFunded(treasury);
  const [source] = await findAssociatedTokenPda({
    mint,
    owner: treasury.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [ata] = await findAssociatedTokenPda({
    mint,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const createAta = getCreateAssociatedTokenIdempotentInstruction({
    payer: treasury,
    ata,
    owner,
    mint,
  });
  const transfer = getTransferCheckedInstruction({
    source,
    mint,
    destination: ata,
    authority: treasury,
    amount: BigInt(Math.round(amountWhole * 10 ** USDC_DECIMALS)),
    decimals: USDC_DECIMALS,
  });
  const sig = await buildAndSend(treasury, [createAta, transfer]);
  log("info", "Devnet USDC sent", { to: owner, amountWhole, signature: sig });
  return sig;
}
