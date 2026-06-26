import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export const DEMO_AUTHORITY_SECRET_KEY = "pm_demo_authority_secret";

export function loadDemoAuthority(): Keypair | null {
  const raw = localStorage.getItem(DEMO_AUTHORITY_SECRET_KEY);
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    localStorage.removeItem(DEMO_AUTHORITY_SECRET_KEY);
    return null;
  }
}

export function saveDemoAuthority(keypair: Keypair): void {
  localStorage.setItem(DEMO_AUTHORITY_SECRET_KEY, bs58.encode(keypair.secretKey));
}

export function clearDemoAuthority(): void {
  localStorage.removeItem(DEMO_AUTHORITY_SECRET_KEY);
}
