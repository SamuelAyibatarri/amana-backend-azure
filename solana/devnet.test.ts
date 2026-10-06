/**
 * GATED Solana Devnet integration tests — SKIPPED unless RUN_INTEGRATION=1.
 *
 * Prerequisites:
 * - Run from `amana-backend-azure/` so bun auto-loads `.env`
 *   (`TREASURY_SECRET`, `MIRROR_MINT_*`).
 * - Treasury funded with devnet SOL. RPC `requestAirdrop` 429s (dry /
 *   rate-limited) — fund via browser faucet (see MEMORY.md Chain note),
 *   not `ensureFunded`/airdrop.
 * - `TEST_RECIPIENT_ADDRESS` exported (chain-setup.ts prints it;
 *   throwaway recipient in MEMORY.md). Test 2 fails with a clear
 *   message when unset.
 *
 * Run: `RUN_INTEGRATION=1 bun test solana/devnet.test.ts`
 * Costs: tiny lamports + fees only (0.001 SOL send, small NGN mirror
 * mint→burn round-trip, balance reads).
 *
 * Scope notes:
 * - `/health/mirror` logic NOT tested here (needs backend + frontend
 *   servers). Test 4 only asserts `mirrorMintFor` returns all three
 *   pool mints from env.
 * - Paystack NOT tested here (frontend-side). Its integration runbook:
 *   test-mode initialize ₦100 + dashboard verify button (frontend
 *   `/api/payments/*` + webhook route).
 */
import { describe, expect, test } from "bun:test";
import { createSolanaRpc, devnet } from "@solana/kit";
import {
  burnMirror,
  burnMirrorBase,
  loadTreasury,
  mintMirror,
  mirrorMintFor,
  mirrorMove,
  reserveSupply,
  sendSol,
  solscanTx,
} from "./solana.ts";

const RUN = process.env.RUN_INTEGRATION === "1";
// Early-describe guard: default `bun test` registers suite skipped,
// zero network. Live run: RUN_INTEGRATION=1.
const gated = RUN ? describe : describe.skip;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

function recipientOrThrow(): string {
  const r =
    process.env.TEST_RECIPIENT_ADDRESS ?? process.env.TEST_RECIPIENT;
  if (!r) {
    throw new Error(
      "Set TEST_RECIPIENT_ADDRESS=<devnet address> (printed by scripts/chain-setup.ts; throwaway in MEMORY.md) before RUN_INTEGRATION=1.",
    );
  }
  return r;
}

gated("devnet integration (gated)", () => {
  test(
    "treasury loads and holds non-zero SOL",
    async () => {
      const treasury = await loadTreasury();
      const rpc = createSolanaRpc(devnet("https://api.devnet.solana.com"));
      const { value: balance } = await rpc
        .getBalance(treasury.address, { commitment: "confirmed" })
        .send();
      expect(balance).toBeGreaterThan(0n);
    },
    120_000,
  );

  test(
    "sendSol 0.001 SOL returns base58 sig + solscan shape",
    async () => {
      const to = recipientOrThrow();
      const sig = await sendSol(to, 0.001);
      expect(sig).toMatch(BASE58_RE);
      expect(sig.length).toBeGreaterThanOrEqual(80);
      const link = solscanTx(sig);
      expect(link).toContain(sig);
      expect(link).toBe(
        `https://solscan.io/tx/${sig}?cluster=devnet`,
      );
    },
    120_000,
  );

  test(
    "NGN mirror mint→burn round-trip leaves reserve supply equal",
    async () => {
      // NGN pool: lowest supply-risk (NGN rail refused, see conventions).
      const mint = mirrorMintFor("NGN");
      if (!mint) throw new Error("MIRROR_MINT_NGN not configured in .env.");
      const before = await reserveSupply(mint);
      await mintMirror("NGN", 0.001);
      await burnMirror("NGN", 0.001);
      const after = await reserveSupply(mint);
      expect(after).toBe(before);
    },
    120_000,
  );

  test(
    "mirrorMove single-tx mint+burn leaves USDC supply equal",
    async () => {
      // Net-zero internal leg: supply before == supply after.
      const mint = mirrorMintFor("USDC");
      if (!mint) throw new Error("MIRROR_MINT_USDC not configured in .env.");
      const before = await reserveSupply(mint);
      const sig = await mirrorMove("USDC", 0.001);
      expect(sig).toMatch(BASE58_RE);
      const after = await reserveSupply(mint);
      expect(after).toBe(before);
    },
    120_000,
  );

  test(
    "burnMirrorBase burns exact base units",
    async () => {
      // Rebalance precision path: mint then burn exact base units.
      const mint = mirrorMintFor("NGN");
      if (!mint) throw new Error("MIRROR_MINT_NGN not configured in .env.");
      const before = await reserveSupply(mint);
      await mintMirror("NGN", 0.001);
      const mid = await reserveSupply(mint);
      expect(mid - before).toBe(1000n);
      await burnMirrorBase("NGN", 1000n);
      const after = await reserveSupply(mint);
      expect(after).toBe(before);
    },
    120_000,
  );

  test(
    "mirrorMintFor returns all three pool mints from env",    async () => {
      // Pure env read (no network). Gated with the rest so default
      // `bun test` stays zero-network. Full peg check lives in
      // GET /health/mirror (needs both servers).
      expect(String(mirrorMintFor("SOL"))).toMatch(BASE58_RE);
      expect(String(mirrorMintFor("USDC"))).toMatch(BASE58_RE);
      expect(String(mirrorMintFor("NGN"))).toMatch(BASE58_RE);
    },
    120_000,
  );
});
