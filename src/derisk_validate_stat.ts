/**
 * DAY-1 DE-RISK PROBE
 *
 * Goal: confirm TxLINE's on-chain `validate_stat` works for a real fixture on
 * devnet, and measure how many compute units it costs. That number decides
 * whether our settlement instruction can share a transaction with validate_stat
 * (Solana caps a tx at 1.4M CU).
 *
 * Flow: fetch a stat proof bundle -> build validate_stat with a trivially-true
 * predicate -> simulate (read unitsConsumed) -> actually send to prove it lands.
 *
 *   npm run derisk
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs";
import "dotenv/config";

import { TxlineClient, mapValidateStatArgs } from "./txline";
import { dailyScoresRootsPda } from "./pdas";

const PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";

const FIXTURE_ID = Number(process.env.FIXTURE_ID ?? 17271370);
const SEQ = Number(process.env.SEQ ?? 401);
const STAT_KEY = Number(process.env.STAT_KEY ?? 1);
const STAT_KEY2 = process.env.STAT_KEY2 ? Number(process.env.STAT_KEY2) : undefined;

function loadWallet(): Keypair {
  const path = process.env.WALLET_KEYPAIR ?? "./devnet-wallet.json";
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

async function loadProgram(provider: anchor.AnchorProvider): Promise<anchor.Program> {
  let idl = await anchor.Program.fetchIdl(PROGRAM_ID, provider);
  if (!idl && fs.existsSync("idl/txoracle.json")) {
    idl = JSON.parse(fs.readFileSync("idl/txoracle.json", "utf8"));
  }
  if (!idl) throw new Error("Could not load TxLINE IDL — see idl/README.md");
  return new anchor.Program(idl as anchor.Idl, provider);
}

async function main() {
  const wallet = loadWallet();
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = await loadProgram(provider);
  const client = await TxlineClient.fromEnv(wallet);

  console.log(`Fetching stat-validation: fixture=${FIXTURE_ID} seq=${SEQ} statKey=${STAT_KEY}`);
  const v = await client.getStatValidation({
    fixtureId: FIXTURE_ID,
    seq: SEQ,
    statKey: STAT_KEY,
    statKey2: STAT_KEY2,
  });

  const { ts, fixtureSummary, fixtureProof, mainTreeProof, statA } = mapValidateStatArgs(v);

  // Trivially-true predicate so the proof path runs to completion and lands:
  // proven value > (value - 1)  ==> always true. We are measuring the proof cost,
  // not testing market semantics here.
  const predicate = { threshold: v.statToProve.value - 1, comparison: { greaterThan: {} } };

  const epochDay = Math.floor(v.ts / (24 * 60 * 60 * 1000));
  const rootsPda = dailyScoresRootsPda(PROGRAM_ID, epochDay);
  console.log("daily_scores_roots PDA:", rootsPda.toBase58(), "(epochDay", epochDay + ")");

  const ix = await program.methods
    .validateStat(ts, fixtureSummary, fixtureProof, mainTreeProof, predicate, statA, null, null)
    .accounts({ dailyScoresMerkleRoots: rootsPda })
    .instruction();

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  // --- Measure compute via simulation ---
  console.log("\nSimulating to measure compute...");
  const sim = await connection.simulateTransaction(tx);
  console.log("simulation error:", sim.value.err);
  console.log("COMPUTE UNITS CONSUMED:", sim.value.unitsConsumed);
  if (sim.value.logs) console.log("logs:\n  " + sim.value.logs.join("\n  "));

  if (sim.value.err) {
    console.log("\nSimulation failed — proof/predicate/account mismatch. Iterate on the mapping or target fixture.");
    return;
  }

  // --- Send for real to prove it lands on devnet ---
  console.log("\nSending validate_stat to devnet...");
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
  console.log("validate_stat tx:", sig);

  const cu = sim.value.unitsConsumed ?? 0;
  console.log("\n=== DE-RISK RESULT ===");
  console.log(`validate_stat consumes ~${cu} CU.`);
  console.log(
    cu < 1_100_000
      ? "-> Headroom for a light settle_market in the SAME tx (atomic introspection design is viable)."
      : "-> Tight: settle_market may not fit alongside it; plan the fallback (settle reads a separate verified-outcome account)."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
