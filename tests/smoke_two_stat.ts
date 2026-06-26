/**
 * Devnet two-stat O/U 2.5 integration smoke (Turkey vs USA 3-2, OVER wins).
 * Run: npm run test:smoke2
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorError, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import axios from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import "dotenv/config";

import { IDL, type Proofmarket } from "../target/types/proofmarket";

// --------------------------------------------------------------------------- config
const PROOFMARKET_PROGRAM_ID = new PublicKey(
  process.env.PROOFMARKET_PROGRAM_ID ?? IDL.address
);
const TXLINE_PROGRAM_ID = new PublicKey(
  process.env.TXLINE_PROGRAM_ID ?? "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
);
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const API = process.env.TXLINE_API ?? "https://txline-dev.txodds.com/api";
const JWT = process.env.TXLINE_JWT ?? "";
const API_TOKEN = process.env.TXLINE_API_TOKEN ?? "";

const FIXTURE_ID = 17926593;
const SEQ = 1097;
const STAT_KEY = 1;
const STAT_KEY2 = 2;
const YES_THRESHOLD = 2; // O/U 2.5 line as integer; OVER = total > 2

const DEPOSIT_YES = 300_000_000; // player A YES 300 USDC
const DEPOSIT_NO = 100_000_000; // player B NO 100 USDC
const MINT_PER_PLAYER = 1_000_000_000;

const DEPLOYER_KEYPAIR_PATH =
  process.env.SOLANA_KEYPAIR_PATH ??
  path.join(os.homedir(), ".config", "solana", "id.json");

// --------------------------------------------------------------------------- helpers
type HashLike = string | number[];

function die(msg: string): never {
  console.error("\nFATAL:", msg);
  process.exit(1);
}

function loadKeypair(filePath: string): Keypair {
  if (!fs.existsSync(filePath)) die(`keypair not found: ${filePath}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(filePath, "utf8"))));
}

function toBytes32(h: HashLike): number[] {
  if (Array.isArray(h)) return h;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(h)) {
    return Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
  }
  const buf = Buffer.from(h, "base64");
  if (buf.length !== 32) {
    die(`unexpected hash length ${buf.length}; adjust toBytes32 for the real format`);
  }
  return Array.from(buf);
}

interface RawValidation {
  ts: number;
  statToProve: { key: number; value: number; period: number };
  statToProve2?: { key: number; value: number; period: number };
  eventStatRoot: HashLike;
  statProof: Array<{ hash: HashLike; isRightSibling: boolean }>;
  statProof2?: Array<{ hash: HashLike; isRightSibling: boolean }>;
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

function i64Le(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(value));
  return buf;
}

function i32Le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value);
  return buf;
}

function dailyScoresRootsPda(epochDay: number): PublicKey {
  if (!Number.isInteger(epochDay) || epochDay < 0 || epochDay > 65535) {
    die(`invalid epochDay ${epochDay}; expected u16`);
  }
  const le = Buffer.alloc(2);
  le.writeUInt16LE(epochDay, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), le],
    TXLINE_PROGRAM_ID
  );
  return pda;
}

function marketPda(authority: PublicKey, fixtureId: number, yesThreshold: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), authority.toBuffer(), i64Le(fixtureId), i32Le(yesThreshold)],
    PROOFMARKET_PROGRAM_ID
  );
  return pda;
}

function vaultPda(market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    PROOFMARKET_PROGRAM_ID
  );
  return pda;
}

function positionPda(market: PublicKey, user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), user.toBuffer()],
    PROOFMARKET_PROGRAM_ID
  );
  return pda;
}

async function fetchValidation(): Promise<RawValidation> {
  if (!JWT) die("TXLINE_JWT missing in .env");
  if (!API_TOKEN) die("TXLINE_API_TOKEN missing in .env");
  const res = await axios.get(`${API}/scores/stat-validation`, {
    params: { fixtureId: FIXTURE_ID, seq: SEQ, statKey: STAT_KEY, statKey2: STAT_KEY2 },
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${JWT}`,
      "X-Api-Token": API_TOKEN,
    },
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    die(`stat-validation HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 500)}`);
  }
  return res.data as RawValidation;
}

function mapStatTerm(
  stat: { key: number; value: number; period: number },
  eventStatRoot: number[],
  proof: RawValidation["statProof"]
) {
  return {
    statToProve: { key: stat.key, value: stat.value, period: stat.period },
    eventStatRoot,
    statProof: mapProof(proof),
  };
}

function mapValidationToSettleArgs(v: RawValidation, yesThreshold: number) {
  if (!v.statToProve2 || !v.statProof2) {
    die("stat-validation missing statToProve2 / statProof2 for two-stat market");
  }

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
  const eventStatRoot = toBytes32(v.eventStatRoot);

  const statA = mapStatTerm(v.statToProve, eventStatRoot, v.statProof);
  const statB = mapStatTerm(v.statToProve2, eventStatRoot, v.statProof2);

  const predicate = {
    threshold: yesThreshold,
    comparison: { greaterThan: {} },
  };
  const op = { add: {} };
  const epochDay = Math.floor(targetTs / 86_400_000);
  const rootsPda = dailyScoresRootsPda(epochDay);

  return {
    ts,
    fixtureSummary,
    fixtureProof,
    mainTreeProof,
    predicate,
    statA,
    statB,
    op,
    targetTs,
    epochDay,
    rootsPda,
  };
}

function formatError(e: unknown): string {
  if (e instanceof AnchorError) {
    const logs = e.logs?.length ? `\nlogs:\n  ${e.logs.join("\n  ")}` : "";
    return `AnchorError ${e.error.errorCode.code} (${e.error.errorCode.number}): ${e.error.errorMessage}${logs}`;
  }
  if (e instanceof Error) return e.stack ?? e.message;
  return String(e);
}

const DEPLOYER_MIN_SOL = 0.5;
const POSITION_RENT_SOL = 0.01;
const MARKET_AUTHORITY_FUND_SOL = 0.05;

function isRpcRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /429|Too Many Requests|rate limit/i.test(msg);
}

async function withRpcRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < maxAttempts - 1 && isRpcRateLimitError(e)) {
        const delayMs = 2000 * (attempt + 1);
        console.log(`RPC 429 (${label}), retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
  die(`RPC retry exhausted: ${label}`);
}

async function getSolBalance(connection: Connection, pubkey: PublicKey): Promise<number> {
  return await connection.getBalance(pubkey);
}

function formatSol(lamports: number): string {
  return `${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
}

async function requestAirdropSol(
  connection: Connection,
  pubkey: PublicKey,
  sol: number
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      return;
    } catch (e) {
      if (attempt === 4) die(`airdrop failed for ${pubkey.toBase58()}: ${formatError(e)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function ensureDeployerSol(connection: Connection, deployer: Keypair): Promise<void> {
  const skipAirdrop = process.env.SKIP_AIRDROP === "1";
  const balance = await getSolBalance(connection, deployer.publicKey);
  const minLamports = DEPLOYER_MIN_SOL * LAMPORTS_PER_SOL;

  if (balance >= minLamports) {
    console.log(`deployer has ${formatSol(balance)} (>= ${DEPLOYER_MIN_SOL} SOL), skipping airdrop`);
    return;
  }

  if (skipAirdrop) {
    die(
      `deployer balance ${formatSol(balance)} below ${DEPLOYER_MIN_SOL} SOL and SKIP_AIRDROP=1`
    );
  }

  const needSol = DEPLOYER_MIN_SOL - balance / LAMPORTS_PER_SOL;
  const airdropSol = Math.max(needSol, 0.5);
  console.log(
    `deployer ${formatSol(balance)} < ${DEPLOYER_MIN_SOL} SOL, requesting ${airdropSol} SOL airdrop`
  );
  await requestAirdropSol(connection, deployer.publicKey, airdropSol);
}

async function transferSol(
  connection: Connection,
  from: Keypair,
  to: PublicKey,
  lamports: number
): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })
  );
  await withRpcRetry("transferSol", () =>
    sendAndConfirmTransaction(connection, tx, [from])
  );
}

async function fundSolFromDeployer(
  connection: Connection,
  deployer: Keypair,
  recipient: PublicKey,
  targetSol: number
): Promise<void> {
  const targetLamports = targetSol * LAMPORTS_PER_SOL;
  const balance = await getSolBalance(connection, recipient);
  if (balance >= targetLamports) return;
  await transferSol(connection, deployer, recipient, targetLamports - balance);
}

async function fundPositionRentFromDeployer(
  connection: Connection,
  deployer: Keypair,
  player: PublicKey
): Promise<void> {
  await fundSolFromDeployer(connection, deployer, player, POSITION_RENT_SOL);
}

async function runStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  console.log(`\n=== ${label} ===`);
  try {
    const result = await fn();
    return result;
  } catch (e) {
    console.error(`\nSTEP FAILED: ${label}`);
    console.error(formatError(e));
    process.exit(1);
  }
}

async function printTxLogs(connection: Connection, sig: string, label: string): Promise<void> {
  const tx = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = tx?.meta?.logMessages ?? [];
  console.log(`${label} program logs (${logs.length} lines):`);
  for (const line of logs) {
    console.log(`  ${line}`);
  }
}

// --------------------------------------------------------------------------- main
async function main() {
  console.log("ProofMarket devnet TWO-STAT O/U 2.5 smoke");
  console.log(`fixture=${FIXTURE_ID} seq=${SEQ} statKeys=${STAT_KEY}+${STAT_KEY2}`);
  console.log(`program=${PROOFMARKET_PROGRAM_ID.toBase58()}`);
  console.log(`txline=${TXLINE_PROGRAM_ID.toBase58()}`);
  console.log(`rpc=${RPC}`);

  const deployer = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  const marketAuthority = Keypair.generate();
  const playerA = Keypair.generate();
  const playerB = Keypair.generate();

  const connection = new Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(deployer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(IDL as anchor.Idl, provider) as Program<Proofmarket>;

  await runStep("deployer / player balances", async () => {
    await ensureDeployerSol(connection, deployer);
    const deployerBal = await getSolBalance(connection, deployer.publicKey);
    const authorityBal = await getSolBalance(connection, marketAuthority.publicKey);
    const playerABal = await getSolBalance(connection, playerA.publicKey);
    const playerBBal = await getSolBalance(connection, playerB.publicKey);
    console.log(`deployer=${deployer.publicKey.toBase58()} ${formatSol(deployerBal)}`);
    console.log(
      `marketAuthority=${marketAuthority.publicKey.toBase58()} ${formatSol(authorityBal)} (ephemeral per run)`
    );
    console.log(`playerA (YES)=${playerA.publicKey.toBase58()} ${formatSol(playerABal)}`);
    console.log(`playerB (NO)=${playerB.publicKey.toBase58()} ${formatSol(playerBBal)}`);
  });

  const validation = await runStep("STEP 1 — fetch two-stat stat-validation proof", async () => {
    const v = await fetchValidation();
    console.log(`statToProve (home)=${JSON.stringify(v.statToProve)}`);
    console.log(`statToProve2 (away)=${JSON.stringify(v.statToProve2)}`);
    console.log(
      `proof lens: statA=${v.statProof.length} statB=${v.statProof2?.length ?? 0} fixture=${v.subTreeProof.length} main=${v.mainTreeProof.length}`
    );
    if (!v.statToProve2 || !v.statProof2) {
      die("missing two-stat fields in stat-validation response");
    }
    const home = v.statToProve.value;
    const away = v.statToProve2.value;
    const total = home + away;
    console.log(`final score home-away=${home}-${away} total=${total} (O/U 2.5 -> ${total > 2 ? "OVER" : "UNDER"})`);
    if (total !== 5 || home !== 3 || away !== 2) {
      die(`expected 3-2 (total=5) for demo fixture, got ${home}-${away}`);
    }
    return v;
  });

  const period = validation.statToProve.period;
  const settleArgs = mapValidationToSettleArgs(validation, YES_THRESHOLD);
  const market = marketPda(marketAuthority.publicKey, FIXTURE_ID, YES_THRESHOLD);
  const vault = vaultPda(market);

  console.log(`targetTs=${settleArgs.targetTs} epochDay=${settleArgs.epochDay}`);
  console.log(`daily_scores_roots=${settleArgs.rootsPda.toBase58()}`);
  console.log(
    `market PDA=${market.toBase58()} (authority=${marketAuthority.publicKey.toBase58()}, yes_threshold=${YES_THRESHOLD}, period=${period})`
  );
  console.log(`vault PDA=${vault.toBase58()}`);
  console.log(
    `settle predicate: threshold=${YES_THRESHOLD} GreaterThan (YES/OVER wins if total > ${YES_THRESHOLD})`
  );

  const mockUsdcMint = await runStep("STEP 0 — create mock USDC mint", async () => {
    const mint = await createMint(
      connection,
      deployer,
      deployer.publicKey,
      deployer.publicKey,
      6,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    console.log(`mock USDC mint=${mint.toBase58()}`);
    return mint;
  });

  await runStep("STEP 0b — fund player USDC ATAs", async () => {
    const ataA = await getOrCreateAssociatedTokenAccount(
      connection,
      deployer,
      mockUsdcMint,
      playerA.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    const ataB = await getOrCreateAssociatedTokenAccount(
      connection,
      deployer,
      mockUsdcMint,
      playerB.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );
    const balA = Number((await getAccount(connection, ataA.address)).amount);
    const balB = Number((await getAccount(connection, ataB.address)).amount);
    if (balA < MINT_PER_PLAYER) {
      await mintTo(
        connection,
        deployer,
        mockUsdcMint,
        ataA.address,
        deployer,
        MINT_PER_PLAYER - balA
      );
    }
    if (balB < MINT_PER_PLAYER) {
      await mintTo(
        connection,
        deployer,
        mockUsdcMint,
        ataB.address,
        deployer,
        MINT_PER_PLAYER - balB
      );
    }
    console.log(`player ATAs funded (>= ${MINT_PER_PLAYER} raw units each)`);
  });

  await runStep("STEP 2 — create_market (two-stat Add, yes_threshold=2)", async () => {
    await fundSolFromDeployer(
      connection,
      deployer,
      marketAuthority.publicKey,
      MARKET_AUTHORITY_FUND_SOL
    );
    console.log(
      `marketAuthority funded to ${formatSol(await getSolBalance(connection, marketAuthority.publicKey))}`
    );

    const sig = await withRpcRetry("create_market", () =>
      program.methods
        .createMarket(
          new anchor.BN(FIXTURE_ID),
          period,
          STAT_KEY,
          STAT_KEY2,
          { add: {} },
          YES_THRESHOLD
        )
        .accounts({
          authority: marketAuthority.publicKey,
          usdcMint: mockUsdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([marketAuthority])
        .rpc()
    );
    console.log(`create_market tx=${sig}`);

    const m = await program.account.market.fetch(market);
    console.log(
      `market: fixtureId=${m.fixtureId} period=${m.period} statAKey=${m.statAKey} statBKey=${m.statBKey} op=${JSON.stringify(m.op)} yesThreshold=${m.yesThreshold}`
    );
    if (Number(m.statAKey) !== STAT_KEY) die(`stat_a_key expected ${STAT_KEY}`);
    if (Number(m.statBKey) !== STAT_KEY2) die(`stat_b_key expected ${STAT_KEY2}`);
    if (Number(m.yesThreshold) !== YES_THRESHOLD) die(`yes_threshold expected ${YES_THRESHOLD}`);
  });

  const playerAAta = await getOrCreateAssociatedTokenAccount(
    connection,
    deployer,
    mockUsdcMint,
    playerA.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );
  const playerBAta = await getOrCreateAssociatedTokenAccount(
    connection,
    deployer,
    mockUsdcMint,
    playerB.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );

  await runStep("STEP 3 — deposits (A YES 300, B NO 100)", async () => {
    await fundPositionRentFromDeployer(connection, deployer, playerA.publicKey);
    await fundPositionRentFromDeployer(connection, deployer, playerB.publicKey);

    const sigA = await program.methods
      .deposit(1, new anchor.BN(DEPOSIT_YES))
      .accounts({
        market,
        position: positionPda(market, playerA.publicKey),
        vault,
        userUsdc: playerAAta.address,
        user: playerA.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([playerA])
      .rpc();
    console.log(`deposit YES tx=${sigA} amount=${DEPOSIT_YES}`);

    const sigB = await program.methods
      .deposit(2, new anchor.BN(DEPOSIT_NO))
      .accounts({
        market,
        position: positionPda(market, playerB.publicKey),
        vault,
        userUsdc: playerBAta.address,
        user: playerB.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([playerB])
      .rpc();
    console.log(`deposit NO tx=${sigB} amount=${DEPOSIT_NO}`);

    const m = await program.account.market.fetch(market);
    console.log(`pool_yes=${m.poolYes} pool_no=${m.poolNo}`);
    if (Number(m.poolYes) !== DEPOSIT_YES) die(`pool_yes expected ${DEPOSIT_YES}, got ${m.poolYes}`);
    if (Number(m.poolNo) !== DEPOSIT_NO) die(`pool_no expected ${DEPOSIT_NO}, got ${m.poolNo}`);
  });

  await runStep("STEP 4 — settle_market (YES/OVER)", async () => {
    const sig = await withRpcRetry("settle_market", () =>
      program.methods
        .settleMarket(
          settleArgs.ts,
          settleArgs.fixtureSummary,
          settleArgs.fixtureProof,
          settleArgs.mainTreeProof,
          settleArgs.predicate,
          settleArgs.statA,
          settleArgs.statB,
          settleArgs.op,
          1 // claimed_outcome YES/OVER
        )
        .accounts({
          market,
          dailyScoresMerkleRoots: settleArgs.rootsPda,
          txlineProgram: TXLINE_PROGRAM_ID,
          keeper: deployer.publicKey,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        ])
        .rpc()
    );
    console.log(`settle_market tx=${sig}`);
    await printTxLogs(connection, sig, "settle_market");

    const m = await program.account.market.fetch(market);
    console.log(`winning_side=${m.winningSide}`);
    if (Number(m.winningSide) !== 1) die(`winning_side expected 1 (YES/OVER), got ${m.winningSide}`);
  });

  await runStep("STEP 5 — claim (winner A)", async () => {
    const balBefore = Number((await getAccount(connection, playerAAta.address)).amount);
    const vaultBefore = Number((await getAccount(connection, vault)).amount);
    const totalPool = DEPOSIT_YES + DEPOSIT_NO;

    const sig = await withRpcRetry("claim winner A", () =>
      program.methods
        .claim()
        .accounts({
          market,
          position: positionPda(market, playerA.publicKey),
          vault,
          userUsdc: playerAAta.address,
          user: playerA.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([playerA])
        .rpc()
    );
    console.log(`claim tx=${sig}`);

    const balAfter = Number((await getAccount(connection, playerAAta.address)).amount);
    const vaultAfter = Number((await getAccount(connection, vault)).amount);
    const gained = balAfter - balBefore;
    console.log(`playerA balance: ${balBefore} -> ${balAfter} (+${gained})`);
    console.log(`vault: ${vaultBefore} -> ${vaultAfter}`);

    if (gained !== totalPool) {
      die(`expected playerA to gain full pool ${totalPool}, gained ${gained}`);
    }
    if (vaultAfter !== 0) die(`expected vault drained to 0, got ${vaultAfter}`);
  });

  await runStep("STEP 5b — loser B claim must fail", async () => {
    try {
      await withRpcRetry("claim loser B", () =>
        program.methods
          .claim()
          .accounts({
            market,
            position: positionPda(market, playerB.publicKey),
            vault,
            userUsdc: playerBAta.address,
            user: playerB.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([playerB])
          .rpc()
      );
      die("player B claim succeeded but should have failed (wrong side)");
    } catch (e) {
      console.log(`player B claim rejected as expected: ${formatError(e)}`);
      if (e instanceof AnchorError && e.error.errorCode.number !== 6002) {
        die(`expected BadSide (6002), got ${e.error.errorCode.number}`);
      }
    }
  });

  console.log("\n========================================");
  console.log("TWO-STAT SMOKE PASS");
  console.log("========================================");
}

main().catch((e) => {
  console.error(formatError(e));
  process.exit(1);
});
