import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

export interface WalletUsdcBalance {
  ata: PublicKey;
  rawBalance: number;
  ataExists: boolean;
}

export async function fetchWalletUsdcBalance(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey
): Promise<WalletUsdcBalance> {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
  try {
    const bal = await connection.getTokenAccountBalance(ata, "confirmed");
    return {
      ata,
      rawBalance: Number(bal?.value?.amount ?? 0),
      ataExists: true,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.debug("[USDC balance] getTokenAccountBalance failed", {
      ata: ata.toBase58(),
      owner: owner.toBase58(),
      mint: mint.toBase58(),
      error: msg,
    });
    try {
      const info = await connection.getAccountInfo(ata, "confirmed");
      return { ata, rawBalance: 0, ataExists: info !== null };
    } catch (inner) {
      console.debug("[USDC balance] getAccountInfo failed", {
        ata: ata.toBase58(),
        error: inner instanceof Error ? inner.message : String(inner),
      });
      return { ata, rawBalance: 0, ataExists: false };
    }
  }
}

export async function fetchMintAuthority(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey | null> {
  try {
    const mintInfo = await getMint(connection, mint, undefined, TOKEN_PROGRAM_ID);
    return mintInfo.mintAuthority;
  } catch (e) {
    console.debug("[USDC mint] getMint failed", {
      mint: mint.toBase58(),
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export const DEMO_MINT_USDC_RAW = 1_000_000_000; // 1000 USDC @ 6 decimals
