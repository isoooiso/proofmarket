import demoConfigJson from "./demo-config.json";

export interface DemoFixtureSpec {
  fixtureId: number;
  seq: number;
  statKeys: number[];
  op: string | null;
  yesThreshold: number;
  label: string;
}

export interface DemoConfig {
  programId: string;
  txlineProgramId: string;
  txlineApiBase: string;
  mockUsdcMint: string;
  mintDecimals: number;
  keeperPubkey: string;
  demoWalletA: string;
  demoWalletB: string;
  fixtures: {
    over: DemoFixtureSpec;
    under: DemoFixtureSpec;
  };
}

export const demoConfig = demoConfigJson as DemoConfig;

export const RPC_URL =
  import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";

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
