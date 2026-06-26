import { demoConfig } from "./demoConfig";

export type { DemoConfig, DemoFixtureSpec } from "./demoConfig";
export { demoConfig };

const DEFAULT_RPC_URL = "https://api.devnet.solana.com";

function resolveRpcUrl(): string {
  const env = import.meta.env.VITE_RPC_URL;
  if (typeof env === "string" && env.trim() !== "") {
    return env.trim();
  }
  return DEFAULT_RPC_URL;
}

export const RPC_URL = resolveRpcUrl();

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SYSVAR_RENT_PUBKEY = "SysvarRent111111111111111111111111111111111";

export const MARKET_AUTHORITY_STORAGE_KEY = "proofmarket-demo-market-authority";
export const SETTLE_TX_STORAGE_PREFIX = "proofmarket-demo-settle-tx:";

/** SOL sent to ephemeral market authority on reset (matches smoke_two_stat). */
export const DEMO_AUTHORITY_FUND_SOL = 0.05;

export const EXPLORER_TX = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const EXPLORER_ADDR = (addr: string) =>
  `https://explorer.solana.com/address/${addr}?cluster=devnet`;
