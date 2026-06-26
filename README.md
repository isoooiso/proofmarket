# ProofMarket — Trustless Prediction Markets

**Prediction markets where the settlement is _provable_, not _trusted_.**

ProofMarket is a parimutuel prediction market on Solana for World Cup Over/Under total-goals markets. The thing that makes it different is **how it settles**: instead of a trusted operator or an oracle multisig deciding the outcome, the market resolves on-chain by calling [TxLINE](https://txline.txodds.com)'s `validate_stat` instruction via a cross-program invocation (CPI) and reading back a cryptographic yes/no. Settlement is a single atomic transaction that anyone can independently verify against the Merkle root TxLINE publishes on Solana.

Built for the TxODDS / Superteam World Cup Hackathon 2026 — Prediction Markets & Settlement track.

---

## Why this matters

Every prediction market has a settlement problem: *who decides who won?* In most designs the answer is a privileged party — an admin key, a committee, an oracle you have to trust not to lie or make a mistake. That trust is the weakest link.

ProofMarket removes it. The winning side of a market is determined by a **cryptographic Merkle proof of the real match result**, checked **on-chain** by TxLINE's program. Our settlement instruction has no "admin decides the outcome" path — if the proof doesn't verify, the transaction simply fails. The result is a market whose resolution is as trustworthy as the on-chain data itself.

---

## How it works

```
           TxODDS Oracle (off-chain)                 Solana (on-chain)
        ┌───────────────────────────┐        ┌──────────────────────────────┐
        │  scores, Merkle proofs     │        │  TxLINE program               │
        │  /api/scores/stat-...      │──────► │  • daily score Merkle roots   │
        └───────────────────────────┘ proof  │  • validate_stat instruction  │
                                              └──────────────┬───────────────┘
                                                             │ CPI + return_data
        ┌───────────────────────────┐        ┌──────────────▼───────────────┐
        │  ProofMarket frontend      │        │  ProofMarket program          │
        │  (Vite + React + Phantom)  │──────► │  create_market / deposit /     │
        │                            │  tx    │  settle_market / claim         │
        └───────────────────────────┘        └──────────────────────────────┘
```

1. **create_market** — anyone opens a market on a fixture, e.g. *Turkey vs USA, Over/Under 2.5 total goals*.
2. **deposit** — traders deposit USDC into the OVER pool (side 1) or the NO/UNDER pool (side 2). Pooled, parimutuel.
3. **settle_market** — once the match is final, a keeper submits the real score with its Merkle proof. The program:
   - binds the predicate to the market's line (so the proof can't be for a different question),
   - CPIs into TxLINE's `validate_stat` with the proof,
   - reads TxLINE's boolean `return_data` — `true` resolves the market, `false`/no-data reverts.
   - The total-goals market is a **two-stat** predicate: `home_score + away_score` (statKeys 1 and 2, `op = Add`) compared against the line.
4. **claim** — the winning pool splits the entire pot pro-rata. Losers cannot claim.

The settlement (including the two-stat `validate_stat` CPI) costs **~223,000 compute units** — well within Solana's 1.4M budget, so it all fits in one atomic transaction.

---

## The differentiator: verifiable resolution receipt

After a market resolves, the UI renders a **resolution receipt**: the final score, the on-chain Merkle-root account the proof was checked against, the settlement transaction, and the raw proof data. Anyone can take that transaction, replay TxLINE's `validate_stat` against the on-chain root, and confirm the outcome themselves — no need to trust ProofMarket. Settlement is math, not a database row someone can edit.

---

## Live links

- **Live app (devnet):** _<your Vercel URL>_
- **Demo video:** _<your YouTube/Loom link>_
- **Solana program (devnet):** [`9ZQJXjeop6xGjFAEvVTgHvWiBnbkVB9AMxo4D8aihxZs`](https://explorer.solana.com/address/9ZQJXjeop6xGjFAEvVTgHvWiBnbkVB9AMxo4D8aihxZs?cluster=devnet)
- **TxLINE program (devnet):** [`6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`](https://explorer.solana.com/address/6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J?cluster=devnet)
- **Technical documentation:** [`docs/TECHNICAL.md`](docs/TECHNICAL.md)

---

## Repository layout

```
programs/proofmarket/      Anchor program (Rust) — the on-chain market + settlement logic
  src/lib.rs               create_market, deposit, settle_market (validate_stat CPI), claim
src/                       TypeScript tooling (subscribe, proof fetch, validate_stat de-risk)
  subscribe_activate.ts    TxLINE subscription + API-token activation (free World Cup tier)
  validate-stat.ts         Standalone validate_stat CPI de-risk + compute-unit measurement
  pdas.ts, txline.ts       PDA helpers + TxLINE API client
scripts/                   gen-idl.js (hand-written IDL), pick_fixture.ts (auto-picker), setup_demo.ts
tests/                     smoke_lifecycle.ts (single-stat), smoke_two_stat.ts (Over/Under 2.5)
app/                       Vite + React frontend (wallet, market page, resolution receipt)
target/idl/proofmarket.json    Anchor IDL (hand-generated; see note below)
```

---

## Running it yourself

### Prerequisites
- Rust + Solana CLI (Anza) + Anchor 0.30.1, Node 20.
- A devnet RPC (the public endpoint rate-limits hard; use a free Helius/QuickNode devnet key).
- A TxLINE subscription (free World Cup tier — see below).

### 1. TxLINE subscription (free tier)
```bash
npm install
npm run wallet        # generate/fund a devnet wallet
npm run subscribe     # subscribe on-chain (free World Cup tier) + activate API token
```
This writes `TXLINE_JWT` and `TXLINE_API_TOKEN` into `.env`.

### 2. De-risk validate_stat (optional, proves the core)
```bash
npm run validate:stat
# Simulates TxLINE validate_stat on devnet with a real proof and prints compute units (~219k).
```

### 3. Full lifecycle tests
```bash
export SOLANA_KEYPAIR_PATH=$HOME/.config/solana/id.json
npm run test:smoke     # single-stat lifecycle  -> "SMOKE PASS"
npm run test:smoke2    # two-stat Over/Under 2.5 -> "TWO-STAT SMOKE PASS"
```
These run the entire create → deposit → settle (real TxLINE proof) → claim flow on devnet against the deployed program.

### 4. Frontend
```bash
cd app
cp .env.example .env    # set VITE_RPC_URL (Helius devnet); TxLINE token is read server-side
npm install
npm run dev
```
Open the printed localhost URL, connect Phantom (devnet), and use the demo controls.

---

## Build notes (honest about the rough edges)

This was built on a current Rust toolchain (1.96), which is ahead of where some Anchor 0.30.1 build paths expect to be. Two workarounds, neither affecting the on-chain program's correctness:

- **BPF build:** `anchor build --no-idl -- --tools-version v1.48` (the default platform-tools couldn't build against today's crate index; `Cargo.toml` carries a couple of dependency patches for this).
- **IDL:** Anchor's IDL generator calls a `proc-macro2` API that was removed upstream, so the IDL is generated by hand from `lib.rs` via `scripts/gen-idl.js` (discriminators computed with sha256, reconciled field-by-field against the program). It's validated by the integration tests, which build every instruction from this IDL.

---

## Security / demo caveats

- Everything runs on **devnet** with a **mock USDC** mint — no real funds.
- The "Reset demo" feature generates an ephemeral market-authority keypair in the browser for clean demo runs. This is a demo convenience only; a production deployment would not hold keys client-side.
- The deployed frontend proxies TxLINE API calls through a serverless function so credentials stay server-side and never reach the browser.

---

## License

MIT
