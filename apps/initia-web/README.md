# heppy market — Initia AI Trading Frontend

Vite + React SPA for the Initia hackathon MVP. Connects with InterwovenKit to a local EVM rollup, manages an AI trading agent onchain, and shows hybrid onchain/offchain execution.

## Quick Start

```bash
pnpm -C apps/initia-web dev     # start dev server on :5173
pnpm -C apps/initia-web build   # production build → dist/
```

Requires the backend running on :8787 (`npm run dev:api`).

## Environment Variables

Copy `.env.example` to `.env.local`:

```bash
cp apps/initia-web/.env.example apps/initia-web/.env.local
```

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE` | `http://localhost:8787` | Backend Cloudflare Worker URL |
| `VITE_EVM_RPC` | `http://localhost:8545` | Initia rollup EVM JSON-RPC |
| `VITE_REST_URL` | `http://localhost:1317` | Initia rollup Cosmos REST |
| `VITE_RPC_URL` | `http://localhost:26657` | Initia rollup Tendermint RPC |
| `VITE_INDEXER_URL` | `http://localhost:8080` | Initia rollup indexer |
| `VITE_NATIVE_DENOM` | `GAS` | Rollup native denom used for gas + UI labels |
| `VITE_BRIDGE_SRC_CHAIN_ID` | `initiation-2` | Interwoven bridge source chain |
| `VITE_BRIDGE_SRC_DENOM` | `uinit` | Interwoven bridge source asset denom |
| `VITE_CONTRACT_ADDRESS` | `0x286D7...` | Agent.sol contract address |

## Architecture

```
User Browser
  └── InterwovenKit (wallet connect, signing)
  └── wagmi + viem (EVM reads via eth_call)
  └── React UI (5-step flow)
        ├── Step 01: Connect wallet
        ├── Step 02: Create agent onchain (createAgent)
        ├── Step 03: Vault deposit/withdraw
        ├── Step 04: AutoSign + Execute Tick
        └── Step 05: Event log (onchain + offchain AI)
  └── Backend API (price feed, tick log, faucet)
```

**Hybrid execution model:**
- **Onchain:** agent creation, deposits, tick execution (real testnet transactions)
- **Offchain:** AI decision logic (simulated, labeled clearly in the UI)

## Contract

`Agent.sol` deployed to pillow-rollup (EVM appchain, chain ID 2178983797612220):
- Address: `0x286D7241779329DB8c34995d3e8D3796e0d685D7`
- Deploy tx: `0x4daa0b855b25c4a67d998fada00bcd381c6c9473b113d5e7ee2ae72ad8605134`

## Deploy to Cloudflare Pages

1. Build: `pnpm -C apps/initia-web build`
2. Set env vars in CF Pages dashboard (see `.env.example`)
3. Deploy: `wrangler pages deploy apps/initia-web/dist --project-name heppy-initia`

The `public/_redirects` file handles SPA routing (`/* → /index.html 200`).
