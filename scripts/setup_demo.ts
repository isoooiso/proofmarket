/**
 * One-time demo prep: fixed mock-USDC mint + fund demo Phantom wallets.
 * Does NOT create markets. Run: npm run demo:setup
 *
 * Requires in .env before running:
 *   DEMO_WALLET_A — Phantom pubkey (OVER side)
 *   DEMO_WALLET_B — Phantom pubkey (NO side)
 */
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getMint,
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

const PROGRAM_ID = "9ZQJXjeop6xGjFAEvVTgHvWiBnbkVB9AMxo4D8aihxZs";
const TXLINE_PROGRAM_ID = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
const TXLINE_API_BASE = "https://txline-dev.txodds.com/api";
const MINT_DECIMALS = 6;
const FUND_RAW = 1_000_000_000; // 1000 USDC

interface DemoConfig {
  programId: string;
  txlineProgramId: string;
  txlineApiBase: string;
  mockUsdcMint: string;
  mintDecimals: number;
  keeperPubkey: string;
  demoWalletA: string;
  demoWalletB: string;
  fixtures: {
    over: {
      fixtureId: number;
      seq: number;
      statKeys: number[];
      op: string;
      yesThreshold: number;
      label: string;
    };
    under: {
      fixtureId: number;
      seq: number;
      statKeys: number[];
      op: null;
      yesThreshold: number;
      label: string;
    };
  };
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

function parsePubkey(envName: string): PublicKey {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    die(
      `${envName} is not set. Export your two Phantom devnet account pubkeys in .env before running demo:setup.`
    );
  }
  try {
    return new PublicKey(raw);
  } catch {
    die(`${envName} is not a valid Solana public key: ${raw}`);
  }
}

async function mintExists(connection: Connection, mint: PublicKey): Promise<boolean> {
  try {
    await getMint(connection, mint, undefined, TOKEN_PROGRAM_ID);
    return true;
  } catch {
    return false;
  }
}

function readExistingConfig(): DemoConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as DemoConfig;
  } catch {
    return null;
  }
}

async function resolveMockMint(
  connection: Connection,
  demoWallet: Keypair
): Promise<PublicKey> {
  const existing = readExistingConfig();
  if (existing?.mockUsdcMint) {
    const mint = new PublicKey(existing.mockUsdcMint);
    if (await mintExists(connection, mint)) {
      console.log(`Reusing mock USDC mint from demo-config.json: ${mint.toBase58()}`);
      return mint;
    }
    console.log(
      `demo-config.json mint ${existing.mockUsdcMint} not found on-chain; creating new mint`
    );
  }

  const mint = await createMint(
    connection,
    demoWallet,
    demoWallet.publicKey,
    demoWallet.publicKey,
    MINT_DECIMALS,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log(`Created new mock USDC mint: ${mint.toBase58()}`);
  return mint;
}

async function fundAta(
  connection: Connection,
  demoWallet: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  label: string
): Promise<{ ata: PublicKey; balance: number }> {
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    demoWallet,
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
    await mintTo(connection, demoWallet, mint, ata.address, demoWallet, need);
    console.log(`  ${label}: minted ${need} raw units -> ${ata.address.toBase58()}`);
  } else {
    console.log(`  ${label}: already funded (${before} raw) -> ${ata.address.toBase58()}`);
  }
  const after = Number((await getAccount(connection, ata.address)).amount);
  return { ata: ata.address, balance: after };
}

async function main() {
  console.log("ProofMarket demo setup (mock USDC + wallet funding)");
  console.log(`rpc=${RPC}`);
  console.log(`demo wallet keypair=${DEMO_KEYPAIR_PATH}`);

  const demoWallet = loadKeypair(DEMO_KEYPAIR_PATH);
  const walletA = parsePubkey("DEMO_WALLET_A");
  const walletB = parsePubkey("DEMO_WALLET_B");

  const connection = new Connection(RPC, "confirmed");
  const solBal = await connection.getBalance(demoWallet.publicKey);
  console.log(
    `demo wallet=${demoWallet.publicKey.toBase58()} (${(solBal / LAMPORTS_PER_SOL).toFixed(4)} SOL)`
  );
  if (solBal < 0.1 * LAMPORTS_PER_SOL) {
    console.warn("WARNING: demo wallet SOL balance is low; txs may fail.");
  }

  const mockUsdcMint = await resolveMockMint(connection, demoWallet);

  console.log("\nFunding associated token accounts (target 1000 USDC each):");
  const keeperAta = await fundAta(
    connection,
    demoWallet,
    mockUsdcMint,
    demoWallet.publicKey,
    "keeper (demo wallet)"
  );
  const ataA = await fundAta(connection, demoWallet, mockUsdcMint, walletA, "DEMO_WALLET_A");
  const ataB = await fundAta(connection, demoWallet, mockUsdcMint, walletB, "DEMO_WALLET_B");

  const config: DemoConfig = {
    programId: PROGRAM_ID,
    txlineProgramId: TXLINE_PROGRAM_ID,
    txlineApiBase: TXLINE_API_BASE,
    mockUsdcMint: mockUsdcMint.toBase58(),
    mintDecimals: MINT_DECIMALS,
    keeperPubkey: demoWallet.publicKey.toBase58(),
    demoWalletA: walletA.toBase58(),
    demoWalletB: walletB.toBase58(),
    fixtures: {
      over: {
        fixtureId: 17926593,
        seq: 1097,
        statKeys: [1, 2],
        op: "Add",
        yesThreshold: 2,
        label: "Turkey vs USA",
      },
      under: {
        fixtureId: 17588395,
        seq: 261,
        statKeys: [1],
        op: null,
        yesThreshold: 0,
        label: "single-stat under demo",
      },
    },
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  console.log("\n--- Summary ---");
  console.log(`mock USDC mint:     ${mockUsdcMint.toBase58()}`);
  console.log(`keeper ATA:         ${keeperAta.ata.toBase58()} (${keeperAta.balance} raw)`);
  console.log(`DEMO_WALLET_A ATA:  ${ataA.ata.toBase58()} (${ataA.balance} raw)`);
  console.log(`DEMO_WALLET_B ATA:  ${ataB.ata.toBase58()} (${ataB.balance} raw)`);
  console.log(`demo-config.json:   ${CONFIG_PATH}`);

  console.log("\n--- Phantom setup reminders ---");
  console.log(
    "1. Import the demo wallet devnet keypair into Phantom (Settings -> Add account -> import private key)."
  );
  console.log(`   Keypair file: ${DEMO_KEYPAIR_PATH}`);
  console.log(
    "2. Set DEMO_WALLET_A and DEMO_WALLET_B in .env to your two Phantom account pubkeys before running demo:setup."
  );
  console.log("3. In Phantom, switch to devnet and add the mock USDC mint if balances do not appear.");

  console.log("\n--- demo-config.json ---");
  console.log(JSON.stringify(config, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
