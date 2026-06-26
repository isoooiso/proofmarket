import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import React, { useMemo, type ReactNode } from "react";
import MarketPage from "./MarketPage";
import { RPC_URL } from "./config";

import "@solana/wallet-adapter-react-ui/styles.css";

/** Wallet adapter FC types can conflict with @types/react 18 — cast for JSX. */
const Conn = ConnectionProvider as React.ComponentType<{
  endpoint: string;
  children: ReactNode;
}>;
const Wallet = WalletProvider as React.ComponentType<{
  wallets: PhantomWalletAdapter[];
  autoConnect?: boolean;
  children: ReactNode;
}>;
const Modal = WalletModalProvider as React.ComponentType<{ children: ReactNode }>;

export default function App() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  const endpoint = RPC_URL;

  return (
    <Conn endpoint={endpoint}>
      <Wallet wallets={wallets} autoConnect>
        <Modal>
          <MarketPage />
        </Modal>
      </Wallet>
    </Conn>
  );
}
