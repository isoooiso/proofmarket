import axios, { AxiosInstance } from "axios";
import { Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import "dotenv/config";

const API = process.env.TXLINE_API ?? "https://txline-dev.txodds.com/api";
const AUTH = process.env.TXLINE_AUTH ?? "https://txline-dev.txodds.com";

/** Raw shape returned by GET /api/scores/stat-validation (field names per the docs example). */
export interface StatValidationResponse {
  ts: number;
  statToProve: { key: number; value: number; period: number };
  eventStatRoot: HashLike;
  statProof: Array<{ hash: HashLike; isRightSibling: boolean }>;
  // optional second stat (two-stat validation)
  statToProve2?: { key: number; value: number; period: number };
  statProof2?: Array<{ hash: HashLike; isRightSibling: boolean }>;
  subTreeProof: Array<{ hash: HashLike; isRightSibling: boolean }>; // -> fixture_proof
  mainTreeProof: Array<{ hash: HashLike; isRightSibling: boolean }>;
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: HashLike; // -> events_sub_tree_root
  };
}

/** A 32-byte hash may arrive as hex, base64, or a byte array depending on the endpoint. */
export type HashLike = string | number[];

/** Convert a hash field into the number[] (length 32) that Anchor expects for [u8;32]. */
export function toBytes32(h: HashLike): number[] {
  if (Array.isArray(h)) return h;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(h)) {
    const hex = h.replace(/^0x/, "");
    return Array.from(Buffer.from(hex, "hex"));
  }
  // assume base64 otherwise
  const buf = Buffer.from(h, "base64");
  if (buf.length !== 32) {
    throw new Error(`Unexpected hash length ${buf.length}; adjust toBytes32 for the real response format`);
  }
  return Array.from(buf);
}

type ProofNode = { hash: number[]; isRightSibling: boolean };
const mapProof = (nodes: StatValidationResponse["subTreeProof"]): ProofNode[] =>
  nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));

/** Map a stat + its event root + proof into the Anchor `StatTerm` shape (camelCase). */
function mapStatTerm(
  stat: { key: number; value: number; period: number },
  eventStatRoot: HashLike,
  proof: StatValidationResponse["statProof"]
) {
  return {
    statToProve: { key: stat.key, value: stat.value, period: stat.period },
    eventStatRoot: toBytes32(eventStatRoot),
    statProof: mapProof(proof),
  };
}

/** Map the raw validation response into the exact arguments validate_stat expects. */
export function mapValidateStatArgs(v: StatValidationResponse) {
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
  const statA = mapStatTerm(v.statToProve, v.eventStatRoot, v.statProof);
  const statB =
    v.statToProve2 && v.statProof2
      ? mapStatTerm(v.statToProve2, v.eventStatRoot, v.statProof2)
      : null;
  return { ts: new anchor.BN(v.ts), fixtureSummary, fixtureProof, mainTreeProof, statA, statB };
}

export class TxlineClient {
  private constructor(private http: AxiosInstance) {}

  static async fromEnv(_wallet: Keypair): Promise<TxlineClient> {
    const apiToken = process.env.TXLINE_API_TOKEN;
    if (!apiToken) {
      throw new Error("TXLINE_API_TOKEN not set — run `npm run subscribe` first and paste the token into .env");
    }
    const http = axios.create({
      baseURL: API,
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    return new TxlineClient(http);
  }

  static async guestJwt(): Promise<string> {
    const res = await axios.post(`${AUTH}/auth/guest/start`);
    return res.data.token;
  }

  async getStatValidation(p: {
    fixtureId: number;
    seq: number;
    statKey: number;
    statKey2?: number;
  }): Promise<StatValidationResponse> {
    const res = await this.http.get("/scores/stat-validation", { params: p });
    return res.data as StatValidationResponse;
  }

  /** Generic GET for exploring other endpoints (fixtures, scores snapshots, etc.). */
  async get<T = unknown>(path: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.http.get(path, { params });
    return res.data as T;
  }
}
