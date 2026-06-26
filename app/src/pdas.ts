import { PublicKey } from "@solana/web3.js";
import { demoConfig } from "./config";

const PROGRAM_ID = new PublicKey(demoConfig.programId);
const TXLINE_PROGRAM_ID = new PublicKey(demoConfig.txlineProgramId);

export function i64Le(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(value));
  return buf;
}

export function i32Le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value);
  return buf;
}

export function marketPda(
  authority: PublicKey,
  fixtureId: number,
  yesThreshold: number
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      authority.toBuffer(),
      i64Le(fixtureId),
      i32Le(yesThreshold),
    ],
    PROGRAM_ID
  );
  return pda;
}

export function vaultPda(market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

export function positionPda(market: PublicKey, user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), user.toBuffer()],
    PROGRAM_ID
  );
  return pda;
}

export function dailyScoresRootsPda(epochDay: number): PublicKey {
  const le = Buffer.alloc(2);
  le.writeUInt16LE(epochDay, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), le],
    TXLINE_PROGRAM_ID
  );
  return pda;
}

export { PROGRAM_ID, TXLINE_PROGRAM_ID };
