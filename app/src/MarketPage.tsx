import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as anchor from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  demoConfig,
  DEMO_AUTHORITY_FUND_SOL,
  EXPLORER_ADDR,
  EXPLORER_TX,
  SETTLE_TX_STORAGE_PREFIX,
} from "./config";
import {
  loadDemoAuthority,
  saveDemoAuthority,
} from "./demoAuthority";
import {
  DEMO_MINT_USDC_RAW,
  fetchMintAuthority,
  fetchWalletUsdcBalance,
} from "./demoUsdc";
import {
  formatUserError,
  formatUsdc,
  getProgram,
  parseUsdcInput,
} from "./anchorUtils";
import { marketPda, positionPda, PROGRAM_ID, TXLINE_PROGRAM_ID, vaultPda } from "./pdas";
import {
  buildReceipt,
  fetchStatValidation,
  getProofStatSummary,
  getValidationStatTotal,
  isRawValidation,
  mapValidationToSettleArgs,
  type RawValidation,
  type ResolutionReceipt,
} from "./txline";
import {
  isAccountNotFoundError,
  isTimeoutError,
  safeRpc,
  withTimeout,
} from "./safeRpc";

const DEMO_SAFE_MODE =
  import.meta.env.VITE_DEMO_SAFE_MODE !== "false" &&
  import.meta.env.VITE_DEMO_SAFE_MODE !== "0";

const POSITION_FETCH_TIMEOUT_MS = 15000;
const MARKET_POLL_INTERVAL_MS = 10000;

/** Anchor client uses camelCase; hand-generated IDL types use snake_case. */
function pm(program: NonNullable<ReturnType<typeof getProgram>>) {
  return program as unknown as {
    account: {
      market: { fetch: (pk: PublicKey) => Promise<{
        authority: PublicKey;
        poolYes: anchor.BN;
        poolNo: anchor.BN;
        winningSide: number;
      }> };
      position: { fetch: (pk: PublicKey) => Promise<{ side: anchor.BN; amount: anchor.BN }> };
    };
    methods: {
      createMarket: (...args: unknown[]) => {
        accounts: (a: Record<string, unknown>) => {
          rpc: () => Promise<string>;
          instruction: () => Promise<import("@solana/web3.js").TransactionInstruction>;
        };
      };
      deposit: (...args: unknown[]) => {
        accounts: (a: Record<string, unknown>) => { rpc: () => Promise<string> };
      };
      settleMarket: (...args: unknown[]) => {
        accounts: (a: Record<string, unknown>) => { instruction: () => Promise<import("@solana/web3.js").TransactionInstruction> };
      };
      claim: () => {
        accounts: (a: Record<string, unknown>) => { rpc: () => Promise<string> };
      };
    };
  };
}

const fixture = demoConfig.fixtures.over;
const FIXTURE_ID = fixture.fixtureId;
const SEQ = fixture.seq;
const STAT_A = fixture.statKeys[0];
const STAT_B = fixture.statKeys[1];
const YES_THRESHOLD = fixture.yesThreshold;
const MARKET_PERIOD = fixture.period;

type PositionStatus =
  | "found"
  | "none"
  | "decode-error"
  | "timeout"
  | "rate-limited"
  | "no-wallet"
  | "loading";

