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

### TxLINE API path (dev and production)

The browser always calls:

```text
GET /api/txline/scores/stat-validation?...
```

- **Local dev:** Vite middleware (`vite.config.ts`) runs the same proxy logic as production (`api/txline/proxyCore.ts`).
- **Vercel:** Serverless function `api/txline/[...path].ts` forwards to `https://txline-dev.txodds.com/api/<path>` with server-side auth.

No CORS issues; no TxLINE credentials in client code.

## Demo click-path (Turkey vs USA O/U 2.5)

Fixture: **17926593**, final score **3-2** (total 5 → **OVER** wins vs line 2.5 / `yes_threshold=2`).

1. Connect Phantom as wallet A (`demoWalletA` in `demo-config.json`).
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

- **Root directory:** `app` (if deploying from the monorepo, set this in Vercel → Settings → General).
- **Framework preset:** Vite (or use `vercel.json` in this folder).
- **Build command:** `npm run build`
- **Output directory:** `dist`

`vercel.json` already configures SPA fallback and `/api/*` serverless functions.

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

- Program ID and mock USDC mint come from `src/demo-config.json`.
- Market PDA seeds: `market`, authority, `fixture_id` (i64 LE), `yes_threshold` (i32 LE).
- Settlement uses TxLINE `validate_stat` CPI — not a trusted operator callback.
