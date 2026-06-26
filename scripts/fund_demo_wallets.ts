/**
 * Mint mock USDC to demo Phantom wallets A/B (from demo-config.json).
 * Run: npm run fund:demo-wallets
 *
 * Uses SOLANA_KEYPAIR_PATH as mint authority payer (same as demo:setup).
 * Creates ATAs if missing. Target: 1000 USDC each.
 */
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";
import "dotenv/config";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const DEMO_KEYPAIR_PATH =
  process.env.SOLANA_KEYPAIR_PATH ??
  path.join(os.homedir(), ".config", "solana", "id.json");
const CONFIG_PATH = path.join(process.cwd(), "demo-config.json");
const FUND_RAW = 1_000_000_000; // 1000 USDC (6 decimals)

interface DemoConfig {
  mockUsdcMint: string;
  demoWalletA: string;
  demoWalletB: string;
}

function die(msg: string): never {
  console.error("\nERROR:", msg);
  process.exit(1);
}

function loadKeypair(filePath: string): Keypair {
  if (!fs.existsSync(filePath)) die(`keypair not found: ${filePath}`);
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(filePath, "utf8")))
  );
}

async function fundAta(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  label: string
): Promise<void> {
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    owner,
    false,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );
  const before = Number((await getAccount(connection, ata.address)).amount);
  if (before < FUND_RAW) {
    const need = FUND_RAW - before;
    await mintTo(connection, payer, mint, ata.address, payer, need);
    console.log(`  ${label}: minted ${need} raw units -> ${ata.address.toBase58()}`);
  } else {
    console.log(`  ${label}: already >= 1000 USDC (${before} raw) -> ${ata.address.toBase58()}`);
  }
  const after = Number((await getAccount(connection, ata.address)).amount);
  console.log(`  ${label} balance: ${after} raw (${after / 1_000_000} USDC)`);
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    die(`demo-config.json not found. Run npm run demo:setup first.`);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as DemoConfig;
  if (!config.mockUsdcMint || !config.demoWalletA || !config.demoWalletB) {
    die("demo-config.json missing mockUsdcMint / demoWalletA / demoWalletB");
  }

  const payer = loadKeypair(DEMO_KEYPAIR_PATH);
  const connection = new Connection(RPC, "confirmed");
  const mint = new PublicKey(config.mockUsdcMint);
  const walletA = new PublicKey(config.demoWalletA);
  const walletB = new PublicKey(config.demoWalletB);

  const solBal = await connection.getBalance(payer.publicKey);
  console.log("Fund demo wallets (mock USDC)");
  console.log(`rpc=${RPC}`);
  console.log(`mint=${mint.toBase58()}`);
  console.log(`payer=${payer.publicKey.toBase58()} (${(solBal / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  if (solBal < 0.05 * LAMPORTS_PER_SOL) {
    console.warn("WARNING: payer SOL balance is low; txs may fail.");
  }

  console.log("\nFunding to 1000 USDC each:");
  await fundAta(connection, payer, mint, walletA, "demoWalletA");
  await fundAta(connection, payer, mint, walletB, "demoWalletB");
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
