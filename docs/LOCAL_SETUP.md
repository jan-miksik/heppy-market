# Local Setup Guide

> **Assumes:** you already have `pillow-rollup` (Initia EVM appchain) running locally.
> If you need to start it from scratch, run `./doItAll.sh` instead.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 | https://nodejs.org |
| pnpm | 10.x | `npm install -g pnpm` |
| Foundry (`forge` + `cast`) | latest | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| wrangler | bundled | comes from devDependencies — `npx wrangler` works |
| jq | any | `brew install jq` |
| minitiad | EVM build | `weave` installs it, or build from https://github.com/initia-labs/minievm |

---

## Step 1 — Clone and install

```bash
git clone https://github.com/jan-miksik/heppy-market
cd heppy-market
pnpm install
```

---

## Step 2 — Verify the chain is healthy

```bash
curl -s http://localhost:26657/status | jq '.result.node_info.network'
# expected: "pillow-rollup"

curl -s http://localhost:26657/status | jq '.result.sync_info.catching_up'
# expected: false
```

Default ports used by this project:

| Endpoint | Default |
|----------|---------|
| EVM JSON-RPC | `http://localhost:8545` |
| Tendermint RPC | `http://localhost:26657` |
| Cosmos REST | `http://localhost:1317` |

If you used different ports, override them via env vars (see Step 4).

---

## Step 3 — Get a funded deployer key

You need an EVM private key whose address holds GAS on `pillow-rollup`.

**Option A — derive from your existing mnemonic:**

```bash
# Replace with your 12/24-word mnemonic
cast wallet private-key --mnemonic "word1 word2 ... word12"
```

**Option B — use the weave gas-station key:**

```bash
MNEMONIC=$(jq -r '.common.gas_station.mnemonic' ~/.weave/config.json)
PRIVATE_KEY=$(cast wallet private-key --mnemonic "$MNEMONIC")
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "Deployer: $DEPLOYER"
```

**Check balance:**

```bash
cast balance "$DEPLOYER" --rpc-url http://localhost:8545
# Should be > 0 (18-decimal GAS, so 1 GAS = 1000000000000000000)
```

If balance is 0, fund it first:

```bash
minitiad tx bank send gas-station "$DEPLOYER" 100000000000000000000GAS \
  --keyring-backend test --chain-id pillow-rollup \
  --node http://localhost:26657 -y
```

---

## Step 4 — Deploy contracts

All three contracts are deployed independently. Run from `contracts/`.

```bash
cd contracts
```

### 4a. Agent.sol (core vault)

```bash
PRIVATE_KEY=0x<your-key> forge script script/DeployAgent.s.sol:DeployAgent \
  --rpc-url http://localhost:8545 --broadcast --slow
```

Note the address logged as `Agent deployed at: 0x...`.

### 4b. iUSD Demo Token + Faucet

```bash
PRIVATE_KEY=0x<your-key> forge script script/DeployIUSDDemo.s.sol:DeployIUSDDemo \
  --rpc-url http://localhost:8545 --broadcast --slow
```

Note:
- `iUSD-demo token deployed at: 0x...`
- `iUSD-demo faucet deployed at: 0x...`

### 4c. MockPerpDEX (uses iUSD as collateral)

Pass the iUSD token address from 4b:

```bash
PRIVATE_KEY=0x<your-key> \
IUSD_TOKEN_ADDRESS=0x<iusd-token-from-4b> \
  forge script script/DeployMockPerpDEX.s.sol:DeployMockPerpDEX \
  --rpc-url http://localhost:8545 --broadcast --slow
```

Note: `MockPerpDEX deployed at: 0x...`

```bash
cd ..
```

---

## Step 5 — Configure environment files

### 5a. `apps/web/.env`

Create or edit the file:

```bash
cat > apps/web/.env <<EOF
REOWN_PROJECT_ID=0d1af33ea5d0930355178d3d8c820785
PLAYWRIGHT_SECRET=playwright-dev-secret

# Paste addresses from Step 4
NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS=0x<AGENT_ADDRESS>

NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS=0x<IUSD_TOKEN>
NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS=0x<IUSD_FAUCET>

NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS=0x<PERP_DEX>

# Executor = your deployer address for local dev
NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS=0x<YOUR_EVM_ADDRESS>

# Showcase target = MockPerpDEX for local dev
NUXT_PUBLIC_INITIA_SHOWCASE_TARGET_ADDRESS=0x<PERP_DEX>

NUXT_PUBLIC_INITIA_EXECUTOR_MAX_TRADE_WEI=1000000000000000000
NUXT_PUBLIC_INITIA_EXECUTOR_DAILY_LIMIT_WEI=5000000000000000000
EOF
```

Override chain endpoints only if you changed default ports:

```bash
# Optional — only needed if your chain uses non-default ports
NUXT_PUBLIC_INITIA_EVM_RPC=http://localhost:8545
NUXT_PUBLIC_INITIA_REST_URL=http://localhost:1317
NUXT_PUBLIC_INITIA_RPC_URL=http://localhost:26657
```