const POLL_AFTER_CREATE_DELAYS_MS = DEMO_SAFE_MODE
  ? []
  : [500, 1000, 1500, 500, 1000, 1500, 500, 1000, 1500, 500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MarketState {
  poolYes: number;
  poolNo: number;
  winningSide: number;
  authority: string;
}

interface CreatedMarketSession {
  marketPk: string;
  createTxSig: string;
  authority: string;
}

interface PositionState {
  side: number;
  amount: number;
}

function defaultOpenMarketState(authority: string): MarketState {
  return { poolYes: 0, poolNo: 0, winningSide: 0, authority };
}

interface DisplaySnapshot {
  marketExists: boolean;
  marketState: MarketState | null;
  position: PositionState | null;
  usdcBalance: number;
  usdcAtaExists: boolean;
  receipt: ResolutionReceipt | null;
}

export default function MarketPage() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [txPending, setTxPending] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [proofPreview, setProofPreview] = useState<RawValidation | null>(null);

  const [authorityKeypair, setAuthorityKeypair] = useState<Keypair | null>(() =>
    loadDemoAuthority()
  );
  const [authoritySol, setAuthoritySol] = useState<number | null>(null);

  const [marketExists, setMarketExists] = useState(false);
  const [marketState, setMarketState] = useState<MarketState | null>(null);
  const [position, setPosition] = useState<PositionState | null>(null);
  const [usdcBalance, setUsdcBalance] = useState(0);
  const [usdcAtaExists, setUsdcAtaExists] = useState(false);
  const [isLoadingUsdc, setIsLoadingUsdc] = useState(false);
  const [mintAuthorityPk, setMintAuthorityPk] = useState<PublicKey | null>(null);
  const [receipt, setReceipt] = useState<ResolutionReceipt | null>(null);

  const [isLoadingMarket, setIsLoadingMarket] = useState(false);
  const [isLoadingPools, setIsLoadingPools] = useState(false);
  const [isLoadingPosition, setIsLoadingPosition] = useState(false);
  const [isLoadingReceipt, setIsLoadingReceipt] = useState(false);
  const [readyFreshMarket, setReadyFreshMarket] = useState(false);
  const [marketAwaitingRpc, setMarketAwaitingRpc] = useState(false);
  const [createdMarketSession, setCreatedMarketSession] = useState<CreatedMarketSession | null>(
    null
  );
  const [marketDecodePending, setMarketDecodePending] = useState(false);

  const [lastAuthorityChangeReason, setLastAuthorityChangeReason] = useState<string | null>(null);
  const [lastWalletChange, setLastWalletChange] = useState<string | null>(null);
  const [lastMarketRefreshReason, setLastMarketRefreshReason] = useState<string | null>(null);
  const [lastTraderRefreshReason, setLastTraderRefreshReason] = useState<string | null>(null);
  const [lastRpcError, setLastRpcError] = useState<string | null>(null);
  const [lastRefreshReason, setLastRefreshReason] = useState<string | null>(null);
  const [positionStatus, setPositionStatus] = useState<PositionStatus>("no-wallet");
  const [usdcWarning, setUsdcWarning] = useState<string | null>(null);
  const [authorityBalanceWarning, setAuthorityBalanceWarning] = useState<string | null>(null);
  const [positionWarning, setPositionWarning] = useState<string | null>(null);
  const [usdcLoadedOnce, setUsdcLoadedOnce] = useState(false);

  const [marketRefreshInFlight, setMarketRefreshInFlight] = useState(false);
  const [positionRefreshInFlight, setPositionRefreshInFlight] = useState(false);
  const [usdcRefreshInFlight, setUsdcRefreshInFlight] = useState(false);
  const [authorityBalanceRefreshInFlight, setAuthorityBalanceRefreshInFlight] = useState(false);

  const [frozenSnapshot, setFrozenSnapshot] = useState<DisplaySnapshot | null>(null);

  const [depositSide, setDepositSide] = useState<1 | 2>(1);
  const [depositAmount, setDepositAmount] = useState("100");

  const marketLoadSeqRef = useRef(0);
  const traderLoadSeqRef = useRef(0);
  const receiptLoadSeqRef = useRef(0);
  const usdcLoadSeqRef = useRef(0);
  const programRef = useRef<ReturnType<typeof getProgram> | null>(null);
  const prevWalletPkRef = useRef<string | null>(null);
  const walletInitializedRef = useRef(false);
  const marketInitFetchedForPkRef = useRef<string | null>(null);
  const marketRefreshInFlightRef = useRef(false);
  const positionRefreshInFlightRef = useRef(false);
  const usdcRefreshInFlightRef = useRef(false);
  const authorityBalanceRefreshInFlightRef = useRef(false);
  const refreshMarketStateRef = useRef<(reason: string) => Promise<void>>(async () => {});
  const refreshUsdcBalanceRef = useRef<(reason: string) => Promise<void>>(async () => {});
  const refreshPositionRef = useRef<(reason: string) => Promise<void>>(async () => {});
  const refreshAuthoritySolRef = useRef<(reason: string) => Promise<void>>(async () => {});
  const marketExistsRef = useRef(marketExists);
  const createdMarketSessionRef = useRef(createdMarketSession);
  marketExistsRef.current = marketExists;
  createdMarketSessionRef.current = createdMarketSession;

  const mint = useMemo(() => new PublicKey(demoConfig.mockUsdcMint), []);

  const marketAuthority = useMemo(
    () => authorityKeypair?.publicKey ?? null,
    [authorityKeypair]
  );

  const marketPk = useMemo(() => {
    if (!marketAuthority) return null;
    return marketPda(marketAuthority, FIXTURE_ID, YES_THRESHOLD);
  }, [marketAuthority]);

  const activeMarketPk = useMemo(() => {
    if (createdMarketSession?.marketPk) {
      try {
        return new PublicKey(createdMarketSession.marketPk);
      } catch {
        /* fall through */
      }
    }
    return marketPk;
  }, [createdMarketSession, marketPk]);

  const activeVaultPk = useMemo(
    () => (activeMarketPk ? vaultPda(activeMarketPk) : null),
    [activeMarketPk]
  );

  const walletPublicKey = wallet.publicKey;
  const signTransaction = wallet.signTransaction;
  const signAllTransactions = wallet.signAllTransactions;

  const anchorWallet = useMemo(() => {
    if (!walletPublicKey || !signTransaction || !signAllTransactions) {
      return null;
    }
    return {
      publicKey: walletPublicKey,
      signTransaction,
      signAllTransactions,
    };
  }, [walletPublicKey, signTransaction, signAllTransactions]);

  const program = useMemo(() => {
    if (!anchorWallet) return null;
    return getProgram(connection, anchorWallet);
  }, [connection, anchorWallet]);

  programRef.current = program;

  const programReady = Boolean(program);

  const display = frozenSnapshot ?? {
    marketExists,
    marketState,
    position,
    usdcBalance,
    usdcAtaExists,
    receipt,
  };

  const displayMarketResolved =
    display.marketState != null && display.marketState.winningSide !== 0;
  const displayMarketOpen =
    display.marketState?.winningSide === 0 ||
    (createdMarketSession != null && !displayMarketResolved);

  const refreshAuthoritySol = useCallback(async (reason: string) => {
    if (authorityBalanceRefreshInFlightRef.current) return;
    if (!marketAuthority) {
      setAuthoritySol(null);
      return;
    }

    authorityBalanceRefreshInFlightRef.current = true;
    setAuthorityBalanceRefreshInFlight(true);
    setLastRefreshReason(`authority: ${reason}`);

    try {
      const result = await safeRpc(
        `getBalance authority ${marketAuthority.toBase58()}`,
        () => connection.getBalance(marketAuthority)
      );
      if (!result.ok) {
        setLastRpcError(result.error);
        if (result.rateLimited) {
          setAuthorityBalanceWarning("Authority balance not refreshed — RPC rate limited");
        }
        return;
      }
      setAuthorityBalanceWarning(null);
      setAuthoritySol(result.value);
    } finally {
      authorityBalanceRefreshInFlightRef.current = false;
      setAuthorityBalanceRefreshInFlight(false);
    }
  }, [connection, marketAuthority]);

  refreshAuthoritySolRef.current = refreshAuthoritySol;

  const refreshUsdcBalance = useCallback(
    async (reason: string) => {
      if (usdcRefreshInFlightRef.current) return;

      if (!wallet.publicKey) {
        setUsdcBalance(0);
        setUsdcAtaExists(false);
        setIsLoadingUsdc(false);
        setUsdcLoadedOnce(false);
        setUsdcWarning(null);
        return;
      }

      usdcRefreshInFlightRef.current = true;
      setUsdcRefreshInFlight(true);
      setLastTraderRefreshReason(reason);
      setLastRefreshReason(`usdc: ${reason}`);
      const requestId = ++usdcLoadSeqRef.current;
      setIsLoadingUsdc(true);

      try {
        const result = await safeRpc(
          `usdc balance ${wallet.publicKey.toBase58()}`,
          () => fetchWalletUsdcBalance(connection, mint, wallet.publicKey!)
        );
        if (requestId !== usdcLoadSeqRef.current) return;

        if (!result.ok) {
          setLastRpcError(result.error);
          if (result.rateLimited) {
            setUsdcWarning("USDC balance not refreshed — RPC rate limited");
          }
          return;
        }

        const balance = result.value;
        setUsdcWarning(null);
        setUsdcBalance(balance?.rawBalance ?? 0);
        setUsdcAtaExists(balance?.ataExists ?? false);
        setUsdcLoadedOnce(true);
      } finally {
        if (requestId === usdcLoadSeqRef.current) {
          setIsLoadingUsdc(false);
          usdcRefreshInFlightRef.current = false;
          setUsdcRefreshInFlight(false);
        }
      }
    },
    [connection, mint, walletPublicKey]
  );

  refreshUsdcBalanceRef.current = refreshUsdcBalance;

  const refreshPositionForWallet = useCallback(
    async (reason: string) => {
      if (positionRefreshInFlightRef.current) return;

      if (!wallet.publicKey || !activeMarketPk) {
        setPosition(null);
        setIsLoadingPosition(false);
        setPositionStatus("no-wallet");
        setPositionWarning(null);
        return;
      }

      const prog = programRef.current;
      if (!prog) {
        setIsLoadingPosition(false);
        return;
      }

      positionRefreshInFlightRef.current = true;
      setPositionRefreshInFlight(true);
      setLastTraderRefreshReason(reason);
      setLastRefreshReason(`position: ${reason}`);
      const requestId = ++traderLoadSeqRef.current;
      setIsLoadingPosition(true);
      setPositionStatus("loading");
      setPositionWarning(null);

      try {
        const posPk = positionPda(activeMarketPk, wallet.publicKey);
        const result = await safeRpc(`position ${posPk.toBase58()}`, () =>
          withTimeout(
            pm(prog).account.position.fetch(posPk),
            POSITION_FETCH_TIMEOUT_MS,
            "position fetch"
          )
        );
        if (requestId !== traderLoadSeqRef.current) return;

        if (!result.ok) {
          setLastRpcError(result.error);
          if (result.rateLimited) {
            setPositionStatus("rate-limited");
            setPositionWarning("Position: not refreshed — RPC rate limited");
          } else if (isTimeoutError(result.error)) {
            setPositionStatus("timeout");
            setPositionWarning("Position: fetch timed out — use Force refresh position");
          } else if (isAccountNotFoundError(result.error)) {
            setPosition(null);
            setPositionStatus("none");
          } else {
            setPositionStatus("decode-error");
            setPositionWarning("Position: decode error — use Force refresh position");
          }
          return;
        }

        const fetched = result.value;
        if (!fetched?.side || !fetched?.amount) {
          setPositionStatus("decode-error");
          setPositionWarning("Position: decode error — use Force refresh position");
          return;
        }

        setPosition({
          side: Number(fetched.side),
          amount: Number(fetched.amount),
        });
        setPositionStatus("found");
        setPositionWarning(null);
      } finally {
        if (requestId === traderLoadSeqRef.current) {
          setIsLoadingPosition(false);
          positionRefreshInFlightRef.current = false;
          setPositionRefreshInFlight(false);
        }
      }
    },
    [walletPublicKey, activeMarketPk]
  );

  refreshPositionRef.current = refreshPositionForWallet;

  const isMintAuthority =
    wallet.publicKey != null &&
    mintAuthorityPk != null &&
    wallet.publicKey.equals(mintAuthorityPk);

  const buildReceiptFromMarket = useCallback(
    (winningSide: number, marketPkForReceipt: PublicKey) => {
      if (!proofPreview || !isRawValidation(proofPreview)) return null;
      try {
        const args = mapValidationToSettleArgs(proofPreview, YES_THRESHOLD);
        const storedTx = localStorage.getItem(
          SETTLE_TX_STORAGE_PREFIX + marketPkForReceipt.toBase58()
        );
        return buildReceipt(
          proofPreview,
          YES_THRESHOLD,
          winningSide,
          args.rootsPda,
          storedTx ?? ""
        );
      } catch {
        return null;
      }
    },
    [proofPreview]
  );

  const applyMarketAccount = useCallback(
    (requestId: number, targetMarketPk: PublicKey, m: {
      authority: PublicKey;
      poolYes: anchor.BN;
      poolNo: anchor.BN;
      winningSide: number;
    }) => {
      if (requestId !== marketLoadSeqRef.current) return false;

      if (marketAuthority && !m.authority.equals(marketAuthority)) {
        console.warn("on-chain market authority does not match ephemeral authority");
      }

      const nextMarket: MarketState = {
        poolYes: Number(m.poolYes),
        poolNo: Number(m.poolNo),
        winningSide: Number(m.winningSide),
        authority: m.authority.toBase58(),
      };

      setMarketExists((prev) => (prev ? prev : true));
      setMarketState((prev) => {
        if (
          prev &&
          prev.poolYes === nextMarket.poolYes &&
          prev.poolNo === nextMarket.poolNo &&
          prev.winningSide === nextMarket.winningSide &&
          prev.authority === nextMarket.authority
        ) {
          return prev;
        }
        return nextMarket;
      });
      setIsLoadingMarket(false);
      setIsLoadingPools(false);
      setReadyFreshMarket((prev) => (prev ? false : prev));
      setMarketAwaitingRpc((prev) => (prev ? false : prev));
      setMarketDecodePending((prev) => (prev ? false : prev));
      setReceipt((prev) => (prev === null ? prev : null));
      setIsLoadingReceipt((prev) => (prev ? false : prev));

      console.debug("[Market refresh] account applied", {
        marketPk: targetMarketPk.toBase58(),
        poolYes: nextMarket.poolYes,
        poolNo: nextMarket.poolNo,
        winningSide: nextMarket.winningSide,
      });
      return true;
    },
    [marketAuthority]
  );

  const fetchMarketOnce = useCallback(
    async (
      targetMarketPk: PublicKey,
      reason: string
    ): Promise<boolean> => {
      if (marketRefreshInFlightRef.current) {
        return marketExistsRef.current || createdMarketSessionRef.current != null;
      }

      const prog = programRef.current;
      if (!prog) {
        return marketExistsRef.current || createdMarketSessionRef.current != null;
      }

      const requestId = ++marketLoadSeqRef.current;
      marketRefreshInFlightRef.current = true;
      setMarketRefreshInFlight(true);
      setLastMarketRefreshReason(reason);
      setLastRefreshReason(`market: ${reason}`);
      setIsLoadingMarket(true);
      setIsLoadingPools(true);

      try {
        const infoResult = await safeRpc(
          `market account ${targetMarketPk.toBase58()}`,
          () => connection.getAccountInfo(targetMarketPk, "confirmed")
        );
        if (requestId !== marketLoadSeqRef.current) return false;

        if (!infoResult.ok) {
          setLastRpcError(infoResult.error);
          return marketExistsRef.current || createdMarketSessionRef.current != null;
        }

        const info = infoResult.value;
        if (!info) {
          return marketExistsRef.current || createdMarketSessionRef.current != null;
        }

        if (!info.owner.equals(PROGRAM_ID)) return false;

        const fetchResult = await safeRpc(`market fetch ${targetMarketPk.toBase58()}`, () =>
          pm(prog).account.market.fetch(targetMarketPk)
        );
        if (requestId !== marketLoadSeqRef.current) return false;

        if (fetchResult.ok) {
          applyMarketAccount(requestId, targetMarketPk, fetchResult.value);
          setMarketDecodePending(false);
          return true;
        }

        setLastRpcError(fetchResult.error);
        return marketExistsRef.current || createdMarketSessionRef.current != null;
      } finally {
        if (requestId === marketLoadSeqRef.current) {
          setIsLoadingMarket(false);
          setIsLoadingPools(false);
          marketRefreshInFlightRef.current = false;
          setMarketRefreshInFlight(false);
        }
      }
    },
    [connection, applyMarketAccount]
  );

  const confirmCreatedMarketOpen = useCallback(
    (
      targetMarketPk: PublicKey,
      sig: string,
      authorityPubkey: PublicKey,
      decodePending = false,
      nextMarket?: MarketState
    ) => {
      const authorityStr = authorityPubkey.toBase58();
      setCreatedMarketSession({
        marketPk: targetMarketPk.toBase58(),
        createTxSig: sig,
        authority: authorityStr,
      });
      setMarketExists(true);
      setMarketState(nextMarket ?? defaultOpenMarketState(authorityStr));
      setMarketDecodePending(decodePending);
      setMarketAwaitingRpc(false);
      setIsLoadingMarket(false);
      setIsLoadingPools(false);
      setReadyFreshMarket(false);
      setReceipt(null);
      setIsLoadingReceipt(false);

      console.debug("[Create market] confirmed open (deposit enabled)", {
        sig,
        marketPk: targetMarketPk.toBase58(),
        authority: authorityStr,
        decodePending,
      });
    },
    []
  );

  const pollMarketAfterCreate = useCallback(
    async (
      targetMarketPk: PublicKey,
      createSig: string,
      authorityPubkey: PublicKey
    ): Promise<boolean> => {
      if (DEMO_SAFE_MODE || POLL_AFTER_CREATE_DELAYS_MS.length === 0) {
        return fetchMarketOnce(targetMarketPk, createSig === "manual-refresh" ? "manual refresh" : "create confirmed");
      }

      if (!programRef.current) return false;

      const isManualRefresh = createSig === "manual-refresh";
      const pollId = ++marketLoadSeqRef.current;
      setMarketAwaitingRpc(false);

      console.debug("[Create market] start poll (non-safe mode)", {
        sig: createSig,
        marketPk: targetMarketPk.toBase58(),
      });

      for (let attempt = 0; attempt < POLL_AFTER_CREATE_DELAYS_MS.length; attempt++) {
        if (pollId !== marketLoadSeqRef.current) return false;
        await sleep(POLL_AFTER_CREATE_DELAYS_MS[attempt]);

        const found = await fetchMarketOnce(targetMarketPk, `poll attempt ${attempt + 1}`);
        if (found && marketExistsRef.current) return true;
      }

      if (!isManualRefresh) {
        confirmCreatedMarketOpen(targetMarketPk, createSig, authorityPubkey, true);
        return true;
      }

      setMarketAwaitingRpc(true);
      return false;
    },
    [fetchMarketOnce, confirmCreatedMarketOpen]
  );

  const refreshMarketState = useCallback(
    async (reason: string) => {
      const targetPk = activeMarketPk ?? marketPk;
      if (!targetPk) {
        setMarketExists(false);
        setMarketState(null);
        setReceipt(null);
        setMarketAwaitingRpc(false);
        setIsLoadingMarket(false);
        setIsLoadingPools(false);
        setIsLoadingReceipt(false);
        return;
      }
      await fetchMarketOnce(targetPk, reason);
    },
    [activeMarketPk, marketPk, fetchMarketOnce]
  );

  refreshMarketStateRef.current = refreshMarketState;

  const activeMarketPkStr = activeMarketPk?.toBase58() ?? null;
  const marketWinningSide = marketState?.winningSide ?? null;

  useEffect(() => {
    let cancelled = false;
    fetchMintAuthority(connection, mint).then((pk) => {
      if (cancelled || !pk) return;
      setMintAuthorityPk((prev) => (prev?.equals(pk) ? prev : pk));
    });
    return () => {
      cancelled = true;
    };
  }, [connection, mint]);

  useEffect(() => {
    const nextPk = walletPublicKey?.toBase58() ?? null;
    if (nextPk === prevWalletPkRef.current) return;

    prevWalletPkRef.current = nextPk;
    setLastWalletChange(nextPk ?? "disconnected");
    setUsdcLoadedOnce(false);

    if (!walletInitializedRef.current) {
      walletInitializedRef.current = true;
      if (!nextPk) return;
    }

    console.debug("wallet changed → refresh trader state only");
    refreshUsdcBalanceRef.current("wallet changed");
    refreshPositionRef.current("wallet changed");
  }, [walletPublicKey]);

  useEffect(() => {
    if (!marketPk) {
      ++marketLoadSeqRef.current;
      marketInitFetchedForPkRef.current = null;
      setMarketExists(false);
      setMarketState(null);
      setReceipt(null);
      setMarketAwaitingRpc(false);
      setCreatedMarketSession(null);
      setMarketDecodePending(false);
      setIsLoadingMarket(false);
      setIsLoadingPools(false);
      setIsLoadingReceipt(false);
    }
  }, [marketPk]);

  useEffect(() => {
    if (!marketPk || !programReady || readyFreshMarket) return;
    const pkStr = marketPk.toBase58();
    if (marketInitFetchedForPkRef.current === pkStr) return;
    marketInitFetchedForPkRef.current = pkStr;
    refreshMarketStateRef.current("initial market load");
  }, [marketPk, programReady, readyFreshMarket]);

  useEffect(() => {
    if (!activeMarketPkStr || readyFreshMarket || !programReady) return;
    const id = window.setInterval(() => {
      refreshMarketStateRef.current("interval poll (10s)");
    }, MARKET_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [activeMarketPkStr, readyFreshMarket, programReady]);

  useEffect(() => {
    if (
      !activeMarketPkStr ||
      marketWinningSide === null ||
      marketWinningSide === 0 ||
      !proofPreview
    ) {
      setReceipt((prev) => (prev === null ? prev : null));
      setIsLoadingReceipt((prev) => (prev ? false : prev));
      return;
    }

    const requestId = ++receiptLoadSeqRef.current;
    setIsLoadingReceipt((prev) => (prev ? prev : true));

    const marketPkForReceipt = new PublicKey(activeMarketPkStr);
    const built = buildReceiptFromMarket(marketWinningSide, marketPkForReceipt);
    if (requestId !== receiptLoadSeqRef.current) return;

    if (!built) {
      setReceipt((prev) => (prev === null ? prev : null));
      setIsLoadingReceipt(false);
      return;
    }

    setReceipt((prev) => {
      if (
        prev &&
        prev.winningSide === built.winningSide &&
        prev.settleTx === built.settleTx &&
        prev.rootsPda.equals(built.rootsPda)
      ) {
        return prev;
      }
      return built;
    });
    setIsLoadingReceipt(false);
  }, [activeMarketPkStr, marketWinningSide, proofPreview, buildReceiptFromMarket]);

  const poolOverDisplay =
    readyFreshMarket && !frozenSnapshot && !marketExists && !createdMarketSession
      ? "—"
      : isLoadingPools && !display.marketState
        ? "…"
        : display.marketState
          ? formatUsdc(display.marketState.poolYes)
          : "—";

  const poolNoDisplay =
    readyFreshMarket && !frozenSnapshot && !marketExists && !createdMarketSession
      ? "—"
      : isLoadingPools && !display.marketState
        ? "…"
        : display.marketState
          ? formatUsdc(display.marketState.poolNo)
          : "—";

  const positionDisplay = !wallet.publicKey
    ? null
    : isLoadingPosition
      ? "loading…"
      : display.position
        ? `side ${display.position.side} (${display.position.side === 1 ? "OVER" : "NO"}) · ${formatUsdc(display.position.amount)} USDC`
        : "none";

  const positionStatusLabel =
    positionWarning ??
    (positionStatus === "loading" ? "loading" : positionStatus);

  const marketStatus: "ready" | "not-created" | "open" | "resolved" = useMemo(() => {
    if (readyFreshMarket) return "ready";
    if (marketExists || createdMarketSession) {
      return displayMarketOpen ? "open" : "resolved";
    }
    return "not-created";
  }, [readyFreshMarket, marketExists, createdMarketSession, displayMarketOpen]);

  const userPositionPk =
    wallet.publicKey && activeMarketPk
      ? positionPda(activeMarketPk, wallet.publicKey)
      : null;

  const marketCheckComplete =
    !authorityKeypair || !program || marketExists || createdMarketSession != null || !isLoadingMarket;

  const hasActiveMarket = marketExists || createdMarketSession != null;

  const needsStartNewMarket =
    wallet.connected &&
    !!program &&
    marketCheckComplete &&
    !hasActiveMarket &&
    !displayMarketResolved;

  const showSecondaryReset =
    wallet.connected && (hasActiveMarket || !!authorityKeypair) && !needsStartNewMarket;

  const canStartNewMarket = needsStartNewMarket && !txPending;

  const startNewMarketDisabledReason = (() => {
    if (canStartNewMarket) return null;
    if (txPending) return "Confirming transaction…";
    if (!wallet.connected || !wallet.publicKey) return "Connect Phantom wallet first";
    if (!program) return "Wallet adapter not ready — reconnect Phantom";
    if (isLoadingMarket) return "Checking for an existing market on devnet…";
    if (hasActiveMarket) return "Market already active";
    return null;
  })();

  const statusLabel =
    needsStartNewMarket && !isLoadingMarket
      ? "Not started"
      : marketStatus === "ready"
        ? "Ready for market"
        : marketStatus === "not-created"
          ? isLoadingMarket
            ? "Checking market on devnet..."
            : "Not started"
          : marketStatus === "open"
            ? createdMarketSession && marketDecodePending
              ? "Open (confirmed)"
              : "Open"
            : display.marketState?.winningSide === 1
              ? "Resolved: OVER"
              : "Resolved: NO";

  async function ensureUserAta(): Promise<PublicKey> {
    if (!wallet.publicKey) throw new Error("Connect wallet");
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          ata,
          wallet.publicKey,
          mint
        )
      );
      await sendWalletTx(tx);
    }
    return ata;
  }

  function snapshotDisplay(): DisplaySnapshot {
    return {
      marketExists,
      marketState,
      position,
      usdcBalance,
      usdcAtaExists,
      receipt,
    };
  }

  interface RunActionOpts {
    refreshMarket?: boolean;
    refreshUsdc?: boolean;
    refreshPosition?: boolean;
    optimistic?: () => void;
  }

  async function runAction(
    label: string,
    fn: () => Promise<string>,
    opts: RunActionOpts = {}
  ) {
    const {
      refreshMarket = false,
      refreshUsdc = true,
      refreshPosition = false,
      optimistic,
    } = opts;

    setFrozenSnapshot(snapshotDisplay());
    setTxPending(true);
    setError(null);
    setStatusMsg(`${label}…`);
    try {
      const sig = await fn();
      if (optimistic) optimistic();
      setStatusMsg(`${label} confirmed: ${sig}`);
      if (refreshMarket) await refreshMarketState(`${label} confirmed`);
      if (refreshUsdc) await refreshUsdcBalance(`${label} confirmed`);
      if (refreshPosition) await refreshPositionForWallet(`${label} confirmed`);
      return sig;
    } catch (e) {
      setError(formatUserError(e));
      setStatusMsg(null);
      throw e;
    } finally {
      setTxPending(false);
      setFrozenSnapshot(null);
    }
  }

  async function sendWalletTx(tx: Transaction): Promise<string> {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Connect wallet");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = blockhash;
    const signed = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    return sig;
  }

  async function sendWalletTxWithExtraSigners(
    tx: Transaction,
    extraSigners: Keypair[]
  ): Promise<string> {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Connect wallet");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = blockhash;
    if (extraSigners.length > 0) {
      tx.partialSign(...extraSigners);
    }
    const signed = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    return sig;
  }

  async function ensureAuthorityFundedFor(authority: PublicKey): Promise<void> {
    const result = await safeRpc(
      `authority balance check ${authority.toBase58()}`,
      () => connection.getBalance(authority)
    );
    if (!result.ok) {
      if (result.rateLimited) {
        console.debug("authority balance check skipped — rate limited");
        return;
      }
      throw new Error(`Failed to check authority balance: ${result.error}`);
    }
    const minLamports = Math.floor(0.01 * LAMPORTS_PER_SOL);
    if (result.value < minLamports) {
      throw new Error(
        `Ephemeral authority has no SOL (${(result.value / LAMPORTS_PER_SOL).toFixed(4)} SOL). Click Start new market to fund it.`
      );
    }
  }

  function applyResetUiClear() {
    ++marketLoadSeqRef.current;
    ++traderLoadSeqRef.current;
    marketInitFetchedForPkRef.current = null;
    setMarketExists(false);
    setMarketState(null);
    setPosition(null);
    setReceipt(null);
    setIsLoadingMarket(false);
    setIsLoadingPools(false);
    setIsLoadingPosition(false);
    setIsLoadingReceipt(false);
    setReadyFreshMarket(true);
    setMarketAwaitingRpc(false);
    setCreatedMarketSession(null);
    setMarketDecodePending(false);
    setFrozenSnapshot(null);
    setPositionStatus("no-wallet");
    setPositionWarning(null);
    setUsdcWarning(null);
    setAuthorityBalanceWarning(null);
    setUsdcLoadedOnce(false);
    setLastRpcError(null);
  }

  function handleForceRefreshMarket() {
    if (!activeMarketPk) return;
    refreshMarketStateRef.current("force refresh market");
  }

  function handleForceRefreshBalances() {
    refreshUsdcBalanceRef.current("force refresh balances");
  }

  function handleForceRefreshPosition() {
    refreshPositionRef.current("force refresh position");
  }

  function handleForceRefreshAuthority() {
    refreshAuthoritySolRef.current("force refresh authority");
  }

  async function executeCreateMarket(
    authority: Keypair,
    targetMarketPk: PublicKey
  ): Promise<string> {
    const prog = programRef.current;
    if (!prog || !wallet.publicKey) throw new Error("Wallet not ready");
    await ensureAuthorityFundedFor(authority.publicKey);

    const createIx = await pm(prog).methods
      .createMarket(
        new anchor.BN(FIXTURE_ID),
        MARKET_PERIOD,
        STAT_A,
        STAT_B,
        { add: {} },
        YES_THRESHOLD
      )
      .accounts({
        authority: authority.publicKey,
        usdcMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(createIx);
    const sig = await sendWalletTxWithExtraSigners(tx, [authority]);

    console.debug("[Create market] tx confirmed", {
      sig,
      marketPk: targetMarketPk.toBase58(),
      authority: authority.publicKey.toBase58(),
    });

    setReadyFreshMarket(false);
    confirmCreatedMarketOpen(targetMarketPk, sig, authority.publicKey, false);

    if (DEMO_SAFE_MODE) {
      await fetchMarketOnce(targetMarketPk, "create confirmed");
    } else {
      await pollMarketAfterCreate(targetMarketPk, sig, authority.publicKey);
    }
    await refreshUsdcBalance("create market confirmed");
    await refreshPositionForWallet("create market confirmed");

    return sig;
  }

  async function handleStartNewMarket() {
    if (!wallet.publicKey || !program) {
      setError("Connect Phantom before starting a new market");
      return;
    }

    applyResetUiClear();
    setProofPreview(null);
    setTxPending(true);
    setError(null);
    setStatusMsg("Starting new market…");

    try {
      const kp = Keypair.generate();
      const targetMarketPk = marketPda(kp.publicKey, FIXTURE_ID, YES_THRESHOLD);
      saveDemoAuthority(kp);
      setAuthorityKeypair(kp);
      setLastAuthorityChangeReason("start new market");
      marketInitFetchedForPkRef.current = targetMarketPk.toBase58();
      console.debug("authority changed", {
        reason: "start new market",
        authority: kp.publicKey.toBase58(),
      });

      const fundLamports = Math.floor(DEMO_AUTHORITY_FUND_SOL * LAMPORTS_PER_SOL);
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: kp.publicKey,
          lamports: fundLamports,
        })
      );
      const fundSig = await sendWalletTx(fundTx);
      await refreshAuthoritySol("start new market funded");

      setStatusMsg("Creating market on devnet…");
      const createSig = await executeCreateMarket(kp, targetMarketPk);
      setStatusMsg(
        `Market ready — deposit OVER or NO (create tx: ${createSig}, fund tx: ${fundSig})`
      );
    } catch (e) {
      setError(formatUserError(e));
      setStatusMsg(null);
    } finally {
      setTxPending(false);
    }
  }

  async function handleRefreshMarket() {
    if (!activeMarketPk || !program) return;
    setTxPending(true);
    setError(null);
    setStatusMsg("Refreshing market…");
    try {
      const auth = authorityKeypair?.publicKey ?? marketAuthority;
      if (!auth) throw new Error("No market authority");
      const found = await pollMarketAfterCreate(activeMarketPk, "manual-refresh", auth);
      if (!found && createdMarketSession) {
        const pk = new PublicKey(createdMarketSession.marketPk);
        const authorityPubkey = new PublicKey(createdMarketSession.authority);
        confirmCreatedMarketOpen(
          pk,
          createdMarketSession.createTxSig,
          authorityPubkey,
          true
        );
        setStatusMsg("Using created market — deposits enabled");
      } else if (!found) {
        await refreshMarketState("manual refresh");
        setStatusMsg("Still waiting for RPC — try again in a moment");
      } else {
        setStatusMsg("Market loaded");
      }
    } catch (e) {
      setError(formatUserError(e));
      setStatusMsg(null);
    } finally {
      setTxPending(false);
    }
  }

  function handleUseCreatedMarket() {
    if (!createdMarketSession) return;
    const pk = new PublicKey(createdMarketSession.marketPk);
    const authorityPubkey = new PublicKey(createdMarketSession.authority);
    confirmCreatedMarketOpen(
      pk,
      createdMarketSession.createTxSig,
      authorityPubkey,
      true
    );
    setStatusMsg("Using created market — deposits enabled");
    setError(null);
  }

  async function handleDeposit() {
    if (!program || !wallet.publicKey || !activeMarketPk || !activeVaultPk) return;
    const raw = parseUsdcInput(depositAmount);
    const userAta = await ensureUserAta();
    const side = depositSide;

    await runAction(
      "Deposit",
      () =>
        pm(program).methods
          .deposit(side, new anchor.BN(raw))
          .accounts({
            market: activeMarketPk,
            position: positionPda(activeMarketPk, wallet.publicKey!),
            vault: activeVaultPk,
            userUsdc: userAta,
            user: wallet.publicKey!,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
      {
        refreshUsdc: true,
        refreshPosition: true,
        optimistic: () => {
          setMarketState((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              poolYes: side === 1 ? prev.poolYes + raw : prev.poolYes,
              poolNo: side === 2 ? prev.poolNo + raw : prev.poolNo,
            };
          });
          setPosition((prev) => {
            if (prev && prev.side === side) {
              return { side, amount: prev.amount + raw };
            }
            if (!prev) return { side, amount: raw };
            return prev;
          });
          setPositionStatus("found");
          setPositionWarning(null);
        },
      }
    );
  }

  async function handleSettle() {
    if (!program || !wallet.publicKey || !activeMarketPk) return;

    try {
      setStatusMsg("Loading TxLINE settlement proof…");
      const validation = await fetchStatValidation(FIXTURE_ID, SEQ, STAT_A, STAT_B);
      setProofPreview(validation);
      const args = mapValidationToSettleArgs(validation, YES_THRESHOLD);
      setStatusMsg(null);

      await runAction(
      "Settle market",
      async () => {
        const settleIx = await pm(program).methods
          .settleMarket(
            args.ts,
            args.fixtureSummary,
            args.fixtureProof,
            args.mainTreeProof,
            args.predicate,
            args.statA,
            args.statB,
            args.op,
            1
          )
          .accounts({
            market: activeMarketPk,
            dailyScoresMerkleRoots: args.rootsPda,
            txlineProgram: TXLINE_PROGRAM_ID,
            keeper: wallet.publicKey!,
          })
          .instruction();

        const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
        const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const messageV0 = new TransactionMessage({
          payerKey: wallet.publicKey!,
          recentBlockhash: blockhash,
          instructions: [cuLimit, cuPrice, settleIx],
        }).compileToV0Message();

        const vtx = new VersionedTransaction(messageV0);
        const signed = await wallet.signTransaction!(vtx);
        const raw = signed.serialize();

        if (raw.length > 1232) {
          throw new Error(
            `Transaction too large (${raw.length} bytes). Try a dedicated RPC or contact support.`
          );
        }

        const sig = await connection.sendRawTransaction(raw, { skipPreflight: false });
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed"
        );

        localStorage.setItem(SETTLE_TX_STORAGE_PREFIX + activeMarketPk.toBase58(), sig);
        return sig;
      },
      {
        refreshMarket: true,
        refreshUsdc: false,
        optimistic: () => {
          const total = getValidationStatTotal(validation);
          if (total == null) return;
          const winningSide = total > YES_THRESHOLD ? 1 : 2;
          setMarketState((prev) =>
            prev ? { ...prev, winningSide } : prev
          );
          try {
            const storedTx =
              localStorage.getItem(SETTLE_TX_STORAGE_PREFIX + activeMarketPk.toBase58()) ?? "";
            const built = buildReceipt(
              validation,
              YES_THRESHOLD,
              winningSide,
              args.rootsPda,
              storedTx
            );
            setReceipt(built);
          } catch {
            /* receipt builds after settle tx is stored */
          }
        },
      }
    );
    } catch (e) {
      setError(formatUserError(e));
      setStatusMsg(null);
    }
  }

  async function handleClaim() {
    if (!program || !wallet.publicKey || !activeMarketPk || !activeVaultPk) return;
    const userAta = await ensureUserAta();

    await runAction(
      "Claim",
      () =>
        pm(program).methods
          .claim()
          .accounts({
            market: activeMarketPk,
            position: positionPda(activeMarketPk, wallet.publicKey!),
            vault: activeVaultPk,
            userUsdc: userAta,
            user: wallet.publicKey!,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc(),
      {
        refreshUsdc: true,
        optimistic: () => {
          setPosition((prev) => (prev ? { ...prev, amount: 0 } : null));
          setPositionStatus("found");
        },
      }
    );
  }

  function tryDepositRaw(): number | null {
    try {
      return parseUsdcInput(depositAmount);
    } catch {
      return null;
    }
  }

  const depositRaw = tryDepositRaw();
  const displayUsdcBalance = display.usdcBalance;

  const depositInputs = {
    walletConnected: wallet.connected,
    walletPublicKey: Boolean(wallet.publicKey),
    program: Boolean(program),
    marketPk: Boolean(activeMarketPk),
    vaultPk: Boolean(activeVaultPk),
    marketStatus,
    marketOpen: displayMarketOpen,
    isLoadingUsdc,
    txPending,
    usdcAtaExists: display.usdcAtaExists,
    usdcBalance: displayUsdcBalance,
    depositRaw,
  };

  const canDeposit =
    depositInputs.walletConnected &&
    depositInputs.walletPublicKey &&
    depositInputs.program &&
    depositInputs.marketPk &&
    depositInputs.vaultPk &&
    depositInputs.marketStatus === "open" &&
    !depositInputs.txPending &&
    (!depositInputs.isLoadingUsdc || usdcLoadedOnce) &&
    depositInputs.depositRaw != null &&
    depositInputs.depositRaw > 0 &&
    depositInputs.usdcAtaExists &&
    depositInputs.usdcBalance >= depositInputs.depositRaw;

  const depositDisabledReason = (() => {
    if (canDeposit) return null;
    if (txPending) return "Transaction pending";
    if (!wallet.connected || !wallet.publicKey) return "Connect Phantom wallet";
    if (marketStatus !== "open") {
      if (marketStatus === "resolved") return "Market already resolved";
      if (marketStatus === "ready") return "Click Start new market first";
      if (needsStartNewMarket) return "Click Start new market first";
      return "Market not created yet";
    }
    if (isLoadingUsdc && !usdcLoadedOnce) return "Loading USDC balance";
    if (!usdcAtaExists) return "No token account yet — create one below";
    if (depositRaw == null || depositRaw <= 0) return "Amount must be greater than 0";
    if (displayUsdcBalance < (depositRaw ?? 0)) return "Insufficient mock-USDC";
    if (!program || !activeMarketPk || !activeVaultPk) return "Deposit unavailable";
    return "Deposit unavailable";
  })();

  const usdcDisplayLabel = !wallet.publicKey
    ? null
    : isLoadingUsdc && !frozenSnapshot && !usdcLoadedOnce
      ? "Loading USDC balance..."
      : display.usdcAtaExists
        ? formatUsdc(display.usdcBalance)
        : "No token account yet";

  async function handleCreateUsdcAta() {
    if (!wallet.publicKey) return;
    setTxPending(true);
    setError(null);
    setStatusMsg("Creating USDC token account…");
    try {
      await ensureUserAta();
      await refreshUsdcBalance("create usdc ata");
      setStatusMsg("USDC token account ready");
    } catch (e) {
      setError(formatUserError(e));
      setStatusMsg(null);
    } finally {
      setTxPending(false);
    }
  }

  async function handleMintDemoUsdc() {
    if (!wallet.publicKey || !isMintAuthority) return;
    setTxPending(true);
    setError(null);
    setStatusMsg("Minting demo USDC…");
    try {
      const ata = await ensureUserAta();
      const tx = new Transaction().add(
        createMintToInstruction(mint, ata, wallet.publicKey, DEMO_MINT_USDC_RAW)
      );
      const sig = await sendWalletTx(tx);
      await refreshUsdcBalance("mint demo usdc");
      setStatusMsg(`Minted 1000 demo USDC (${sig})`);
    } catch (e) {
      setError(formatUserError(e));
      setStatusMsg(null);
    } finally {
      setTxPending(false);
    }
  }

  const canClaim =
    !txPending &&
    !isLoadingPosition &&
    displayMarketResolved &&
    display.position &&
    display.position.side === display.marketState?.winningSide &&
    display.position.amount > 0;

  const claimDisabledReason = (() => {
    if (canClaim) return null;
    if (txPending) return "Transaction pending";
    if (!wallet.connected || !wallet.publicKey) return "Connect Phantom wallet";
    if (!displayMarketResolved) return "Market not resolved";
    if (isLoadingPosition) return "Checking position";
    if (positionStatus === "rate-limited") return "RPC rate limited";
    if (!display.position) return "No position for this wallet";
    if (
      display.position &&
      display.marketState &&
      display.position.side !== display.marketState.winningSide
    ) {
      return "This wallet is not on the winning side";
    }
    if (display.position && display.position.amount <= 0) return "Already claimed";
    if (!program || !activeMarketPk || !activeVaultPk) return "Claim unavailable";
    return "Claim unavailable";
  })();

  async function handleLoadProofPreview() {
    setError(null);
    setStatusMsg("Loading TxLINE proof preview…");
    try {
      const validation = await fetchStatValidation(FIXTURE_ID, SEQ, STAT_A, STAT_B);
      setProofPreview(validation);
      setStatusMsg("Proof preview loaded");
    } catch (e) {
      setError(formatUserError(e));
      setStatusMsg(null);
    }
  }

  const actionsDisabled = txPending;
  const proofStatSummary = getProofStatSummary(proofPreview);

  return (
    <div className="app">
      {txPending && (
        <div className="tx-overlay" aria-live="polite">
          <div className="tx-overlay-box">
            <span className="spinner" />
            Confirming transaction…
          </div>
        </div>
      )}

      <header className="header">
        <div>
          <h1>ProofMarket Demo</h1>
          <p className="sub">Devnet · O/U 2.5 · TxLINE Merkle settlement</p>
        </div>
        <WalletMultiButton />
      </header>

      <div className="card demo-reset-bar">
        {needsStartNewMarket ? (
          <>
            <h2 style={{ marginTop: 0 }}>Get started</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Click to create a fresh demo market — generates an ephemeral authority, funds it, and
              opens the O/U market on devnet.
            </p>
            <div className="row demo-reset-row">
              <button
                className="action"
                disabled={!canStartNewMarket}
                onClick={() => handleStartNewMarket()}
              >
                Start new market
              </button>
            </div>
            {startNewMarketDisabledReason && (
              <p className="muted demo-reset-hint">{startNewMarketDisabledReason}</p>
            )}
          </>
        ) : showSecondaryReset ? (
          <div className="row demo-reset-row">
            <button
              className="action secondary small"
              disabled={actionsDisabled}
              onClick={() => handleStartNewMarket()}
            >
              Reset / New market
            </button>
            <p className="muted demo-reset-hint">
              Start a fresh recording take with a new ephemeral authority and market.
            </p>
          </div>
        ) : null}
      </div>

      <div className="card market-card">
        <h2>{fixture.label}</h2>
        <p className="muted">
          O/U 2.5 · Turkey vs USA · TxLINE Merkle settlement
        </p>
        <p>
          Status:{" "}
          <span
            className={`status-badge ${
              readyFreshMarket
                ? "fresh"
                : displayMarketOpen
                  ? "open"
                  : displayMarketResolved
                    ? "resolved"
                    : ""
            }`}
          >
            {statusLabel}
          </span>
        </p>

        <div className="pools">
          <div className="pool over">
            <div className="pool-label">OVER pool (side 1)</div>
            <div className="pool-amount">{poolOverDisplay} USDC</div>
          </div>
          <div className="pool no">
            <div className="pool-label">NO pool (side 2)</div>
            <div className="pool-amount">{poolNoDisplay} USDC</div>
          </div>
        </div>

        {wallet.publicKey && (
          <p className="muted">
            Your USDC: {usdcDisplayLabel ?? "—"} · Position: {positionDisplay}
          </p>
        )}
      </div>

      <div className="card">
        <h2>Actions</h2>
        {needsStartNewMarket ? (
          <p className="muted" style={{ marginBottom: "0.75rem" }}>
            Connect Phantom and click <strong>Start new market</strong> above to open the market,
            then deposit OVER or NO.
          </p>
        ) : (
          <>
        <details className="collapsible">
          <summary>Demo funding</summary>
          <div className="collapsible-inner">
            <p className="muted" style={{ marginTop: 0 }}>
              Wallets are pre-funded for the demo. Use these only if you need extra mock USDC.
            </p>
            {wallet.connected && (
              <div className="row" style={{ marginBottom: "0.5rem" }}>
                {!usdcAtaExists && !isLoadingUsdc && (
                  <button
                    className="action secondary small"
                    disabled={actionsDisabled}
                    onClick={() => handleCreateUsdcAta()}
                  >
                    Create USDC token account
                  </button>
                )}
                {isMintAuthority && (
                  <button
                    className="action secondary small"
                    disabled={actionsDisabled}
                    onClick={() => handleMintDemoUsdc()}
                  >
                    Mint demo USDC to this wallet
                  </button>
                )}
              </div>
            )}
            {wallet.connected && !isMintAuthority && !isLoadingUsdc && usdcBalance === 0 && (
              <p className="muted">
                Fund via <code>npm run fund:demo-wallets</code> at the repo root, or switch to the
                mint authority wallet.
              </p>
            )}
          </div>
        </details>

        <div className="row" style={{ marginBottom: "0.75rem", marginTop: "0.75rem" }}>
          <div className="toggle">
            <button
              type="button"
              className={depositSide === 1 ? "active over" : ""}
              onClick={() => setDepositSide(1)}
              disabled={actionsDisabled}
            >
              OVER
            </button>
            <button
              type="button"
              className={depositSide === 2 ? "active no" : ""}
              onClick={() => setDepositSide(2)}
              disabled={actionsDisabled}
            >
              NO
            </button>
          </div>
          <input
            type="number"
            min="0"
            step="0.01"
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)}
            placeholder="USDC"
            disabled={actionsDisabled}
          />
          <button
            className="action"
            disabled={!canDeposit}
            onClick={() => handleDeposit()}
          >
            Deposit
          </button>
        </div>
        {depositDisabledReason && (
          <p className="muted" style={{ marginBottom: "0.75rem" }}>
            {depositDisabledReason}
          </p>
        )}

        <div className="row">
          <button
            className="action secondary"
            disabled={
              actionsDisabled ||
              !wallet.connected ||
              !(display.marketExists || createdMarketSession) ||
              !displayMarketOpen ||
              (isLoadingMarket && !marketExists && !createdMarketSession)
            }
            onClick={() => handleSettle()}
          >
            Settle market (keeper)
          </button>
          <button
            className="action"
            disabled={actionsDisabled || !wallet.connected || !canClaim}
            onClick={() => handleClaim()}
          >
            Claim winnings
          </button>
        </div>
        {claimDisabledReason && wallet.connected && displayMarketResolved && (
          <p className="muted" style={{ marginBottom: "0.75rem" }}>
            {claimDisabledReason}
          </p>
        )}
          </>
        )}

        {statusMsg && (
          <div className="msg ok">
            {statusMsg}
            {statusMsg.includes("confirmed:") && (
              <>
                {" "}
                <a
                  href={EXPLORER_TX(statusMsg.split("confirmed: ")[1] ?? "")}
                  target="_blank"
                  rel="noreferrer"
                >
                  explorer
                </a>
              </>
            )}
          </div>
        )}
        {error && <div className="msg error">{error}</div>}
      </div>

      {display.receipt && !isLoadingReceipt && (
        <div className="card">
          <h2>Verifiable Resolution Receipt</h2>
          <div className="receipt">
            <h3>On-chain settlement proof</h3>
            <dl>
              <dt>Fixture</dt>
              <dd>{display.receipt.fixtureId}</dd>
              <dt>Final score (home-away)</dt>
              <dd>
                {display.receipt.home}-{display.receipt.away} (total {display.receipt.total})
              </dd>
              <dt>O/U line</dt>
              <dd>
                {display.receipt.yesThreshold} (OVER wins if total &gt; {display.receipt.yesThreshold})
              </dd>
              <dt>Winning side</dt>
              <dd>{display.receipt.winningSide === 1 ? "OVER (YES)" : "NO"}</dd>
              <dt>daily_scores_roots PDA</dt>
              <dd>
                <a
                  href={EXPLORER_ADDR(display.receipt.rootsPda.toBase58())}
                  target="_blank"
                  rel="noreferrer"
                >
                  {display.receipt.rootsPda.toBase58()}
                </a>
              </dd>
              <dt>settle_market tx</dt>
              <dd>
                {display.receipt.settleTx ? (
                  <a href={EXPLORER_TX(display.receipt.settleTx)} target="_blank" rel="noreferrer">
                    {display.receipt.settleTx}
                  </a>
                ) : (
                  "— (settle in this browser to capture tx)"
                )}
              </dd>
              <dt>Proof lengths</dt>
              <dd>
                statProof={display.receipt.statProofLen}, statProof2={display.receipt.statProof2Len},
                mainTreeProof={display.receipt.mainTreeProofLen}
              </dd>
              <dt>eventStatRoot (hex)</dt>
              <dd>{display.receipt.eventStatRootHex}</dd>
            </dl>
            <p className="muted">
              Settlement was verified on-chain by TxLINE validate_stat (CPI), not by a trusted
              operator. Anyone can replay validate_stat against the on-chain Merkle root.
            </p>
          </div>
        </div>
      )}

      <details className="collapsible advanced-debug">
        <summary>Advanced / Debug</summary>
        <div className="collapsible-inner">
          <div className="row" style={{ marginBottom: "0.75rem" }}>
            <button
              className="action secondary small"
              disabled={actionsDisabled}
              onClick={() => handleForceRefreshMarket()}
            >
              Force refresh market
            </button>
            <button
              className="action secondary small"
              disabled={actionsDisabled || !wallet.connected}
              onClick={() => handleForceRefreshBalances()}
            >
              Force refresh balances
            </button>
            <button
              className="action secondary small"
              disabled={actionsDisabled || !wallet.connected}
              onClick={() => handleForceRefreshPosition()}
            >
              Force refresh position
            </button>
            <button
              className="action secondary small"
              disabled={actionsDisabled || !marketAuthority}
              onClick={() => handleForceRefreshAuthority()}
            >
              Force refresh authority
            </button>
            <button
              className="action secondary small"
              disabled={actionsDisabled}
              onClick={() => handleRefreshMarket()}
            >
              Refresh market
            </button>
            {createdMarketSession && (marketAwaitingRpc || marketDecodePending) && (
              <button
                className="action secondary small"
                disabled={actionsDisabled}
                onClick={() => handleUseCreatedMarket()}
              >
                Use created market
              </button>
            )}
          </div>

          {DEMO_SAFE_MODE && (
            <p className="muted">Demo safe mode: no RPC polling loops.</p>
          )}
          {authorityBalanceWarning && (
            <p className="muted">{authorityBalanceWarning}</p>
          )}
          {usdcWarning && <p className="muted">{usdcWarning}</p>}
          {positionWarning && <p className="muted">{positionWarning}</p>}
          {marketDecodePending && (
            <p className="muted">Market account exists, decode pending</p>
          )}

          {marketAuthority ? (
            <p className="muted">
              Ephemeral authority:{" "}
              <a href={EXPLORER_ADDR(marketAuthority.toBase58())} target="_blank" rel="noreferrer">
                {marketAuthority.toBase58()}
              </a>
              {authoritySol != null && (
                <> · {(authoritySol / LAMPORTS_PER_SOL).toFixed(4)} SOL</>
              )}
            </p>
          ) : (
            <p className="muted">No ephemeral authority yet — reset demo to start.</p>
          )}

          {activeMarketPk && (
            <p className="muted">
              Market PDA:{" "}
              <a href={EXPLORER_ADDR(activeMarketPk.toBase58())} target="_blank" rel="noreferrer">
                {activeMarketPk.toBase58()}
              </a>
            </p>
          )}

          {proofStatSummary ? (
            <p className="muted">
              Proof preview: {proofStatSummary.home}-{proofStatSummary.away} (total{" "}
              {proofStatSummary.home + proofStatSummary.away}) · period={proofStatSummary.period}
            </p>
          ) : (
            <p className="muted">
              Proof loads when you settle (or use Load proof preview below).
            </p>
          )}
          <div className="row" style={{ marginBottom: "0.75rem" }}>
            <button
              className="action secondary small"
              disabled={actionsDisabled}
              onClick={() => handleLoadProofPreview()}
            >
              Load proof preview
            </button>
          </div>

          <div className="debug-panel" style={{ marginTop: "1rem" }}>
            <h3>Debug state</h3>
            <div className="debug-grid">
              <div>
                <h3>Market state</h3>
                <dl>
                  <dt>marketPDA</dt>
                  <dd>{activeMarketPk?.toBase58() ?? "—"}</dd>
                  <dt>authority</dt>
                  <dd>{marketAuthority?.toBase58() ?? "—"}</dd>
                  <dt>marketStatus</dt>
                  <dd>{marketStatus}</dd>
                  <dt>poolYes</dt>
                  <dd>{display.marketState ? formatUsdc(display.marketState.poolYes) : "—"}</dd>
                  <dt>poolNo</dt>
                  <dd>{display.marketState ? formatUsdc(display.marketState.poolNo) : "—"}</dd>
                  <dt>isLoadingMarket</dt>
                  <dd>{isLoadingMarket}</dd>
                </dl>
              </div>
              <div>
                <h3>Trader state</h3>
                <dl>
                  <dt>wallet publicKey</dt>
                  <dd>{wallet.publicKey?.toBase58() ?? "—"}</dd>
                  <dt>userUSDC</dt>
                  <dd>{usdcDisplayLabel ?? "—"}</dd>
                  <dt>positionPDA</dt>
                  <dd>{userPositionPk?.toBase58() ?? "—"}</dd>
                  <dt>positionStatus</dt>
                  <dd>{positionStatusLabel}</dd>
                  <dt>isLoadingPosition</dt>
                  <dd>{isLoadingPosition}</dd>
                </dl>
              </div>
              <div>
                <h3>Events</h3>
                <dl>
                  <dt>lastAuthorityChangeReason</dt>
                  <dd>{lastAuthorityChangeReason ?? "—"}</dd>
                  <dt>lastWalletChange</dt>
                  <dd>{lastWalletChange ?? "—"}</dd>
                  <dt>lastMarketRefreshReason</dt>
                  <dd>{lastMarketRefreshReason ?? "—"}</dd>
                  <dt>lastTraderRefreshReason</dt>
                  <dd>{lastTraderRefreshReason ?? "—"}</dd>
                  <dt>lastRefreshReason</dt>
                  <dd>{lastRefreshReason ?? "—"}</dd>
                  <dt>lastRpcError</dt>
                  <dd>{lastRpcError ?? "—"}</dd>
                </dl>
              </div>
              <div>
                <h3>RPC guards</h3>
                <dl>
                  <dt>marketRefreshInFlight</dt>
                  <dd>{marketRefreshInFlight}</dd>
                  <dt>positionRefreshInFlight</dt>
                  <dd>{positionRefreshInFlight}</dd>
                  <dt>usdcRefreshInFlight</dt>
                  <dd>{usdcRefreshInFlight}</dd>
                  <dt>authorityBalanceRefreshInFlight</dt>
                  <dd>{authorityBalanceRefreshInFlight}</dd>
                  <dt>DEMO_SAFE_MODE</dt>
                  <dd>{DEMO_SAFE_MODE}</dd>
                </dl>
              </div>
            </div>
          </div>

          <p className="muted" style={{ marginTop: "1rem" }}>
            Mint: {demoConfig.mockUsdcMint} · Program: {demoConfig.programId}
          </p>
        </div>
      </details>
    </div>
  );
}
