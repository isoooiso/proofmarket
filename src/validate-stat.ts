/**
 * DE-RISK: call TxLINE's on-chain `validate_stat` on devnet using a real
 * stat-validation payload, then measure compute units.
 *
 *   npm run validate:stat            # simulation only (default)
 *   npm run validate:stat -- --send  # also send the tx on devnet
 *
 * This builds the instruction via Anchor from the TxLINE IDL (fetched on-chain,
 * with a local idl/txoracle.json fallback) so the argument encoding is exactly
 * what the program expects — it is NOT hand-guessed. The arg order/types match
 * the devnet IDL and are documented in PROGRAM_DESIGN.md.
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
import axios from "axios";
import fs from "fs";
import "dotenv/config";

// ----------------------------------------------------------------- config ---
const PROGRAM_ID = new PublicKey(
  process.env.TXLINE_PROGRAM_ID ?? "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
);
const RPC = process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? "https://api.devnet.solana.com";
const API = process.env.TXLINE_API ?? "https://txline-dev.txodds.com/api";
const JWT = process.env.TXLINE_JWT ?? "";
const API_TOKEN = process.env.TXLINE_API_TOKEN ?? "";

const FIXTURE_ID = Number(process.env.TXLINE_FIXTURE_ID ?? process.env.FIXTURE_ID ?? 17588395);
const SEQ = Number(process.env.TXLINE_SEQ ?? process.env.SEQ ?? 261);
const STAT_KEY = Number(process.env.TXLINE_STAT_KEY ?? process.env.STAT_KEY ?? 1);

const SEND = process.argv.includes("--send");

function die(msg: string): never {
  console.error("\nERROR:", msg);
  process.exit(1);
}

// ------------------------------------------------------------------ helpers --
function loadWallet(): Keypair {
  const path =
    process.env.SOLANA_KEYPAIR_PATH ?? process.env.WALLET_KEYPAIR ?? "./devnet-wallet.json";
  if (!fs.existsSync(path)) die(`wallet keypair not found at ${path} (run \`npm run wallet\`)`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

/** daily_scores_roots PDA: seed "daily_scores_roots" + epochDay as u16 LE. */
function dailyScoresRootsPda(epochDay: number): PublicKey {
  if (!Number.isInteger(epochDay) || epochDay < 0 || epochDay > 65535) {
    die(`invalid epochDay ${epochDay}; expected u16`);
  }

  const le = Buffer.alloc(2);
  le.writeUInt16LE(epochDay, 0);

  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), le],
    PROGRAM_ID
  );

  return pda;
}

type HashLike = string | number[];
function toBytes32(h: HashLike): number[] {
  if (Array.isArray(h)) return h;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(h)) return Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
  const buf = Buffer.from(h, "base64");
  if (buf.length !== 32) die(`unexpected hash length ${buf.length}; adjust toBytes32 for the real format`);
  return Array.from(buf);
}

interface RawValidation {
  ts: number;
  statToProve: { key: number; value: number; period: number };
  eventStatRoot: HashLike;
  statProof: Array<{ hash: HashLike; isRightSibling: boolean }>;
  subTreeProof: Array<{ hash: HashLike; isRightSibling: boolean }>;
  mainTreeProof: Array<{ hash: HashLike; isRightSibling: boolean }>;
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: HashLike;
  };
}

const mapProof = (nodes: RawValidation["statProof"]) =>
  nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));

