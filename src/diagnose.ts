import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";

type Json = any;

const DEV_BASE_URL = process.env.TXLINE_DEV_BASE_URL ?? "https://txline-dev.txodds.com";
const PROD_BASE_URL = process.env.TXLINE_PROD_BASE_URL ?? "https://txline.txodds.com";
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

const jwt = cleanEnv(process.env.TXLINE_JWT);
const apiToken = cleanEnv(process.env.TXLINE_API_TOKEN);
const txlineProgramIdRaw = cleanEnv(process.env.TXLINE_PROGRAM_ID);

const explicitFixtureId = optionalNumber(process.env.TXLINE_FIXTURE_ID);
const explicitSeq = optionalNumber(process.env.TXLINE_SEQ);
const explicitStatKey = optionalNumber(process.env.TXLINE_STAT_KEY);

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/^["']|["']$/g, "");
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optionalNumber(value: string | undefined): number | undefined {
  const cleaned = cleanEnv(value);
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function mask(value: string | undefined, visible = 12): string {
  if (!value) return "missing";
  if (value.length <= visible) return `${value.slice(0, 4)}...`;
  return `${value.slice(0, visible)}...`;
}

function truncate(value: string, max = 600): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}...`;
}

function u16le(n: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n, 0);
  return buf;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const realJwt = requireEnv("TXLINE_JWT", jwt);
  const realApiToken = requireEnv("TXLINE_API_TOKEN", apiToken);

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${realJwt}`,
    "X-Api-Token": realApiToken,
    ...extra,
  };
}

async function txGet(
  baseUrl: string,
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<{
  ok: boolean;
  status: number;
  url: string;
  text: string;
  body: Json | null;
}> {
  const url = new URL(path, baseUrl);

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url, {
    method: "GET",
    headers: authHeaders(),
  });

  const text = await res.text();

  let body: Json | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  return {
    ok: res.ok,
    status: res.status,
    url: url.toString(),
    text,
    body,
  };
}

function asArray(body: Json): any[] {
  if (Array.isArray(body)) return body;

  if (body && typeof body === "object") {
    for (const key of ["data", "fixtures", "items", "results", "updates", "scores"]) {
      if (Array.isArray(body[key])) return body[key];
    }
  }

  return [];
}

function getFixtureId(row: any): number | undefined {
  const candidates = [
    row?.FixtureId,
    row?.fixtureId,
    row?.fixture_id,
    row?.id,
    row?.Id,
  ];

  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return undefined;
}

function getFixtureLabel(row: any): string {
  const p1 =
    row?.Participant1 ??
    row?.participant1 ??
    row?.homeTeam ??
    row?.home_team ??
    row?.HomeTeam ??
    "Participant1";

  const p2 =
    row?.Participant2 ??
    row?.participant2 ??
    row?.awayTeam ??
    row?.away_team ??
    row?.AwayTeam ??
    "Participant2";

  const start =
    row?.StartTime ??
    row?.startTime ??
    row?.start_time ??
    row?.date ??
    row?.Date ??
    "";

  return `${p1} vs ${p2}${start ? ` @ ${start}` : ""}`;
}

function collectNumbersByKey(value: any, keyPattern: RegExp, limit = 30): number[] {
  const out: number[] = [];
  const seen = new WeakSet<object>();

  function walk(v: any, depth: number) {
    if (out.length >= limit || depth > 8 || v == null) return;

    if (Array.isArray(v)) {
      for (const item of v.slice(0, 100)) {
        walk(item, depth + 1);
      }
      return;
    }

    if (typeof v !== "object") return;

    if (seen.has(v)) return;
    seen.add(v);

    for (const [key, raw] of Object.entries(v)) {
      if (keyPattern.test(key)) {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) {
          out.push(n);
        }
      }

      if (raw && typeof raw === "object") {
        walk(raw, depth + 1);
      }
    }
  }

  walk(value, 0);

  return [...new Set(out)].slice(0, limit);
}

function describeBodyKeys(body: Json): string {
  if (!body || typeof body !== "object") return "(non-object body)";
  if (Array.isArray(body)) {
    if (body.length === 0) return "array[0]";
    const first = body[0];
    if (first && typeof first === "object") {
      return `array[${body.length}], first keys: ${Object.keys(first).slice(0, 30).join(", ")}`;
    }
    return `array[${body.length}]`;
  }
  return `object keys: ${Object.keys(body).slice(0, 40).join(", ")}`;
}

