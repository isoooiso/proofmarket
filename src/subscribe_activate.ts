import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import axios from "axios";
import nacl from "tweetnacl";
import fs from "fs";
import "dotenv/config";

import {
  pricingMatrixPda,
  tokenTreasuryPda,
  tokenTreasuryVault,
  userTxlAta,
} from "./pdas";

const PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const TXL_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"); // devnet
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const AUTH = process.env.TXLINE_AUTH ?? "https://txline-dev.txodds.com";
const DURATION_WEEKS = Number(process.env.DURATION_WEEKS ?? 4); // must be a multiple of 4
const SELECTED_LEAGUES: number[] = []; // standard bundle

function loadWallet(): Keypair {
  const path = process.env.WALLET_KEYPAIR ?? "./devnet-wallet.json";
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

async function loadProgram(provider: anchor.AnchorProvider): Promise<anchor.Program> {
  let idl = await anchor.Program.fetchIdl(PROGRAM_ID, provider);
  if (!idl && fs.existsSync("idl/txoracle.json")) {
    idl = JSON.parse(fs.readFileSync("idl/txoracle.json", "utf8"));
  }
  if (!idl) {
    throw new Error("Could not load TxLINE IDL (fetchIdl null and idl/txoracle.json missing) — see idl/README.md");
  }
  return new anchor.Program(idl as anchor.Idl, provider);
}

interface Row {
  rowId: number;
  pricePerWeekToken: anchor.BN;
  samplingIntervalSec: number;
  leagueBundleId: number;
  marketBundleId: number;
}

/** Read the on-chain pricing matrix, print the rows, and pick a usable service level. */
async function pickServiceLevel(program: anchor.Program): Promise<number> {
  const pmPda = pricingMatrixPda(PROGRAM_ID);
  let pm: { rows: Row[] };
  try {
    pm = (await (program.account as any).pricingMatrix.fetch(pmPda)) as { rows: Row[] };
  } catch (e) {
    throw new Error(`Could not read PricingMatrix at ${pmPda.toBase58()} — is it initialized on devnet? ${e}`);
  }

  console.log("On-chain service levels (devnet):");
  for (const r of pm.rows) {
    const free = r.pricePerWeekToken.isZero() ? "  <- FREE" : "";
    console.log(
      `  row_id=${r.rowId}  price/week=${r.pricePerWeekToken.toString()}  ` +
        `sampling=${r.samplingIntervalSec}s  leagues=${r.leagueBundleId}  markets=${r.marketBundleId}${free}`
    );
  }

  const envLevel = process.env.SERVICE_LEVEL_ID ? Number(process.env.SERVICE_LEVEL_ID) : undefined;
  const envRow = pm.rows.find((r) => r.rowId === envLevel);
  if (envRow) {
    console.log(`Using SERVICE_LEVEL_ID=${envRow.rowId} from .env.`);
    return envRow.rowId;
  }
  if (envLevel !== undefined) {
    console.log(`SERVICE_LEVEL_ID=${envLevel} from .env is not on-chain — auto-selecting a free level.`);
  }

  const free = pm.rows
    .filter((r) => r.pricePerWeekToken.isZero())
    .sort((a, b) => a.samplingIntervalSec - b.samplingIntervalSec); // prefer most real-time
  if (free.length === 0) {
    throw new Error("No free (price 0) service level on devnet. We'd need devnet TxL — paste the rows above to me.");
  }
  console.log(`Auto-selected free service_level_id=${free[0].rowId} (sampling ${free[0].samplingIntervalSec}s).`);
  return free[0].rowId;
}

async function main() {
  const wallet = loadWallet();
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const program = await loadProgram(provider);

  console.log("wallet:", wallet.publicKey.toBase58());

  const serviceLevelId = await pickServiceLevel(program);

  // Ensure the user's TxL ATA exists (referenced by subscribe even on the free tier).
  const ata = userTxlAta(TXL_MINT, wallet.publicKey);
  const ataInfo = await connection.getAccountInfo(ata);
  const preIxs = ataInfo
    ? []
    : [
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          ata,
          wallet.publicKey,
          TXL_MINT,
          TOKEN_2022_PROGRAM_ID
        ),
      ];

  const txSig = await program.methods
    .subscribe(serviceLevelId, DURATION_WEEKS)
    .accounts({
      user: wallet.publicKey,
      pricingMatrix: pricingMatrixPda(PROGRAM_ID),
      tokenMint: TXL_MINT,
      userTokenAccount: ata,
      tokenTreasuryVault: tokenTreasuryVault(PROGRAM_ID, TXL_MINT),
      tokenTreasuryPda: tokenTreasuryPda(PROGRAM_ID),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions(preIxs)
    .rpc();

  console.log("subscribe tx:", txSig);

  // Activate the API token.
  const jwt = (await axios.post(`${AUTH}/auth/guest/start`)).data.token as string;
  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const signatureBytes = nacl.sign.detached(new TextEncoder().encode(messageString), wallet.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  const activation = await axios.post(
    `${AUTH}/api/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  const apiToken = (activation.data.token ?? activation.data) as string;

  console.log("\n=== Paste these into your .env ===");
  console.log(`TXLINE_JWT=${jwt}`);
  console.log(`TXLINE_API_TOKEN=${apiToken}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});