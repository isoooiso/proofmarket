# Day 1 runbook — de-risk `validate_stat`

Goal: get TxLINE free-tier data flowing and confirm `validate_stat` lands on
devnet, then **record its compute-unit cost**. That number unblocks the program
design (whether settle can share a tx with validate_stat). Nothing else gets built
until this is green.

> The probe must run on your machine — it talks to Solana devnet and
> `txline-dev.txodds.com`, which the assistant's sandbox can't reach.

## 0. Toolchain

**Day 1 needs only Node 18+ (no `solana` / `anchor` CLI).** The probe is pure
web3.js over HTTP. The Solana CLI + Anchor are needed later (Day 4–9) to build and
deploy our own program — on Windows, install those under **WSL2** when we get there.
Skip them for now.

## 1. Install + wallet (Node only)

```bash
cd proofmarket
npm install

cp .env.example .env
# edit .env: set WALLET_KEYPAIR=./devnet-wallet.json

npm run wallet     # creates devnet-wallet.json and airdrops 1 SOL via RPC
```

If the airdrop is rate-limited, the script prints your address — fund it at
<https://faucet.solana.com> and re-run `npm run wallet`.

## 2. (Only if the scripts say the IDL is missing)

The scripts load the IDL automatically via `Program.fetchIdl` (no CLI). If they
report it's missing, copy the JSON from the "IDL" tab at
<https://txline-docs.txodds.com/documentation/programs/devnet.md> into
`idl/txoracle.json`. (No `anchor` CLI needed for Day 1.)

## 3. Subscribe to the free tier + activate the API token

```bash
npm run subscribe
```

Free tier — no payment. Paste the printed `TXLINE_JWT` and `TXLINE_API_TOKEN` into
`.env`. **First likely friction point:** the `subscribe` accounts (TxL ATA / treasury
PDAs). If it errors, that's the thing to debug first — flag the exact error to me and
we fix the account set. (TxODDS also waives fees and runs a live support chat for the
hackathon — use it.)

## 4. Run the probe

Start by replicating the documented example (the default `FIXTURE_ID/SEQ/STAT_KEY`
in `.env`) to confirm the pipeline, then point it at a real World Cup fixture (find a
fixture id + a `seq`/`statKey` that has data via the fixtures/scores endpoints).

```bash
npm run derisk
```

## 5. Success criteria (the Day-1 deliverable)

- `validate_stat` simulation has `error: null`.
- It prints **COMPUTE UNITS CONSUMED: <N>** and a real **validate_stat tx** signature.

**Report the CU number `N`.** It decides the settlement architecture:
- `N` comfortably under ~1.1M → the atomic `[validate_stat, settle_market]` design in
  `PROGRAM_DESIGN.md` is viable. Proceed to Day 4–9 (write the Anchor program).
- `N` near the 1.4M cap → use the fallback in `PROGRAM_DESIGN.md` (verified-outcome
  marker account read by a separate settle tx).

## If the probe fights you

Common things to check, in order: API token activated (step 3); the target fixture
actually has a posted Merkle root for that day/time (else `RootNotAvailable` 6007);
the hash encoding in `toBytes32` matches the real response (hex vs base64 vs array —
adjust `src/txline.ts`); `daily_scores_roots` PDA epochDay derived from `validation.ts`.
Paste the failing log to me and we iterate.