async function checkDevnetRoots(): Promise<void> {
  console.log("[1] DEVNET daily_scores_roots");

  if (!txlineProgramIdRaw) {
    console.log("  skipped: TXLINE_PROGRAM_ID is not set");
    console.log("  set TXLINE_PROGRAM_ID to the devnet TxLINE oracle program id");
    return;
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const programId = new PublicKey(txlineProgramIdRaw);
  const todayEpochDay = Math.floor(Date.now() / 86_400_000);

  let existsCount = 0;

  for (let i = 0; i < 6; i++) {
    const epochDay = todayEpochDay - i;

    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("daily_scores_roots"), u16le(epochDay)],
      programId,
    );

    const account = await connection.getAccountInfo(pda, "confirmed");

    if (account) {
      existsCount++;
      console.log(
        `  epochDay ${epochDay} (${i}d ago): ${pda.toBase58()} -> EXISTS, ${account.data.length} bytes`,
      );
    } else {
      console.log(
        `  epochDay ${epochDay} (${i}d ago): ${pda.toBase58()} -> missing`,
      );
    }
  }

  if (existsCount > 0) {
    console.log("  => devnet HAS score roots. validate_stat against devnet is feasible.");
  } else {
    console.log("  => no recent devnet score roots found. Check TXLINE_PROGRAM_ID/devnet.");
  }
}

async function checkAuthAndFixtures(): Promise<any[]> {
  console.log("[2] API auth sanity check");

  const wrongAuth = await fetch(`${DEV_BASE_URL}/api/fixtures/snapshot`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  console.log(
    `  wrong auth Bearer apiToken: HTTP ${wrongAuth.status} body: ${truncate(await wrongAuth.text(), 200) || "(empty)"}`,
  );

  const jwtOnly = await fetch(`${DEV_BASE_URL}/api/fixtures/snapshot`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  });

  console.log(
    `  jwt only: HTTP ${jwtOnly.status} body: ${truncate(await jwtOnly.text(), 200) || "(empty)"}`,
  );

  const correct = await txGet(DEV_BASE_URL, "/api/fixtures/snapshot");

  console.log(
    `  correct Bearer jwt + X-Api-Token: HTTP ${correct.status} body: ${truncate(correct.text, 300) || "(empty)"}`,
  );

  if (!correct.ok) {
    throw new Error(
      `Correct auth still failed. URL=${correct.url}, status=${correct.status}, body=${truncate(correct.text)}`,
    );
  }

  const fixtures = asArray(correct.body);
  console.log(`  fixtures parsed: ${fixtures.length}`);

  fixtures.slice(0, 5).forEach((fixture, i) => {
    console.log(
      `    ${i + 1}. fixtureId=${getFixtureId(fixture) ?? "unknown"} ${getFixtureLabel(fixture)}`,
    );
  });

  return fixtures;
}

async function fetchScoresForFixture(fixtureId: number): Promise<{
  endpoint: string;
  status: number;
  body: Json | null;
  text: string;
}> {
  const snapshot = await txGet(DEV_BASE_URL, `/api/scores/snapshot/${fixtureId}`);

  if (snapshot.ok && snapshot.text && snapshot.text !== "[]") {
    return {
      endpoint: snapshot.url,
      status: snapshot.status,
      body: snapshot.body,
      text: snapshot.text,
    };
  }

  const updates = await txGet(DEV_BASE_URL, `/api/scores/updates/${fixtureId}`);

  return {
    endpoint: updates.url,
    status: updates.status,
    body: updates.body,
    text: updates.text,
  };
}

async function findFixtureWithScores(fixtures: any[]): Promise<{
  fixtureId: number;
  scoresBody: Json | null;
  scoresText: string;
}> {
  if (explicitFixtureId) {
    const scores = await fetchScoresForFixture(explicitFixtureId);
    console.log(`[3] Scores for explicit fixture ${explicitFixtureId}`);
    console.log(`  endpoint: ${scores.endpoint}`);
    console.log(`  HTTP ${scores.status}`);
    console.log(`  shape: ${describeBodyKeys(scores.body)}`);
    console.log(`  body: ${truncate(scores.text, 500) || "(empty)"}`);

    if (!scores.body) {
      throw new Error(`Explicit fixture ${explicitFixtureId} returned no JSON scores body`);
    }

    return {
      fixtureId: explicitFixtureId,
      scoresBody: scores.body,
      scoresText: scores.text,
    };
  }

  console.log("[3] Finding fixture with scores");

  const candidateIds = fixtures
    .map(getFixtureId)
    .filter((x): x is number => typeof x === "number")
    .slice(0, 50);

  for (const fixtureId of candidateIds) {
    const scores = await fetchScoresForFixture(fixtureId);
    const arr = asArray(scores.body);

    console.log(
      `  probe fixtureId=${fixtureId}: HTTP ${scores.status}, ${describeBodyKeys(scores.body)}`,
    );

    if (scores.status >= 200 && scores.status < 300 && scores.body && (arr.length > 0 || scores.text.length > 20)) {
      console.log(`  => selected fixtureId=${fixtureId}`);
      return {
        fixtureId,
        scoresBody: scores.body,
        scoresText: scores.text,
      };
    }
  }

  throw new Error(
    "Could not auto-find a fixture with scores. Set TXLINE_FIXTURE_ID manually from fixtures/snapshot.",
  );
}

