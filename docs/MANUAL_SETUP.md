# Manual Setup

This guide is the repo-accurate fallback when you do not want to use the one-shot bootstrap script.

If you want the fastest local path, use [`setupLocalAndStart.sh`](../setupLocalAndStart.sh) instead. That script installs dependencies, optionally starts a local Initia rollup, deploys contracts, writes local env files, applies D1 migrations, and starts both apps.

## Current Local Defaults

The codebase currently defaults to this local Initia setup unless you override it with env vars:

- EVM JSON-RPC: `http://localhost:8545`
- Tendermint RPC: `http://localhost:26657`
- Cosmos REST: `http://localhost:1317`
- Indexer: `http://localhost:8080`
- Initia web app: `http://localhost:5173`
- Rollup chain id: `pillow-rollup`
- EVM chain id: `2178983797612220`

These are defaults only. If your local Initia appchain uses different values, set the matching env vars instead of changing app code.

## Can You Use Your Own Initia Chain?

Yes, if all of these are true:

- It is an Initia EVM-compatible local appchain.
- The RPC endpoints are reachable from this repo.
- You deploy this repo's contracts to that chain.
- You update the local env files with your actual chain ids, RPC URLs, and deployed contract addresses.

That means the setup is not just "change the appchain name". You also need matching contract deployments and matching env values.

## Prerequisites

- Node.js `20+`
- `pnpm`
- Foundry: `forge` and `cast`
- `jq`
- `curl`
- `weave` if you want this repo to start a local Initia rollup for you

Install workspace dependencies from the repo root:

```bash
pnpm install
```

## Fully Manual Setup

Use this path if you want full control, or if you are connecting the app to your own running local Initia chain.

## Env Files

Create the local env files:

```bash
cp .env.example .env
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.example apps/web/.env
```

### 1. Root `.env`

Used by the bootstrap script and shared local defaults.

Start from [`.env.example`](../.env.example):

```dotenv
OPENROUTER_API_KEY=
INITIATE_MNEMONIC=
MAX_AGENTS_PER_USER=5
MAX_MANAGERS_PER_USER=1
DEFAULT_MANAGER_MAX_AGENTS=2
```

Notes:

- `OPENROUTER_API_KEY`: required for the app to run locally.
- `INITIATE_MNEMONIC`: optional unless you want the bootstrap script to derive a deployer key.
- `MAX_AGENTS_PER_USER`, `MAX_MANAGERS_PER_USER`, `DEFAULT_MANAGER_MAX_AGENTS`: optional local limits.

### 2. `apps/api/.dev.vars`

Wrangler reads this file for local Worker secrets.

Minimal working example:

```dotenv
OPENROUTER_API_KEY=
PLAYWRIGHT_SECRET=playwright-dev-secret
```

Recommended example when you want backend-driven Initia execution enabled:

```dotenv
OPENROUTER_API_KEY=
PLAYWRIGHT_SECRET=playwright-dev-secret
INITIA_EVM_RPC=http://localhost:8545
INITIA_EVM_CHAIN_ID=2178983797612220
INITIA_AGENT_CONTRACT_ADDRESS=
INITIA_EXECUTOR_PRIVATE_KEY=
MOCK_PERP_DEX_ADDRESS=
KEY_ENCRYPTION_SECRET=
```

What these values do:

- `OPENROUTER_API_KEY`: enables LLM-backed agent analysis.
- `PLAYWRIGHT_SECRET`: enables the local dev session helper route used by Playwright and other local test flows.
- `INITIA_EVM_RPC`: backend RPC URL for Initia executor calls.
- `INITIA_EVM_CHAIN_ID`: backend chain id for the Initia executor. If omitted, the API falls back to `2178983797612220`.
- `INITIA_AGENT_CONTRACT_ADDRESS`: fallback contract address for backend executor calls.
- `INITIA_EXECUTOR_PRIVATE_KEY`: executor key used by the API to submit onchain transactions.
- `MOCK_PERP_DEX_ADDRESS`: backend address for mock perp execution flows.
- `KEY_ENCRYPTION_SECRET`: optional 64-character hex string used to AES-GCM encrypt stored user API keys. If omitted, local dev falls back to plaintext storage.

### 3. `apps/web/.env`

Start from [`apps/web/.env.example`](../apps/web/.env.example):

```dotenv
NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS=
NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS=
NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS=
NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS=
NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS=
NUXT_PUBLIC_INITIA_SHOWCASE_TARGET_ADDRESS=
NUXT_PUBLIC_INITIA_EXECUTOR_MAX_TRADE_WEI=1000000000000000000
NUXT_PUBLIC_INITIA_EXECUTOR_DAILY_LIMIT_WEI=5000000000000000000
```

If you are using a non-default local chain, you will usually also want to add:

