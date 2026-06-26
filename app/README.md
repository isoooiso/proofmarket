# ProofMarket Demo Frontend

Single-page devnet demo for ProofMarket: create an O/U 2.5 market, deposit on OVER/NO, settle with a real TxLINE Merkle proof, claim winnings, and view a verifiable resolution receipt.

## Setup (local dev)

1. Copy environment template:

   ```bash
   cp .env.example .env
   ```

2. Edit `app/.env`:

   - `VITE_RPC_URL` — devnet RPC (Helius URL recommended).

3. Set TxLINE API token for the **server-side** proxy (not in the browser):

   - Add `TXLINE_API_TOKEN=txoracle_api_...` to the **repo root** `.env` or `app/.env`.
   - The dev server mints a guest JWT automatically via `POST /auth/guest/start` (same as production).
   - Do **not** set `VITE_TXLINE_*` variables — tokens must not be bundled.

4. Install and run:

   ```bash
   npm install --ignore-scripts
   npm run dev
   ```

   Open the URL Vite prints (usually `http://localhost:5173`).

5. Demo wallets should hold mock USDC from `npm run demo:setup` or `npm run fund:demo-wallets` at the repo root.

### Local dev vs production (TxLINE proxy)

Both environments use the **same browser URL**: `/api/txline/<path>`.

| Environment | What handles `/api/txline/*` |
|---------------|------------------------------|
| `npm run dev` | Vite plugin in `vite.config.ts` (calls `api/txline/proxyCore.ts`) |
| Vercel | Serverless function `api/txline/[...path].ts` |

Set `TXLINE_API_TOKEN` in repo root `.env` or `app/.env` for local dev. No `VITE_TXLINE_*` vars.

Optional: run `npx vercel dev` from `app/` to use the real Vercel function locally (requires Vercel CLI login).

## Demo click-path (Turkey vs USA O/U 2.5)

Fixture: **17926593**, final score **3-2** (total 5 → **OVER** wins vs line 2.5 / `yes_threshold=2`).

1. Connect Phantom as wallet A (`demoWalletA` in `demoConfig.ts`).
2. **Reset demo** → **Create market** → **Deposit OVER** (e.g. 100 USDC).
3. Switch to wallet B → **Deposit NO**.
4. Switch back → **Settle market** → **Claim winnings** on the winning side.

After settle, the **Verifiable Resolution Receipt** shows scores, Merkle root PDA, proof sizes, and the settle transaction.

## Build

```bash
npm run build
```

Produces static assets in `dist/`.

## Deploy to Vercel

### 1. Project settings

- **Root directory:** `app` (monorepo: set in Vercel → Settings → General).
- **Do not** override build/output in the dashboard if `vercel.json` is present — it sets `buildCommand`, `outputDirectory`, and API functions.
- If the dashboard Framework Preset is “Vite”, that is fine; `vercel.json` does **not** use `framework: vite` so `/api/*` serverless functions in `app/api/` are still deployed alongside the SPA.

`vercel.json` configures:

- Vite SPA build → `dist/`
- Serverless functions → `app/api/**/*.ts` (e.g. `/api/txline/scores/stat-validation` → `api/txline/[...path].ts`)
- SPA fallback: non-`/api` routes → `index.html`

### 2. Environment variables (Vercel dashboard)

| Variable | Scope | Required | Description |
|----------|--------|----------|-------------|
| `TXLINE_API_TOKEN` | Production, Preview | Yes | TxLINE API token (`txoracle_api_...`). Server-only; mints guest JWT via `/auth/guest/start`. |
| `VITE_RPC_URL` | Production, Preview | Yes | Helius (or other) devnet RPC URL for Phantom / `@solana/web3.js`. Safe to expose (client bundle). |

**Not needed on Vercel:** `TXLINE_JWT` — the serverless function refreshes guest JWTs automatically (cached in-memory; re-mints on 401).

Optional client vars (defaults apply if unset):

| Variable | Description |
|----------|-------------|
| `VITE_DEMO_SAFE_MODE` | Set to `false` to disable RPC single-flight / no-poll mode. |

### 3. Deploy

From the `app` directory:

```bash
npm install
npm run build
npx vercel
```

Or connect the GitHub repo in Vercel with root directory `app`.

First production deploy:

```bash
cd app
npx vercel --prod
```

### 4. Verify

1. Open the deployed URL.
2. Connect Phantom, **Reset demo**, **Create market** — should load proof preview without CORS errors.
3. Complete deposit → settle → claim flow.

If TxLINE returns 401, the function mints a new guest JWT and retries once automatically.

## Notes

- Program ID and mock USDC mint come from `src/demoConfig.ts`.
- Market PDA seeds: `market`, authority, `fixture_id` (i64 LE), `yes_threshold` (i32 LE).
- Settlement uses TxLINE `validate_stat` CPI — not a trusted operator callback.
