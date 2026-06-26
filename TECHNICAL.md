# ProofMarket — Technical Documentation

## Core idea

A trustless parimutuel prediction market for World Cup Over/Under total-goals markets, settled on-chain by cross-program invocation (CPI) into TxLINE's `validate_stat` instruction. The market's resolution is determined by a cryptographic Merkle proof of the real match result, verified against the score Merkle root TxLINE publishes on Solana — not by any trusted operator.

## Technical highlights

- **On-chain, atomic settlement.** `settle_market` builds the `validate_stat` instruction, invokes TxLINE via CPI, and reads its boolean `return_data` in a single transaction. If the proof verifies and the predicate holds, the market resolves; otherwise the transaction reverts. There is no privileged "set the outcome" path.
- **Two-stat predicates for totals.** A total-goals market evaluates `home_score + away_score` against the line, expressed as a TxLINE `TraderPredicate` with a `BinaryExpression::Add` over two stats (statKey 1 = home, statKey 2 = away). Verified end-to-end on a real finished fixture (Turkey 3–2 USA → total 5 → OVER 2.5).
- **Return-data over introspection.** TxLINE's `validate_stat` returns a `bool` via Solana's `return_data`. ProofMarket reads `get_return_data()` and requires it to equal `[1]` from the TxLINE program id. This is simpler and more robust than transaction introspection and avoids any ambiguity about predicate-false vs. revert.
- **Fits the compute budget.** Measured cost: single-stat `validate_stat` ≈ **218,993 CU**; two-stat ≈ **212,588 CU**; the full `settle_market` (CPI + ProofMarket logic) ≈ **223,151 CU** of the 1.4M budget — leaving large headroom.
- **Parimutuel payout.** Deposits pool into OVER (side 1) and NO/UNDER (side 2). On resolution, the winning pool splits the entire pot pro-rata: `payout = position.amount * total_pot / winning_pool`. A `.5` line (e.g. 2.5) guarantees there's never a push.
- **Verifiable resolution receipt.** The UI surfaces the final score, the `daily_scores_roots` PDA the proof was checked against, the settlement tx, and the raw proof, so anyone can independently replay `validate_stat` against the on-chain root.

## On-chain program

Program id (devnet): `9ZQJXjeop6xGjFAEvVTgHvWiBnbkVB9AMxo4D8aihxZs`

Instructions:

| Instruction | Purpose |
|---|---|
| `create_market(fixture_id, period, stat_a_key, stat_b_key, op, yes_threshold)` | Opens a market + USDC vault for a fixture and line. |
| `deposit(side, amount)` | Deposits USDC into the OVER (1) or NO (2) pool; tracks a per-user `Position`. |
| `settle_market(ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, stat_b, op, claimed_outcome)` | Verifies the result via TxLINE `validate_stat` CPI and resolves the market. |
| `claim()` | Pays the winning position its pro-rata share of the pot. |

State accounts: `Market` (config, pools, winning side) and `Position` (per-user side + amount). PDAs: `market = ["market", authority, fixture_id_le, yes_threshold_le]`, `vault = ["vault", market]`, `position = ["position", market, user]`.

Settlement encoding (Over/Under): YES/OVER → `predicate { threshold: yes_threshold, GreaterThan }`; NO/UNDER → `predicate { threshold: yes_threshold + 1, LessThan }`. The program rejects any predicate that doesn't match the `claimed_outcome`, and binds `fixture_id`, the stat keys, and `op` to the market so a proof for a different question can't be substituted.

## TxLINE integration — endpoints used

Authentication: all data endpoints require **both** `Authorization: Bearer <guest JWT>` and `X-Api-Token: <API token>`.

| Endpoint / instruction | How ProofMarket uses it |
|---|---|
| `POST /auth/guest/start` | Obtain the anonymous guest JWT. |
| on-chain `subscribe` instruction | Register the free World Cup subscription on-chain (service level auto-selected from the on-chain pricing matrix; 0 TxLINE charged). |
| `POST /api/token/activate` | Activate the subscription and receive the long-lived API token. |
| `GET /api/scores/stat-validation?fixtureId&seq&statKey[&statKey2]` | **Core.** Fetch the three-stage Merkle proof for a score stat (or two stats for totals). This proof is fed into the on-chain `validate_stat`. |
| `GET /api/scores/snapshot/{fixtureId}` | Inspect a fixture's score updates to find the final score and max sequence. |
| `GET /api/fixtures/snapshot?competitionId=72` | List World Cup fixtures for the auto-picker. |
| on-chain `validate_stat` (TxLINE program, via CPI) | Cryptographically verify the stat/predicate against the on-chain Merkle root; returns a `bool` via `return_data`. |
| on-chain `daily_scores_roots` PDA | The published daily score Merkle root the proof is verified against; PDA seeds `["daily_scores_roots", epochDay_u16_le]`, `epochDay = floor(ts_ms / 86_400_000)`. |

TxLINE devnet program: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`. Devnet API base: `https://txline-dev.txodds.com/api`.

## Data flow for a settlement

1. Client fetches the proof: `GET /api/scores/stat-validation?fixtureId=17926593&seq=1097&statKey=1&statKey2=2`.
2. Response provides `ts`, `statToProve`/`statToProve2` (home/away scores), a shared `eventStatRoot`, and the `statProof`, `subTreeProof`, `mainTreeProof` arrays.
3. Client maps these into `settle_market` args (stat_b reuses the shared `eventStatRoot`; `op = Add`) and computes the `daily_scores_roots` PDA from `ts`.
4. `settle_market` binds the predicate to the market, CPIs `validate_stat`, and requires `return_data == [1]` from the TxLINE program id, then sets the winning side.

## Determinism & review-window notes

- Settlement is deterministic: the same proof against the same on-chain root always yields the same boolean, so the same market always resolves the same way.
- Because matches finish before the judging window, the demo uses an already-final fixture (Turkey 3–2 USA) whose proof and on-chain root are stable. The integration tests reproduce the full lifecycle on demand against the deployed program.
- The deployed frontend's serverless proxy re-mints the guest JWT on a 401, so the live app keeps functioning even if the original JWT expires during review.

## Reproducing the core result

```bash
npm run validate:stat        # validate_stat CPI de-risk + CU measurement
npm run test:smoke           # single-stat lifecycle  -> SMOKE PASS
npm run test:smoke2          # two-stat Over/Under 2.5 -> TWO-STAT SMOKE PASS
```
