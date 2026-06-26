import { AnchorError, AnchorProvider, Program } from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { IDL, type Proofmarket } from "./idl/proofmarket";
import { demoConfig } from "./config";

export function getProgram(
  connection: Connection,
  wallet: AnchorWallet
): Program<Proofmarket> {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return new Program(IDL, provider);
}

export function formatAnchorError(e: unknown): string {
  if (e instanceof AnchorError) {
    const logs = e.logs?.length ? `\n${e.logs.join("\n")}` : "";
    return `${e.error.errorCode.code} (${e.error.errorCode.number}): ${e.error.errorMessage}${logs}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** User-facing errors — no program logs, friendly mapping for common on-chain codes. */
export function formatUserError(e: unknown): string {
  if (e instanceof AnchorError) {
    const code = e.error.errorCode.code;
    if (code === "BadSide") {
      return "This wallet already has a position on the other side.";
    }
    if (code === "AlreadyClaimed") {
      return "This position was already claimed.";
    }
    return e.error.errorMessage || code;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function formatUsdc(raw: number | bigint, decimals = demoConfig.mintDecimals): string {
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function parseUsdcInput(input: string, decimals = demoConfig.mintDecimals): number {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Enter a positive USDC amount");
  return Math.round(n * 10 ** decimals);
}