async function probeStatValidation(
  fixtureId: number,
  seqCandidates: number[],
  statKeyCandidates: number[],
): Promise<{
  fixtureId: number;
  seq: number;
  statKey: number;
  body: Json;
}> {
  console.log("[4] stat-validation probes");

  let lastError = "";

  for (const seq of seqCandidates) {
    for (const statKey of statKeyCandidates) {
      const res = await txGet(DEV_BASE_URL, "/api/scores/stat-validation", {
        fixtureId,
        seq,
        statKey,
      });

      console.log(
        `  fixtureId=${fixtureId} seq=${seq} statKey=${statKey}: HTTP ${res.status} ${truncate(res.text, 240) || "(empty)"}`,
      );

      if (res.ok && res.body) {
        console.log("  => stat-validation payload OK");
        console.log(`  payload shape: ${describeBodyKeys(res.body)}`);

        if (res.body.summary?.updateStats) {
          console.log(
            `  updateStats: ${JSON.stringify(res.body.summary.updateStats)}`,
          );
        }

        return {
          fixtureId,
          seq,
          statKey,
          body: res.body,
        };
      }

      lastError = `status=${res.status}, body=${truncate(res.text)}`;
    }
  }

  throw new Error(
    `No stat-validation candidate worked. Last error: ${lastError}. ` +
      `Set TXLINE_FIXTURE_ID, TXLINE_SEQ and TXLINE_STAT_KEY manually from a known score update.`,
  );
}

function buildSeqCandidates(scoresBody: Json): number[] {
  if (explicitSeq) return [explicitSeq];

  const seqs = collectNumbersByKey(
    scoresBody,
    /^(seq|sequence|sequenceNumber|scoreSeq|updateSeq|updateSequence)$/i,
    30,
  );

  return seqs;
}

function buildStatKeyCandidates(): number[] {
  if (explicitStatKey) return [explicitStatKey];

  // Claude found 1/2 for Participant1/Participant2 score.
  // TxLINE docs examples also show 1002/1003 in generic examples,
  // so we try both families for diagnosis.
  return [1, 2, 1002, 1003];
}

async function main() {
  console.log("ProofMarket / TxLINE diagnose");
  console.log(`token present: ${apiToken ? `yes (${mask(apiToken)})` : "no"}`);
  console.log(`jwt present:   ${jwt ? "yes" : "no"}`);
  console.log(`dev base:      ${DEV_BASE_URL}`);
  console.log(`prod base:     ${PROD_BASE_URL}`);
  console.log(`rpc:           ${RPC_URL}`);
  console.log(`program id:    ${txlineProgramIdRaw ? txlineProgramIdRaw : "missing"}`);
  console.log("");

  requireEnv("TXLINE_JWT", jwt);
  requireEnv("TXLINE_API_TOKEN", apiToken);

  await checkDevnetRoots();
  console.log("");

  const fixtures = await checkAuthAndFixtures();
  console.log("");

  const selected = await findFixtureWithScores(fixtures);
  console.log("");
  console.log(`  selected fixtureId: ${selected.fixtureId}`);
  console.log(`  scores shape: ${describeBodyKeys(selected.scoresBody)}`);

  const seqCandidates = buildSeqCandidates(selected.scoresBody);
  const statKeyCandidates = buildStatKeyCandidates();

  console.log("");
  console.log("[3.5] Candidate extraction");
  console.log(`  seq candidates: ${seqCandidates.length ? seqCandidates.join(", ") : "(none found)"}`);
  console.log(`  statKey candidates: ${statKeyCandidates.join(", ")}`);

  if (seqCandidates.length === 0) {
    console.log("");
    console.log("Could not infer seq automatically from scores payload.");
    console.log("Set TXLINE_SEQ manually. First scores body sample:");
    console.log(truncate(selected.scoresText, 1200));
    process.exit(2);
  }

  console.log("");
  const validation = await probeStatValidation(
    selected.fixtureId,
    seqCandidates,
    statKeyCandidates,
  );

  console.log("");
  console.log("[5] SUCCESS");
  console.log(`  fixtureId=${validation.fixtureId}`);
  console.log(`  seq=${validation.seq}`);
  console.log(`  statKey=${validation.statKey}`);
  console.log("  You now have a working validation payload.");
  console.log("");
  console.log("Next step:");
  console.log("  Use this payload to simulate TxLINE validateStat on devnet and measure compute units.");
}

main().catch((err) => {
  console.error("");
  console.error("[DIAGNOSE FAILED]");
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});