# Manual Setup

## Initia Appchain Setup

For Initia-specific setup, use the `initia-appchain-dev` skill as the reference workflow. This project expects an Initia **EVM** appchain reachable through:

- EVM JSON-RPC, usually `http://localhost:8545`
- Tendermint RPC, usually `http://localhost:26657`
- Cosmos REST, usually `http://localhost:1317`

The current local defaults in this repo assume:

- Rollup chain id: `pillow-rollup`
- EVM chain id: `2178983797612220`

Those are only defaults. If your local appchain uses different values, set the matching env vars instead of changing app code.

### Can someone use their own local Initia appchain?

Yes, if all of the following are true:

- It is an Initia EVM-compatible local appchain.
- The RPC endpoints are reachable by this app.
- You deploy this repo's contracts to that chain.
- You put your chain id, RPC URLs, and deployed contract addresses into the env files.

In practice, the setup is:

1. Start your own local Initia appchain.
2. Deploy `Agent.sol`, `IUSDDemoToken` + `IUSDDemoFaucet`, and `MockPerpDEX`.
3. Update the env vars in `apps/api/.dev.vars` and `apps/web/.env`.
4. Run `pnpm run dev:api` and `pnpm run dev:web`.

So yes: if someone already has a local Initia appchain, they can use this app. They do not just change the appchain name. They must also deploy the contracts on that appchain and map the deployed values into the env files.

## Quick Start

### Option A: one-shot local setup

The repo includes [`doItAll.sh`](./doItAll.sh), which can:

- install workspace dependencies
- start the local Initia rollup with `weave`
- deploy the contracts
- write `apps/web/.env`
- write `apps/api/.dev.vars`
- apply local D1 migrations

Run:

```bash
chmod +x doItAll.sh
./doItAll.sh
```

Useful variants:

```bash
./doItAll.sh --skip-chain
./doItAll.sh --skip-chain --skip-contracts
```



### Option B: manual setup

Use this if you want full control or if you are connecting the app to your own local Initia appchain.

## Prerequisites

- Node.js `20+`
- `pnpm`
- Foundry: `forge` and `cast`
- `jq`
- `minitiad`
- `weave` if you want this repo to start the local rollup for you

Install dependencies from the repo root:

```bash
pnpm install
```

## Env Files

Create the local env files from the examples:

```bash
cp .env.example .env
cp apps/api/.dev.vars.example apps/api/.dev.vars
cp apps/web/.env.example apps/web/.env
```

### 1. Root `.env`

Used for shared local values and by `doItAll.sh`.

```dotenv
OPENROUTER_API_KEY=
INITIATE_MNEMONIC=
```

Notes:

- `OPENROUTER_API_KEY`: required for agent analysis. A free OpenRouter account works, but free limits are hit sooner. Accounts with at least `$10` credit usually get higher free-model limits.
- `INITIATE_MNEMONIC`: use a common local test mnemonic if you want repeatable local setup. Example format:

```dotenv
INITIATE_MNEMONIC=test test test test test test test test test test test junk
```

### 2. `apps/api/.dev.vars`

Local secrets for Wrangler dev:

```dotenv
KEY_ENCRYPTION_SECRET=
INITIA_EVM_CHAIN_ID=
INITIA_AGENT_CONTRACT_ADDRESS=
MOCK_PERP_DEX_ADDRESS=
INITIA_EXECUTOR_PRIVATE_KEY=
```

This file also needs `OPENROUTER_API_KEY`. The example file already includes it, plus `INITIA_EVM_RPC`.

Recommended shape:

```dotenv
INITIA_EVM_RPC=http://localhost:8545
OPENROUTER_API_KEY=
KEY_ENCRYPTION_SECRET=
INITIA_EVM_CHAIN_ID=
INITIA_AGENT_CONTRACT_ADDRESS=
MOCK_PERP_DEX_ADDRESS=
INITIA_EXECUTOR_PRIVATE_KEY=
```

What these values mean:

- `KEY_ENCRYPTION_SECRET`: 64-character hex string used by the API to encrypt stored user keys.
- `INITIA_EVM_CHAIN_ID`: your Initia EVM chain id.
- `INITIA_AGENT_CONTRACT_ADDRESS`: deployed `Agent.sol` address.
- `MOCK_PERP_DEX_ADDRESS`: deployed `MockPerpDEX` address.
- `INITIA_EXECUTOR_PRIVATE_KEY`: private key of the executor account used by the API.

### 3. `apps/web/.env`

Frontend runtime values:

```dotenv
NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS=
NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS=
NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS=
NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS=
NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS=
NUXT_PUBLIC_INITIA_SHOWCASE_TARGET_ADDRESS=
```

In practice you will usually also want these when using a non-default local chain:

```dotenv
NUXT_PUBLIC_INITIA_ROLLUP_CHAIN_ID=
NUXT_PUBLIC_INITIA_EVM_CHAIN_ID=
NUXT_PUBLIC_INITIA_EVM_RPC=http://localhost:8545
NUXT_PUBLIC_INITIA_RPC_URL=http://localhost:26657
NUXT_PUBLIC_INITIA_REST_URL=http://localhost:1317
```

What these values mean:

- `NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS`: deployed `Agent.sol` address.
- `NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS`: deployed `IUSDDemoToken` address.
- `NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS`: deployed `IUSDDemoFaucet` address.
- `NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS`: deployed `MockPerpDEX` address.
- `NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS`: public address of the executor account.
- `NUXT_PUBLIC_INITIA_SHOWCASE_TARGET_ADDRESS`: call target used in the showcase flow. For local setup this is usually the same as `MockPerpDEX`.

## Deploy Contracts

Deploy from [`contracts`](./contracts). The repo contains:

- `Agent.sol`
- `IUSDDemoToken.sol`
- `IUSDDemoFaucet.sol`
- `MockPerpDEX`

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

Map the deployment outputs into env vars like this:

| Deployment output | Put it into |
|---|---|
| `Agent` address | `INITIA_AGENT_CONTRACT_ADDRESS`, `NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS` |
| `IUSDDemoToken` address | `NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS` |
| `IUSDDemoFaucet` address | `NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS` |
| `MockPerpDEX` address | `MOCK_PERP_DEX_ADDRESS`, `NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS`, `NUXT_PUBLIC_INITIA_SHOWCASE_TARGET_ADDRESS` |
| Executor wallet private key | `INITIA_EXECUTOR_PRIVATE_KEY` |
| Executor wallet address | `NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS` |
| Your chain id | `INITIA_EVM_CHAIN_ID`, `NUXT_PUBLIC_INITIA_EVM_CHAIN_ID` |

## Install And Run

From the repo root:

```bash
pnpm install
```

Start the API:

```bash
pnpm run dev:api
```

In a second terminal, start the web app:

```bash
pnpm run dev:web
```

Then open the local web URL and connect with InterwovenKit.

## Minimal Manual Flow

If you already have your own local Initia appchain, the shortest working flow is:

1. Copy the example env files.
2. Put `OPENROUTER_API_KEY` and `INITIATE_MNEMONIC` into root `.env`.
3. Deploy the contracts to your own local Initia EVM appchain.
4. Put the contract addresses, executor key, chain id, and RPC values into `apps/api/.dev.vars` and `apps/web/.env`.
5. Run `pnpm run dev:api`.
6. Run `pnpm run dev:web`.

## References

- Detailed local setup: [`docs/LOCAL_SETUP.md`](./docs/LOCAL_SETUP.md)
- Contract details: [`contracts/README.md`](./contracts/README.md)
- One-shot local bootstrap: [`doItAll.sh`](./doItAll.sh)