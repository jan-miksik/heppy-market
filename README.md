## Initia Hackathon Submission

- **Project Name**: initRoot

### Project Overview

initRoot is an AI trading agents platform that runs autonomously on an Initia EVM appchain. You deposit funds into an onchain vault, configure agent or select from pre-defined agents, and then let it trade on your behalf — the agent analyses market data, makes decisions, and executes them within the limits you set.

### Implementation Detail

- **Custom onchain Agent contract** (`contracts/src/Agent.sol`) — handles multi-agent vaults, per-agent executor approvals, target contract whitelisting, native and ERC-20 accounting, and pause controls.

- **InterwovenKit React island embedded in the Nuxt frontend** — lets users move assets from other Initia chains directly into the app without leaving the page. The island is a React component mounted inside the Vue/Nuxt app, using Initia's InterwovenKit for interwoven transfers and bridging.


### How to Run Locally

#### Prerequisites
- nodejs 20+ (https://nodejs.org/en/download/)
- pnpm (https://pnpm.io/)
- Foundry (`forge` + `cast`) — install via https://getfoundry.sh
- `weave` — for spinning up a local Initia appchain. Follow the Initia hackathon setup guide: https://docs.initia.xyz/hackathon/get-started

#### First run (nothing set up yet)

1. Copy `.env.example` to `.env` at the repo root.
2. Set `OPENROUTER_API_KEY=your-key` (get a free key at https://openrouter.ai).
3. Add your deployer key — either `PRIVATE_KEY=0x...` or `INITIATE_MNEMONIC="word1 word2 ..."`.
4. Run:
   ```bash
   chmod +x setupLocalAndStart.sh
   ./setupLocalAndStart.sh
   ```

The script installs dependencies, starts a local Initia chain, deploys all three contracts (Agent, iUSD demo token + faucet, MockPerpDEX), writes the env files for both apps, applies DB migrations, and starts everything. When it's done you'll see:

Flags:

- `--skip-chain`: use an already running chain at `INITIA_RPC_URL` / `INITIA_EVM_RPC` or the defaults `http://localhost:26657` and `http://localhost:8545`
- `--skip-contracts`: use already deployed contracts and the existing `apps/web/.env`

- Web → http://localhost:3001
- API → http://localhost:8787

#### Subsequent runs (chain and contracts already deployed)

run api with `pnpm dev:api`
run web with `pnpm dev:web`

For manual step-by-step setup see [MANUAL_SETUP.md](./docs/MANUAL_SETUP.md)

### Tech Stack

- Initia InterwovenKit React island embedded in a Nuxt app
- Frontend: Nuxt 4, Vue 3, TypeScript
- Backend: Hono on Cloudflare Workers
- Storage / state: D1, KV, Durable Objects, Cloudflare Queues
- AI layer: OpenRouter, PCKE
