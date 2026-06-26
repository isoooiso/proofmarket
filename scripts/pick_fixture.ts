/**
 * READ-ONLY World Cup fixture scanner for O/U 2.5 demo candidates.
 * No on-chain writes. Auth: TXLINE_JWT + TXLINE_API_TOKEN from .env.
 *
 *   npm run pick
 */
import axios from "axios";
import fs from "fs";
import path from "path";
import "dotenv/config";

const API = "https://txline-dev.txodds.com/api";
const JWT = process.env.TXLINE_JWT ?? "";
const API_TOKEN = process.env.TXLINE_API_TOKEN ?? "";
const COMPETITION_ID = 72;
const REFERENCE_FIXTURE_ID = 17588395;
const FIXTURE_DELAY_MS = 150;
const OUTPUT_PATH = path.join(process.cwd(), "demo-fixtures.json");

interface ScoreUpdate {
  Seq?: number;
  seq?: number;
  StatusId?: number;
  statusId?: number;
}

interface StatValidation {
  statToProve: { key: number; value: number; period: number };
  statToProve2?: { key: number; value: number; period: number };
}

interface FixtureRow {
  FixtureId?: number;
  fixtureId?: number;
  Participant1?: string;
  Participant2?: string;
  participant1?: string;
  participant2?: string;
  StartTime?: number | string;
  startTime?: number | string;
}

export interface DemoFixtureResult {
  fixtureId: number;
  teams: string;
  maxSeq: number;
  statusIds: number[];
  home: number;
  away: number;
  total: number;
  period: number;
  ou_result: "OVER" | "UNDER";
  maxStatusId: number | null;
}

