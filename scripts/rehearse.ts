import "dotenv/config";
import {
  burnMirror,
  mirrorMintFor,
  reserveSupply,
  sendSol,
  solscanTx,
  loadTreasury,
  solscanAddress,
} from "../solana/solana.ts";
import { createSolanaRpc, devnet } from "@solana/kit";

/** Dry rehearsal: treasury -> test recipient + SOL mirror burn. */
const recipient = process.argv[2];
if (!recipient) throw new Error("Usage: bun run scripts/rehearse.ts <address>");
const amount = Number(process.argv[3] ?? "0.1");

const treasury = await loadTreasury();
console.log(`Treasury: ${solscanAddress(treasury.address)}`);

const mint = mirrorMintFor("SOL");
const before = mint ? await reserveSupply(mint) : null;

const sig = await sendSol(recipient, amount);
console.log(`Sent ${amount} SOL. Proof: ${solscanTx(sig)}`);

await burnMirror("SOL", amount);
console.log("Mirror burned.");

const rpc = createSolanaRpc(devnet("https://api.devnet.solana.com"));
const { value: balance } = await rpc
  .getBalance(recipient as Parameters<typeof rpc.getBalance>[0], {
    commitment: "confirmed",
  })
  .send();
console.log(`Recipient balance: ${Number(balance) / 1e9} SOL`);
if (mint && before !== null) {
  const after = await reserveSupply(mint);
  console.log(`Reserve before=${before} after=${after} (base units)`);
}