async function fetchValidation(): Promise<RawValidation> {
  if (!JWT) die("TXLINE_JWT missing in .env (run `npm run subscribe`)");
  if (!API_TOKEN) die("TXLINE_API_TOKEN missing in .env (run `npm run subscribe`)");
  try {
    const res = await axios.get(`${API}/scores/stat-validation`, {
      params: { fixtureId: FIXTURE_ID, seq: SEQ, statKey: STAT_KEY },
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${JWT}`, // session JWT
        "X-Api-Token": API_TOKEN, // long-lived API token
      },
      validateStatus: () => true,
    });
    if (res.status !== 200) {
      die(`stat-validation HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    return res.data as RawValidation;
  } catch (e: any) {
    return die(`stat-validation request failed: ${e.message}`);
  }
}

async function loadIdl(provider: anchor.AnchorProvider): Promise<anchor.Idl> {
  let idl = await anchor.Program.fetchIdl(PROGRAM_ID, provider);
  if (!idl && fs.existsSync("idl/txoracle.json")) {
    idl = JSON.parse(fs.readFileSync("idl/txoracle.json", "utf8"));
  }
  if (!idl) {
    die(
      "TxLINE IDL not found. fetchIdl returned null and idl/txoracle.json is missing.\n" +
        "Fix: copy the IDL JSON from https://txline-docs.txodds.com/documentation/programs/devnet.md " +
        "into idl/txoracle.json, then re-run."
    );
  }
  return idl as anchor.Idl;
}

// --------------------------------------------------------------------- main --
async function main() {
  console.log("ProofMarket — validate_stat de-risk");
  console.log(`fixtureId=${FIXTURE_ID} seq=${SEQ} statKey=${STAT_KEY}`);
  console.log(`program=${PROGRAM_ID.toBase58()}  rpc=${RPC}  send=${SEND}`);
  console.log(`auth: jwt ${JWT ? "present" : "MISSING"}, apiToken ${API_TOKEN ? "present" : "MISSING"}`);

  const wallet = loadWallet();
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const v = await fetchValidation();
  console.log("\nstatToProve:", JSON.stringify(v.statToProve));
  console.log(
    `proof lengths -> statProof=${v.statProof.length} subTreeProof(fixture)=${v.subTreeProof.length} mainTreeProof=${v.mainTreeProof.length}`
  );

  const idl = await loadIdl(provider);
  const program = new anchor.Program(idl, provider);

  // Map the raw payload into the exact validate_stat arg shapes (camelCase).
  // TxLINE validate_stat expects the snapshot timestamp used for Merkle-root seed generation.
// IMPORTANT: do NOT use top-level `v.ts` here. That is the validation response timestamp.
// The on-chain program expects summary.updateStats.minTimestamp.
const targetTs = Number(v.summary.updateStats.minTimestamp);
if (!Number.isFinite(targetTs) || targetTs <= 0) {
  die(`invalid targetTs from summary.updateStats.minTimestamp: ${targetTs}`);
}

const ts = new anchor.BN(targetTs);

const fixtureSummary = {
  fixtureId: new anchor.BN(v.summary.fixtureId),
  updateStats: {
    updateCount: v.summary.updateStats.updateCount,
    minTimestamp: new anchor.BN(v.summary.updateStats.minTimestamp),
    maxTimestamp: new anchor.BN(v.summary.updateStats.maxTimestamp),
  },
  eventsSubTreeRoot: toBytes32(v.summary.eventStatsSubTreeRoot),
};

const fixtureProof = mapProof(v.subTreeProof);
const mainTreeProof = mapProof(v.mainTreeProof);

const statA = {
  statToProve: {
    key: v.statToProve.key,
    value: v.statToProve.value,
    period: v.statToProve.period,
  },
  eventStatRoot: toBytes32(v.eventStatRoot),
  statProof: mapProof(v.statProof),
};

// Trivially true predicate for proof-cost measurement.
// Avoid value - 1 because value can be 0 and negative thresholds may break IDL/program expectations.
// If actual value is 0, this checks: 0 < 1.
const predicate = {
  threshold: v.statToProve.value + 1,
  comparison: { lessThan: {} },
};

const epochDay = Math.floor(targetTs / 86_400_000);
const rootsPda = dailyScoresRootsPda(epochDay);

console.log("\nTimestamp diagnostics:");
console.log(`  validation response ts:              ${v.ts}`);
console.log(`  summary.updateStats.minTimestamp:    ${v.summary.updateStats.minTimestamp}`);
console.log(`  summary.updateStats.maxTimestamp:    ${v.summary.updateStats.maxTimestamp}`);
console.log(`  targetTs used for validateStat/PDA:  ${targetTs}`);
console.log(`  epochDay:                            ${epochDay}`);
console.log(`daily_scores_roots PDA (epochDay ${epochDay}): ${rootsPda.toBase58()}`);

  let ix;
  try {
    ix = await (program.methods as any)
      .validateStat(ts, fixtureSummary, fixtureProof, mainTreeProof, predicate, statA, null, null)
      .accounts({ dailyScoresMerkleRoots: rootsPda })
      .instruction();
  } catch (e: any) {
    return die(`failed to build validateStat instruction (IDL/account mismatch): ${e.message}`);
  }

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }))
    .add(ix);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  console.log("\nSimulating...");
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.logs) console.log("logs:\n  " + sim.value.logs.join("\n  "));
  console.log("\nsimulation error:", sim.value.err);
  console.log("total CU consumed (tx):", sim.value.unitsConsumed);

  // Per-program CU (the validate_stat cost we care about for co-location math).
  const line = (sim.value.logs ?? []).find(
    (l) => l.includes(PROGRAM_ID.toBase58()) && l.includes("consumed")
  );
  const m = line?.match(/consumed (\d+) of (\d+)/);
  if (m) console.log(`validate_stat program CU: ${m[1]} (of ${m[2]} budget)`);

  if (sim.value.err) {
    die("simulation failed — see logs above (proof/predicate/account/IDL mismatch).");
  }

  if (SEND) {
    console.log("\nSending on devnet...");
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
    console.log("validate_stat tx:", sig);
  } else {
    console.log("\n(simulation only; pass --send to broadcast)");
  }

  const cu = m ? Number(m[1]) : sim.value.unitsConsumed ?? 0;
  console.log("\n=== DE-RISK RESULT ===");
  console.log(`validate_stat costs ~${cu} CU.`);
  console.log(
    cu > 0 && cu < 1_100_000
      ? "-> headroom for a light settle_market in the SAME tx (atomic introspection design is viable)."
      : "-> review co-location budget before finalizing settle_market (see PROGRAM_DESIGN.md fallback)."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