function authHeaders(): Record<string, string> {
  if (!JWT) throw new Error("TXLINE_JWT missing in .env");
  if (!API_TOKEN) throw new Error("TXLINE_API_TOKEN missing in .env");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${JWT}`,
    "X-Api-Token": API_TOKEN,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asFixtureArray(body: unknown): FixtureRow[] {
  if (Array.isArray(body)) return body as FixtureRow[];
  if (body && typeof body === "object") {
    for (const key of ["data", "fixtures", "items", "results"]) {
      const arr = (body as Record<string, unknown>)[key];
      if (Array.isArray(arr)) return arr as FixtureRow[];
    }
  }
  return [];
}

function getFixtureId(row: FixtureRow): number | undefined {
  const n = Number(row.FixtureId ?? row.fixtureId);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function getTeams(row: FixtureRow): string {
  const p1 = row.Participant1 ?? row.participant1 ?? "Team1";
  const p2 = row.Participant2 ?? row.participant2 ?? "Team2";
  return `${p1} vs ${p2}`;
}

function asScoreArray(body: unknown): ScoreUpdate[] {
  if (Array.isArray(body)) return body as ScoreUpdate[];
  if (body && typeof body === "object") {
    for (const key of ["updates", "scores", "data"]) {
      const arr = (body as Record<string, unknown>)[key];
      if (Array.isArray(arr)) return arr as ScoreUpdate[];
    }
  }
  return [];
}

function collectScoreMeta(updates: ScoreUpdate[]): {
  maxSeq: number;
  statusIds: number[];
  maxStatusId: number | null;
} {
  let maxSeq = 0;
  const statusSet = new Set<number>();

  for (const u of updates) {
    const seq = Number(u.Seq ?? u.seq ?? 0);
    if (seq > maxSeq) maxSeq = seq;

    const status = u.StatusId ?? u.statusId;
    if (status != null && Number.isFinite(Number(status))) {
      statusSet.add(Number(status));
    }
  }

  const statusIds = [...statusSet].sort((a, b) => a - b);
  const maxStatusId = statusIds.length > 0 ? Math.max(...statusIds) : null;

  return { maxSeq, statusIds, maxStatusId };
}

async function fetchScoresSnapshot(fixtureId: number): Promise<ScoreUpdate[]> {
  const res = await axios.get(`${API}/scores/snapshot/${fixtureId}`, {
    headers: authHeaders(),
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    throw new Error(`scores/snapshot HTTP ${res.status}`);
  }
  return asScoreArray(res.data);
}

async function fetchStatValidation(
  fixtureId: number,
  seq: number
): Promise<StatValidation> {
  const res = await axios.get(`${API}/scores/stat-validation`, {
    params: { fixtureId, seq, statKey: 1, statKey2: 2 },
    headers: authHeaders(),
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    throw new Error(`stat-validation HTTP ${res.status}`);
  }
  const data = res.data as StatValidation;
  if (!data?.statToProve || !data?.statToProve2) {
    throw new Error("stat-validation missing two-stat payload");
  }
  return data;
}

async function fetchReferenceMaxStatusId(): Promise<number | null> {
  try {
    const updates = await fetchScoresSnapshot(REFERENCE_FIXTURE_ID);
    if (updates.length === 0) return null;
    return collectScoreMeta(updates).maxStatusId;
  } catch {
    return null;
  }
}

function ouResult(total: number): "OVER" | "UNDER" {
  return total > 2 ? "OVER" : "UNDER";
}

function formatStatusIds(ids: number[]): string {
  return ids.length > 0 ? ids.join(",") : "—";
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

async function main() {
  console.log("ProofMarket — WC fixture picker (O/U 2.5 demo candidates)");
  console.log(`competitionId=${COMPETITION_ID}  api=${API}`);
  console.log(
    "Note: GameState/fixture state are unreliable on devnet; using score snapshots only.\n"
  );

  const refMaxStatus = await fetchReferenceMaxStatusId();
  if (refMaxStatus != null) {
    console.log(
      `Reference fixture ${REFERENCE_FIXTURE_ID} max StatusId=${refMaxStatus} (prefer finished-match candidates with same max StatusId)\n`
    );
  }

  const fixturesRes = await axios.get(`${API}/fixtures/snapshot`, {
    params: { competitionId: COMPETITION_ID },
    headers: authHeaders(),
    validateStatus: () => true,
  });

  if (fixturesRes.status !== 200) {
    throw new Error(
      `fixtures/snapshot HTTP ${fixturesRes.status}: ${JSON.stringify(fixturesRes.data).slice(0, 300)}`
    );
  }

  const fixtures = asFixtureArray(fixturesRes.data);
  console.log(`fixtures in snapshot: ${fixtures.length}\n`);

  const results: DemoFixtureResult[] = [];

  for (let i = 0; i < fixtures.length; i++) {
    const row = fixtures[i];
    const fixtureId = getFixtureId(row);
    if (!fixtureId) {
      console.log(`[skip] row ${i}: no FixtureId`);
      continue;
    }

    const teams = getTeams(row);

    try {
      const updates = await fetchScoresSnapshot(fixtureId);
      if (updates.length === 0) {
        console.log(`[${fixtureId}] ${teams} — no data (empty scores snapshot)`);
        await sleep(FIXTURE_DELAY_MS);
        continue;
      }

      const { maxSeq, statusIds, maxStatusId } = collectScoreMeta(updates);
      if (maxSeq <= 0) {
        console.log(`[${fixtureId}] ${teams} — no data (no Seq values)`);
        await sleep(FIXTURE_DELAY_MS);
        continue;
      }

      const validation = await fetchStatValidation(fixtureId, maxSeq);
      const home = validation.statToProve.value;
      const away = validation.statToProve2!.value;
      const period = validation.statToProve.period;
      const total = home + away;
      const ou = ouResult(total);

      results.push({
        fixtureId,
        teams,
        maxSeq,
        statusIds,
        home,
        away,
        total,
        period,
        ou_result: ou,
        maxStatusId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("stat-validation")) {
        console.log(`[${fixtureId}] ${teams} — no proof (${msg})`);
      } else if (msg.includes("scores/snapshot")) {
        console.log(`[${fixtureId}] ${teams} — no data (${msg})`);
      } else {
        console.log(`[${fixtureId}] ${teams} — error (${msg})`);
      }
    }

    await sleep(FIXTURE_DELAY_MS);
  }

  results.sort((a, b) => b.total - a.total);

  console.log("\n--- Results (sorted by total desc) ---");
  console.log(
    `${pad("FixtureId", 12)} | ${pad("Teams", 28)} | ${pad("maxSeq", 6)} | ${pad("StatusIds", 14)} | ${pad("home-away", 9)} | ${pad("total", 5)} | ${pad("period", 6)} | O/U2.5`
  );
  console.log("-".repeat(110));

  for (const r of results) {
    const score = `${r.home}-${r.away}`;
    console.log(
      `${pad(String(r.fixtureId), 12)} | ${pad(r.teams, 28)} | ${pad(String(r.maxSeq), 6)} | ${pad(formatStatusIds(r.statusIds), 14)} | ${pad(score, 9)} | ${pad(String(r.total), 5)} | ${pad(String(r.period), 6)} | ${r.ou_result}`
    );
  }

  const overCandidates = results.filter((r) => r.total >= 3);
  const underCandidates = results.filter((r) => r.total >= 1 && r.total <= 2);

  const scoreFinished = (r: DemoFixtureResult): number => {
    if (refMaxStatus == null || r.maxStatusId == null) return 0;
    return r.maxStatusId === refMaxStatus ? 1 : 0;
  };

  const bestOver = [...overCandidates].sort((a, b) => {
    const sf = scoreFinished(b) - scoreFinished(a);
    if (sf !== 0) return sf;
    return b.total - a.total;
  })[0];

  const bestUnder = [...underCandidates].sort((a, b) => {
    const sf = scoreFinished(b) - scoreFinished(a);
    if (sf !== 0) return sf;
    return b.total - a.total;
  })[0];

  console.log("\n--- Picks ---");
  if (bestOver) {
    console.log(
      `BEST OVER (total>=3): fixtureId=${bestOver.fixtureId} seq=${bestOver.maxSeq} ` +
        `score=${bestOver.home}-${bestOver.away} total=${bestOver.total} period=${bestOver.period} ` +
        `maxStatusId=${bestOver.maxStatusId ?? "—"} StatusIds=[${formatStatusIds(bestOver.statusIds)}]`
    );
  } else {
    console.log("BEST OVER: none found (no fixture with total>=3 and valid proof)");
  }

  if (bestUnder) {
    console.log(
      `BEST UNDER (total 1..2): fixtureId=${bestUnder.fixtureId} seq=${bestUnder.maxSeq} ` +
        `score=${bestUnder.home}-${bestUnder.away} total=${bestUnder.total} period=${bestUnder.period} ` +
        `maxStatusId=${bestUnder.maxStatusId ?? "—"} StatusIds=[${formatStatusIds(bestUnder.statusIds)}]`
    );
  } else {
    console.log("BEST UNDER: none found (no fixture with total in 1..2 and valid proof)");
  }

  const jsonRows = results.map(({ maxStatusId: _m, ...rest }) => rest);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(jsonRows, null, 2));
  console.log(`\nSaved ${jsonRows.length} fixtures to ${OUTPUT_PATH}`);

  const pick = bestOver ?? bestUnder;
  if (pick) {
    console.log(
      `\nPICK: fixtureId=${pick.fixtureId} seq=${pick.maxSeq} O/U2.5 -> ${pick.ou_result} (${pick.home}-${pick.away})`
    );
  } else {
    console.log("\nPICK: no suitable fixture found in this competition snapshot");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
