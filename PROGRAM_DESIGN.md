# ProofMarket — on-chain program design (Day 4–9)

Custom parimutuel prediction market that settles **trustlessly** by requiring, in
the same transaction, a successful `validate_stat` call on TxLINE's program for
the market's fixture + stat + predicate. We deliberately build our **own**
settlement engine (the track calls this "highly valued") rather than reusing
TxLINE's built-in `create_intent`/`settle_trade` primitives.

Flagship market: **Over/Under total goals** (e.g. O/U 2.5).

## Why this is trustless

`validate_stat` verifies a score statistic against the on-chain daily Merkle root
and **reverts with `PredicateFailed` (6021) unless the predicate holds**. Because a
Solana transaction is atomic, if we put `[validate_stat, settle_market]` in one tx
and `validate_stat` fails, `settle_market` never runs. So `settle_market` only has
to confirm (by instruction introspection) that ix[0] really was a `validate_stat`
call to the genuine TxLINE program for *this market's* fixture/stat/predicate — it
does not re-verify any Merkle proof itself.

## Accounts

```rust
#[account]
pub struct Market {
    pub authority: Pubkey,
    pub fixture_id: i64,
    pub period: i32,                 // ScoreStat.period to match
    pub stat_a_key: u32,            // e.g. home-goals key (or a single total-goals key)
    pub stat_b_key: Option<u32>,   // away-goals key for two-stat Add; None for single-stat
    pub op: Option<BinaryExpr>,    // Some(Add) for two-stat total; None for single-stat
    pub yes_threshold: i32,        // O/U line as integer: "> 2" => threshold 2, GreaterThan
    pub pool_yes: u64,             // USDC staked on YES (over)
    pub pool_no: u64,              // USDC staked on NO  (under)
    pub winning_side: u8,          // 0 = unresolved, 1 = YES, 2 = NO
    pub usdc_mint: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
pub struct Position {            // PDA: ["position", market, user]
    pub market: Pubkey,
    pub user: Pubkey,
    pub side: u8,                  // 1 = YES, 2 = NO
    pub amount: u64,              // USDC contributed
    pub claimed: bool,
}
```

Vault: a USDC token account owned by a `["vault", market]` PDA.

## Instructions

- `create_market(fixture_id, period, stat_a_key, stat_b_key, op, yes_threshold, usdc_mint)`
  — init `Market` + vault.
- `deposit(side, amount)` — `transfer` USDC user → vault; init/extend `Position`;
  `pool_yes`/`pool_no += amount`.
- `settle_market(claimed_outcome)` — introspects ix[0] (see below) and sets
  `winning_side = claimed_outcome`. **Light on compute** (no token transfers), so it
  fits alongside `validate_stat` in one tx.
- `claim()` — winners withdraw pro-rata: `payout = position.amount * total_pool / winning_pool`.
  (Parimutuel: losers' stakes fund winners. Optionally take a small fee.)

## settle_market introspection (the security core)

In one transaction: `ix[0] = TxLINE.validate_stat(...)`, `ix[1] = settle_market(claimed_outcome)`.
`settle_market` uses the Instructions sysvar (`load_instruction_at_checked`) to read ix[0] and assert:

1. `ix0.program_id == TXLINE_PROGRAM_ID` (devnet `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`).
2. `ix0.data[0..8] == [107,197,232,90,191,136,105,185]` (`validate_stat` discriminator).
3. Parse selected fields from `ix0.data` and match the market.

The validate_stat arg layout (Anchor/borsh, after the 8-byte discriminator) — all
ints little-endian:

| field | type | bytes | offset |
| --- | --- | --- | --- |
| ts | i64 | 8 | 8 |
| fixture_summary.fixture_id | i64 | 8 | 16 |
| fixture_summary.update_stats.update_count | i32 | 4 | 24 |
| fixture_summary.update_stats.min_timestamp | i64 | 8 | 28 |
| fixture_summary.update_stats.max_timestamp | i64 | 8 | 36 |
| fixture_summary.events_sub_tree_root | [u8;32] | 32 | 44 |
| fixture_proof | Vec<ProofNode> | 4 + L1·33 | 76 |
| main_tree_proof | Vec<ProofNode> | 4 + L2·33 | … |
| predicate.threshold | i32 | 4 | after the two Vecs |
| predicate.comparison | enum tag | 1 | +4 |
| stat_a.stat_to_prove.key | u32 | 4 | +1 |
| stat_a.stat_to_prove.value | i32 | 4 | … |
| stat_a.stat_to_prove.period | i32 | 4 | … |

`ProofNode` = `[u8;32]` + `bool` = 33 bytes. `Comparison`: 0=GreaterThan, 1=LessThan,
2=EqualTo. `BinaryExpression`: 0=Add, 1=Subtract.

Parsing is a sequential walk: read `fixture_id` at fixed offset 16, then read the two
`u32` Vec length prefixes to skip `fixture_proof` and `main_tree_proof`, which lands you
at `predicate`, then `stat_a`. (For a two-stat Over/Under, also skip `stat_a.stat_proof`'s
Vec to reach `stat_b`/`op` and verify `op == Add` and `stat_b.key == stat_b_key`.)

Assertions:
- `fixture_id == market.fixture_id`
- `stat_a.key == market.stat_a_key`, `period == market.period`
- predicate matches the **claimed outcome**:
  - `claimed_outcome == YES` ⇒ `threshold == yes_threshold && comparison == GreaterThan`
  - `claimed_outcome == NO`  ⇒ `threshold == yes_threshold + 1 && comparison == LessThan`

Because validate_stat reverted unless that predicate is true on-chain, a landed tx
proves the claimed outcome. Set `winning_side`. No oracle trust anywhere.

## Over/Under 2.5 mapping (integer predicates)

Total goals are integers, so O/U 2.5 is exact: **YES (over)** = total `> 2`
(`GreaterThan`, threshold 2 → total ≥ 3); **NO (under)** = total `< 3`
(`LessThan`, threshold 3 → total ≤ 2). Single-stat if a "total goals" key exists;
otherwise two-stat `Add(home_goals, away_goals)`. (Confirm the goals stat key from the
Soccer Feed docs when wiring market logic.)

## Open item carried from Day 1

If the de-risk probe shows `validate_stat` alone is too close to the 1.4M CU cap to
co-locate with `settle_market`, the fallback is: keep `settle_market` in the same tx
but make it do *nothing but* set `winning_side` (already the plan), and if even that
doesn't fit, split — `validate_stat` writes a tiny verified-outcome marker account that
a separate `settle_market` reads. The atomic-introspection design above is preferred and
expected to fit since settle_market performs no transfers.
