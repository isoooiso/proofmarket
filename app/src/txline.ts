import * as anchor from "@coral-xyz/anchor";
import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { dailyScoresRootsPda } from "./pdas";

/** Server-side proxy base — same path in dev (Vite middleware) and prod (Vercel function). */
const TXLINE_API_BASE = "/api/txline";

export type HashLike = string | number[];

export interface RawValidation {
  ts: number;
  statToProve: { key: number; value: number; period: number };
  statToProve2?: { key: number; value: number; period: number };
  eventStatRoot: HashLike;
  statProof: Array<{ hash: HashLike; isRightSibling: boolean }>;
  statProof2?: Array<{ hash: HashLike; isRightSibling: boolean }>;
  subTreeProof: Array<{ hash: HashLike; isRightSibling: boolean }>;
  mainTreeProof: Array<{ hash: HashLike; isRightSibling: boolean }>;
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: HashLike;
  };
}

export function toBytes32(h: HashLike): number[] {
  if (Array.isArray(h)) return h;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(h)) {
    return Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
  }
  const buf = Buffer.from(h, "base64");
  if (buf.length !== 32) {
    throw new Error(`unexpected hash length ${buf.length}`);
  }
  return Array.from(buf);
}

export const mapProof = (nodes: RawValidation["statProof"]) =>
  nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));

export function bytes32ToHex(bytes: number[]): string {
  return Buffer.from(bytes).toString("hex");
}

export async function fetchStatValidation(
  fixtureId: number,
  seq: number,
  statKey: number,
  statKey2?: number
): Promise<RawValidation> {
  const params: Record<string, number> = { fixtureId, seq, statKey };
  if (statKey2 != null) params.statKey2 = statKey2;

  const res = await axios.get(`${TXLINE_API_BASE}/scores/stat-validation`, {
    params,
    headers: { "Content-Type": "application/json" },
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    throw new Error(
      `stat-validation HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`
    );
  }
  return res.data as RawValidation;
}

function mapStatTerm(
  stat: { key: number; value: number; period: number },
  eventStatRoot: number[],
  proof: RawValidation["statProof"]
) {
  return {
    statToProve: { key: stat.key, value: stat.value, period: stat.period },
    eventStatRoot,
    statProof: mapProof(proof),
  };
}

export function mapValidationToSettleArgs(v: RawValidation, yesThreshold: number) {
  if (!v.statToProve2 || !v.statProof2) {
    throw new Error("stat-validation missing statToProve2 / statProof2");
  }

  const targetTs = Number(v.summary.updateStats.minTimestamp);
  if (!Number.isFinite(targetTs) || targetTs <= 0) {
    throw new Error(`invalid targetTs: ${targetTs}`);
  }

  const ts = new anchor.BN(targetTs);
  const fixtureSummary = {
    fixtureId: new anchor.BN(v.summary.fixtureId),
    updateStats: {
      updateCount: v.summary.updateStats.updateCount,
      minTimestamp: new anchor.BN(v.summary.updateStats.minTimestamp),
      maxTimestamp: new anchor.BN(v.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: toBytes32(v.summary.eventStatsSubTreeRoot),
  };
  const fixtureProof = mapProof(v.subTreeProof);
  const mainTreeProof = mapProof(v.mainTreeProof);
  const eventStatRoot = toBytes32(v.eventStatRoot);

  const statA = mapStatTerm(v.statToProve, eventStatRoot, v.statProof);
  const statB = mapStatTerm(v.statToProve2, eventStatRoot, v.statProof2);

  const predicate = {
    threshold: yesThreshold,
    comparison: { greaterThan: {} },
  };
  const op = { add: {} };
  const epochDay = Math.floor(targetTs / 86_400_000);
  const rootsPda = dailyScoresRootsPda(epochDay);

  return {
    ts,
    fixtureSummary,
    fixtureProof,
    mainTreeProof,
    predicate,
    statA,
    statB,
    op,
    targetTs,
    epochDay,
    rootsPda,
    raw: v,
  };
}

export interface ResolutionReceipt {
  fixtureId: number;
  home: number;
  away: number;
  total: number;
  yesThreshold: number;
  winningSide: number;
  rootsPda: PublicKey;
  settleTx: string;
  statProofLen: number;
  statProof2Len: number;
  mainTreeProofLen: number;
  eventStatRootHex: string;
}

export function buildReceipt(
  v: RawValidation,
  yesThreshold: number,
  winningSide: number,
  rootsPda: PublicKey,
  settleTx: string
): ResolutionReceipt {
  const home = v.statToProve.value;
  const away = v.statToProve2?.value ?? 0;
  return {
    fixtureId: v.summary.fixtureId,
    home,
    away,
    total: home + away,
    yesThreshold,
    winningSide,
    rootsPda,
    settleTx,
    statProofLen: v.statProof.length,
    statProof2Len: v.statProof2?.length ?? 0,
    mainTreeProofLen: v.mainTreeProof.length,
    eventStatRootHex: bytes32ToHex(toBytes32(v.eventStatRoot)),
  };
}
