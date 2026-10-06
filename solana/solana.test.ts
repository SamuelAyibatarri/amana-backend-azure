import { describe, expect, test } from "bun:test";
import { mirrorMintFor, solscanAddress, solscanTx } from "./solana.ts";

const SOL_POOL = "C724EYySxSjExgefqvmgS3NHX1vgDJfSSPcVuQFEamim";
const USDC_POOL = "B8UtFLbdX8gCx7BeGtMKqhWmYbZHkPLye375gkLPYRXW";
const NGN_POOL = "AChgyP2f65i6vQK32PzfiKotVuJFvEhXBwBpZcgbRBwt";

describe("solscan links", () => {
  test("tx + address shapes", () => {
    expect(solscanTx("abc123")).toBe(
      "https://solscan.io/tx/abc123?cluster=devnet",
    );
    expect(solscanAddress("abc123")).toBe(
      "https://solscan.io/account/abc123?cluster=devnet",
    );
  });
});

describe("mirrorMintFor", () => {
  test("env mapping per currency; null when unset/invalid", () => {
    const saved = {
      SOL: process.env.MIRROR_MINT_SOL,
      USDC: process.env.MIRROR_MINT_USDC,
      NGN: process.env.MIRROR_MINT_NGN,
    };
    try {
      delete process.env.MIRROR_MINT_SOL;
      delete process.env.MIRROR_MINT_USDC;
      delete process.env.MIRROR_MINT_NGN;
      expect(mirrorMintFor("SOL")).toBeNull();

      process.env.MIRROR_MINT_SOL = SOL_POOL;
      process.env.MIRROR_MINT_USDC = USDC_POOL;
      process.env.MIRROR_MINT_NGN = NGN_POOL;
      expect(String(mirrorMintFor("SOL"))).toBe(SOL_POOL);
      expect(String(mirrorMintFor("USDC"))).toBe(USDC_POOL);
      expect(String(mirrorMintFor("NGN"))).toBe(NGN_POOL);

      process.env.MIRROR_MINT_SOL = "not-an-address!!!";
      expect(mirrorMintFor("SOL")).toBeNull();
    } finally {
      if (saved.SOL === undefined) delete process.env.MIRROR_MINT_SOL;
      else process.env.MIRROR_MINT_SOL = saved.SOL;
      if (saved.USDC === undefined) delete process.env.MIRROR_MINT_USDC;
      else process.env.MIRROR_MINT_USDC = saved.USDC;
      if (saved.NGN === undefined) delete process.env.MIRROR_MINT_NGN;
      else process.env.MIRROR_MINT_NGN = saved.NGN;
    }
  });
});
