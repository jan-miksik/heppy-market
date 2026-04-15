# initRoot

AI-assisted trading agents on an Initia EVM appchain.

## Local Run

### Prerequisites
- nodejs 20+ (https://nodejs.org/en/download/)
- pnpm (https://pnpm.io/)
- foundry (https://book.getfoundry.sh/)
- docker (https://www.docker.com/)

If you want the shortest path, use `./prepareAllForLocalRun.sh`
Use `--skip-chain` if your local Initia appchain is already running.
Use `--skip-contracts` only if you already deployed the contracts and already filled the env files with the correct addresses.

To run the project locally you need:

1. A running Initia EVM appchain. (see https://docs.initia.xyz/hackathon/get-started)
2. The project contracts deployed to that appchain.
3. Filled local envs files with openrouter api key and other values. (see `.env.example`, `apps/api/.dev.vars.example` and `apps/web/.env.example`)
4. Install dependencies, then start the API and web apps from the repo root.
  `pnpm install`
  `pnpm run dev:api` (run the api in a separate terminal)
  `pnpm run dev:web` (run the web app in a separate terminal)

If you already have your own local Initia appchain, you can use it too. The app is not hard-coupled to one specific local chain name, but you must deploy the contracts on your chain and update the env vars to match your chain and deployed addresses.

For manual setup see [MANUAL_SETUP.md](./docs/MANUAL_SETUP.md)