```dotenv
NUXT_PUBLIC_INITIA_ROLLUP_CHAIN_ID=pillow-rollup
NUXT_PUBLIC_INITIA_EVM_CHAIN_ID=2178983797612220
NUXT_PUBLIC_INITIA_EVM_RPC=http://localhost:8545
NUXT_PUBLIC_INITIA_RPC_URL=http://localhost:26657
NUXT_PUBLIC_INITIA_REST_URL=http://localhost:1317
NUXT_PUBLIC_INITIA_INDEXER_URL=http://localhost:8080
NUXT_PUBLIC_INITIA_WEB_URL=http://localhost:5173
```

Additional optional public bridge defaults supported by the frontend:

```dotenv
NUXT_PUBLIC_INITIA_BRIDGE_SRC_CHAIN_ID=initiation-2
NUXT_PUBLIC_INITIA_BRIDGE_SRC_DENOM=uinit
NUXT_PUBLIC_INITIA_BRIDGE_URL=https://bridge.testnet.initia.xyz
```

What the main frontend values do:

- `NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS`: deployed `Agent.sol` address.
- `NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS`: deployed `IUSDDemoToken` address.
- `NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS`: deployed `IUSDDemoFaucet` address.
- `NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS`: deployed `MockPerpDEX` address.
- `NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS`: public address of the executor account.
- `NUXT_PUBLIC_INITIA_SHOWCASE_TARGET_ADDRESS`: call target used in the showcase flow. Locally this is usually the same as `MockPerpDEX`.

## Start Or Reuse Your Local Initia Chain

If you want this repo to handle chain startup as part of the full local bootstrap, use:

```bash
./setupLocalAndStart.sh --skip-contracts
```

If you already run your own chain yourself, make sure these endpoints are reachable before continuing:

- `http://localhost:8545`
- `http://localhost:26657`
- `http://localhost:1317`

Adjust env vars if your chain uses different URLs.

## Deploy Contracts

Deploy from [`contracts`](../contracts). The repo contains scripts for:

- `Agent.sol`
- `IUSDDemoToken.sol`
- `IUSDDemoFaucet.sol`
- `MockPerpDEX.sol`

Example deployment flow:

```bash
cd contracts

PRIVATE_KEY=0x<your-key> forge script script/DeployAgent.s.sol:DeployAgent \
  --rpc-url http://localhost:8545 --broadcast --slow

PRIVATE_KEY=0x<your-key> forge script script/DeployIUSDDemo.s.sol:DeployIUSDDemo \
  --rpc-url http://localhost:8545 --broadcast --slow

PRIVATE_KEY=0x<your-key> \
IUSD_TOKEN_ADDRESS=0x<iusd-token-address> \
forge script script/DeployMockPerpDEX.s.sol:DeployMockPerpDEX \
  --rpc-url http://localhost:8545 --broadcast --slow
```

The deployment scripts print contract addresses to stdout. Map the outputs into env vars like this:

| Deployment output | Put it into |
| --- | --- |
| `Agent` address | `INITIA_AGENT_CONTRACT_ADDRESS`, `NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS` |
| `IUSDDemoToken` address | `NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS` |
| `IUSDDemoFaucet` address | `NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS` |
| `MockPerpDEX` address | `MOCK_PERP_DEX_ADDRESS`, `NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS`, `NUXT_PUBLIC_INITIA_SHOWCASE_TARGET_ADDRESS` |
| Executor wallet private key | `INITIA_EXECUTOR_PRIVATE_KEY` |
| Executor wallet address | `NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS` |
| Your EVM chain id | `INITIA_EVM_CHAIN_ID`, `NUXT_PUBLIC_INITIA_EVM_CHAIN_ID` |

## Apply Local API Migrations

The API uses Wrangler local D1 for dev.

From [`apps/api`](../apps/api):

```bash
pnpm migration:apply:local
```

## Run The Apps

From the repo root, start the API:

```bash
pnpm run dev:api
```

In a second terminal, start the frontend:

```bash
pnpm run dev:web
```

Expected local URLs:

- Web: `http://localhost:3001`
- API: `http://localhost:8787`
- API health: `http://localhost:8787/api/health`

## Minimal Manual Flow

If you already have your own Initia chain running, the shortest valid setup is:

1. Copy `.env.example` to `.env`.
2. Copy `apps/web/.env.example` to `apps/web/.env`.
3. Create `apps/api/.dev.vars` manually.
4. Put `OPENROUTER_API_KEY` into `.env` and `apps/api/.dev.vars` if you want LLM-backed agents.
5. Deploy `Agent.sol`, `IUSDDemoToken.sol`, `IUSDDemoFaucet.sol`, and `MockPerpDEX.sol` to your chain.
6. Put the deployed addresses and chain-specific RPC values into `apps/web/.env`.
7. If you want backend executor support, put the matching Initia executor values into `apps/api/.dev.vars`.
8. Apply local D1 migrations from `apps/api`.
9. Run `pnpm run dev:api`.
10. Run `pnpm run dev:web`.

## References

- Fast bootstrap: [`setupLocalAndStart.sh`](../setupLocalAndStart.sh)
- Main project README: [`README.md`](../README.md)
- Deploy docs: [`docs/DEPLOY.md`](./DEPLOY.md)
- Contract details: [`contracts/README.md`](../contracts/README.md)
