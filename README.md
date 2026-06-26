# ProofMarket

Trustless World Cup prediction markets that settle on-chain against TxLINE's
cryptographically-verified score data. Built for the TxODDS / Superteam *Prediction
Markets & Settlement* track.

**Flagship market:** Over/Under total goals, settled by requiring a successful
`validate_stat` proof on TxLINE's Solana program in the same transaction as payout
resolution — no oracle trust.

## Status: Day 1 (de-risk)

The current focus is proving the core dependency works before building around it:
reproduce `validate_stat` on devnet for a real fixture and measure its compute cost.

- `src/subscribe_activate.ts` — TxLINE free-tier subscribe + API token activation.
- `src/derisk_validate_stat.ts` — **the de-risk probe**: fetch a stat proof, build
  `validate_stat`, simulate to measure compute units, then send it on devnet.
- `src/txline.ts` — API client + mapping of the proof response to `validate_stat` args.
- `src/pdas.ts` — PDA derivations (`daily_scores_roots`, treasury, ATAs).
- `PROGRAM_DESIGN.md` — the custom parimutuel settlement program + the byte-level
  `validate_stat` introspection spec (Day 4–9).
- `RUNBOOK_day1.md` — exact steps to run the probe and what success looks like.

→ Start at [`RUNBOOK_day1.md`](RUNBOOK_day1.md).

## Plan

1. **Day 1–3** — de-risk `validate_stat` (this).
2. **Day 4–9** — Anchor program: `create_market` / `deposit` / `settle_market`
   (validate_stat introspection) / `claim`.
3. **Day 10–16** — React/Vite frontend, USDC deposits, SSE score/odds feed, verifiable
   resolution receipt UI.
4. **Day 17–20** — historical-replay mode for a deterministic demo; polish.
5. **Day 21–23** — 5-min demo video, technical docs, deploy.
6. **Day 24–25** — buffer + submit (deadline July 19, 23:59 UTC).

Devnet program (TxLINE): `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
