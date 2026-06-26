import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

/**
 * Daily scores Merkle roots PDA — the account validate_stat checks against.
 * Seed: "daily_scores_roots" + epochDay as u16 LE.
 * epochDay = floor(ts_ms / 86_400_000).
 */
export function dailyScoresRootsPda(programId: PublicKey, epochDay: number): PublicKey {
  const epochDayLe = new Uint8Array(new Uint16Array([epochDay]).buffer); // 2 bytes LE
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), Buffer.from(epochDayLe)],
    programId
  );
  return pda;
}

export function pricingMatrixPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], programId);
  return pda;
}

export function tokenTreasuryPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], programId);
  return pda;
}

export function tokenTreasuryVault(programId: PublicKey, txlMint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    txlMint,
    tokenTreasuryPda(programId),
    true, // owner is a PDA
    TOKEN_2022_PROGRAM_ID
  );
}

export function userTxlAta(txlMint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(txlMint, owner, false, TOKEN_2022_PROGRAM_ID);
}
