/**
 * Create (or reuse) a devnet wallet and fund it via RPC airdrop.
 * No `solana` CLI required — pure web3.js.
 *
 *   npm run wallet
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import fs from "fs";
import "dotenv/config";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const WALLET_PATH = process.env.WALLET_KEYPAIR ?? "./devnet-wallet.json";

async function main() {
  let kp: Keypair;
  if (fs.existsSync(WALLET_PATH)) {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"))));
    console.log("Using existing wallet:", kp.publicKey.toBase58());
  } else {
    kp = Keypair.generate();
    fs.writeFileSync(WALLET_PATH, JSON.stringify(Array.from(kp.secretKey)));
    console.log("Created wallet:", kp.publicKey.toBase58(), "->", WALLET_PATH);
  }

  const connection = new Connection(RPC, "confirmed");
  const balance = await connection.getBalance(kp.publicKey);
  console.log("balance:", balance / LAMPORTS_PER_SOL, "SOL");
  if (balance >= 0.5 * LAMPORTS_PER_SOL) {
    console.log("Already funded enough for Day 1.");
    return;
  }

  try {
    console.log("Requesting devnet airdrop (1 SOL)...");
    const sig = await connection.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    const newBal = await connection.getBalance(kp.publicKey);
    console.log("airdrop ok:", sig, "| new balance:", newBal / LAMPORTS_PER_SOL, "SOL");
  } catch (e) {
    console.error("\nairdrop failed (the devnet faucet is frequently rate-limited).");
    console.error("Fund this address manually at https://faucet.solana.com :");
    console.error("  ", kp.publicKey.toBase58());
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