### 5b. Root `.env` (API key)

```bash
# .env at repo root — used by doItAll.sh; not read by wrangler dev directly
OPENROUTER_API_KEY=sk-or-v1-<your-key>
```

Get a free key at https://openrouter.ai → Dashboard → API Keys.

### 5c. `apps/api/.dev.vars` (wrangler local secrets)

Wrangler reads this file automatically in `wrangler dev`. **Never commit this file.**

```bash
cat > apps/api/.dev.vars <<EOF
OPENROUTER_API_KEY=sk-or-v1-<your-key>
PLAYWRIGHT_SECRET=playwright-dev-secret
EOF
```

---

## Step 6 — Initialize the local database

Apply all D1 migrations to the local SQLite database that Wrangler uses for dev:

```bash
cd apps/api
pnpm migration:apply:local --yes
cd ../..
```

This runs every migration in `apps/api/src/db/migrations/` against the local D1 store. It is idempotent — safe to run again.

---

## Step 7 — Run the API

```bash
# Terminal 1
pnpm dev:api
# Starts Wrangler dev on http://localhost:8787
```

Verify:

```bash
curl -s http://localhost:8787/api/health
# {"status":"ok"}
```

---

## Step 8 — Run the web frontend

```bash
# Terminal 2
pnpm dev:web
# Starts Nuxt dev on http://localhost:3001
```

Open http://localhost:3001 in your browser.

---

## Verification checklist

- [ ] Chain: `curl -s http://localhost:26657/status | jq '.result.sync_info.latest_block_height'` increments
- [ ] API: `curl -s http://localhost:8787/api/health` → `{"status":"ok"}`
- [ ] Web: http://localhost:3001 loads without errors
- [ ] Connect wallet via InterwovenKit (click Connect) — resolves to `pillow-rollup`
- [ ] Create an agent → it saves to D1 (visible at `GET http://localhost:8787/api/agents`)
- [ ] Start the agent → it triggers an LLM analysis (check console for any OpenRouter errors)

---

## Environment variable reference

### `apps/web/.env`

| Variable | Description | Example |
|----------|-------------|---------|
| `NUXT_PUBLIC_INITIA_CONTRACT_ADDRESS` | Agent.sol address | `0x2f96...` |
| `NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS` | iUSD demo token | `0x399e...` |
| `NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS` | iUSD faucet | `0xafb6...` |
| `NUXT_PUBLIC_INITIA_MOCK_PERP_DEX_ADDRESS` | MockPerpDEX | `0x782b...` |
| `NUXT_PUBLIC_INITIA_EXECUTOR_ADDRESS` | EOA authorised to run agent ticks | `0x9ac7...` |
| `NUXT_PUBLIC_INITIA_SHOWCASE_TARGET_ADDRESS` | Whitelisted call target in Agent | `0x3296...` |
| `NUXT_PUBLIC_INITIA_EXECUTOR_MAX_TRADE_WEI` | Per-trade cap in wei (1 GAS = 1e18) | `1000000000000000000` |
| `NUXT_PUBLIC_INITIA_EXECUTOR_DAILY_LIMIT_WEI` | Daily GAS cap in wei | `5000000000000000000` |
| `NUXT_PUBLIC_INITIA_EVM_RPC` | EVM JSON-RPC URL (default `http://localhost:8545`) | — |
| `NUXT_PUBLIC_INITIA_RPC_URL` | Tendermint RPC (default `http://localhost:26657`) | — |
| `NUXT_PUBLIC_INITIA_REST_URL` | Cosmos REST (default `http://localhost:1317`) | — |
| `REOWN_PROJECT_ID` | WalletConnect project ID | `0d1af3...` |

### `apps/api/.dev.vars`

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Required — used by every agent analysis cycle |
| `PLAYWRIGHT_SECRET` | Dev/test only — enables `GET /dev-login` for Playwright |

---

## Troubleshooting

**`pnpm install` fails with workspace errors**
Make sure you are running it from the repo root, not inside a sub-package.

**`forge script` fails with "nonce too low"**
Add `--slow` to the forge command. The chain may need a moment between broadcasts.

**`wrangler dev` fails with "Cannot find module dist/worker.js"**
The worker is compiled by wrangler on first run — this usually self-resolves. If it persists:
```bash
pnpm build:worker
pnpm dev:api
```

**Migrations already applied warning**
Safe to ignore — D1 migrations are idempotent.

**Agent analysis returns errors about OpenRouter**
Check `apps/api/.dev.vars` has a valid `OPENROUTER_API_KEY`. Free-tier keys work fine.

**Web shows "Chain not found" in InterwovenKit wallet**
The `customChain` config in `apps/web/plugins/` is hardcoded to `pillow-rollup`. Ensure your chain is running with that chain ID. Check with:
```bash
curl -s http://localhost:26657/status | jq '.result.node_info.network'
```
