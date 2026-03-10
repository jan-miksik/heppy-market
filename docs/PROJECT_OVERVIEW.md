## Heppy Market – Project Overview

**Heppy Market** (monorepo name `dex-trading-agents`) is an AI‑assisted paper‑trading platform for DEXes on the Base chain.

- **Frontend (`apps/web`)**
  - **Nuxt 4 SPA** (no SSR) with Vue 3 `<script setup>` and TypeScript.
  - Uses Web3 wallet integration (Reown AppKit / web components).
  - Talks only to **same-origin `/api/*`**; it never calls a public Worker URL directly.

- **Backend API (`apps/api`)**
  - **Cloudflare Worker** written in TypeScript using **Hono**.
  - Exposes all trading and management endpoints under `/api/*`.
  - Uses **Drizzle ORM** and **D1** to store agents, trades, manager profiles, etc.
  - Integrates with **OpenRouter** (and optionally Anthropic) to run AI models that drive trading agents.
  - Uses **Durable Objects** for long‑lived agent/manager state and **cron triggers** for periodic analysis.

Overall architecture:

```text
User → Cloudflare Pages (Nuxt SPA)
     → Pages Functions (`server/api/[...path].ts`)
     → Service Binding `API`
     → Cloudflare Worker (internal)
     → D1 / KV / Durable Objects
```

The API Worker is **internal-only** (no public route); the browser only talks to the Pages origin.

---

## Cloudflare Features in Use

### 1. Cloudflare Pages (frontend hosting)

- Nuxt configured for **Cloudflare Pages** in `apps/web/nuxt.config.ts`:
  - `nitro.preset = 'cloudflare-pages'`
  - `compatibilityDate: '2026-02-17'`
- Deploy script from repository root (`package.json`):
  - `npm run deploy:web` → builds the web app and runs  
    `npx wrangler pages deploy dist --project-name=heppy-market`.
- **Pages Functions**:
  - `apps/web/server/api/[...path].ts` is a Nitro/Pages Function that:
    - Uses the **Cloudflare Service Binding** `API` when deployed on Pages (calls `cfEnv.API.fetch()`).
    - Falls back to `API_BASE_URL` (e.g. `http://localhost:8787`) in local development.

### 2. Cloudflare Workers (backend API)

- Main Worker lives in `apps/api`:
  - Entry: `src/index.ts` exporting `fetch` and `scheduled` handlers.
  - Framework: **Hono** for routing and middleware.
  - Implements all `/api/*` endpoints (health, auth, agents, trades, managers, profiles, models list, etc.).
- Wrangler configuration in `apps/api/wrangler.toml`:
  - `name = "dex-trading-agents-api"`
  - `main = "dist/worker.js"`
  - `compatibility_date = "2026-02-12"`
  - `compatibility_flags = ["nodejs_compat"]`
- Build pipeline from monorepo root (root `package.json`):
  - `build:worker` bundles `apps/api/src/index.ts` with esbuild for the Workers runtime.

### 3. D1 (Cloudflare’s SQLite database)

- `apps/api/wrangler.toml` defines **D1 bindings**:
  - Local:
    - `[[d1_databases]] binding = "DB"`, `database_name = "trading-agents"`, `database_id = "local-trading-agents"`.
  - Production (`[env.production]`):
    - `[[env.production.d1_databases]] binding = "DB"` with a real `database_id`.
- `apps/api/src/index.ts` uses `drizzle-orm/d1` with `env.DB` and migrations in `src/db/migrations`.

### 4. KV (Cloudflare KV for caching)

- KV namespace in `apps/api/wrangler.toml`:
  - Local: `[[kv_namespaces]] binding = "CACHE"`, `id = "local-cache"`.
  - Production: `[[env.production.kv_namespaces]] binding = "CACHE"` with the production namespace id.
- The API uses `env.CACHE` (e.g. in `services/llm-router.ts`) to cache metadata such as model lists from OpenRouter.

### 5. Durable Objects (stateful agents & managers)

- Durable Objects bindings in `apps/api/wrangler.toml`:
  - `[durable_objects].bindings`:
    - `TRADING_AGENT` → `TradingAgentDO`
    - `AGENT_MANAGER` → `AgentManagerDO`
  - Matching `[env.production.durable_objects]` for production.
  - Migrations declare SQLite‑backed DOs via `[[migrations]]` and `new_sqlite_classes`.
- `apps/api/src/index.ts`:
  - Exports DO classes: `TradingAgentDO`, `AgentManagerDO`.
  - Cron handler uses `env.TRADING_AGENT` to run analysis in the appropriate DO instances.

### 6. Cron Triggers (scheduled Workers)

- `apps/api/wrangler.toml`:
  - `[triggers] crons = [...]` registers five schedules:
    - `*/5 * * * *` (every 5 minutes)
    - `*/15 * * * *` (every 15 minutes)
    - `0 * * * *` (hourly)
    - `0 */4 * * *` (every 4 hours)
    - `0 0 * * *` (daily)
- `apps/api/src/index.ts` scheduled handler:
  - Logs which cron fired.
  - For hourly cron (`0 * * * *`), runs `snapshotAllAgents(env)`.
  - For all crons, queries D1 for running agents, filters by `analysisInterval`, and tells the appropriate Durable Objects to perform analysis.

### 7. Service Bindings (internal-only API)

- Service binding from Pages → Worker (see `docs/DEPLOY.md` and `apps/web/wrangler.toml`):
  - `[[services]] binding = "API"`, `service = "dex-trading-agents-api"`.
- Pages Function (`apps/web/server/api/[...path].ts`) expects `event.context.cloudflare.env.API`:
  - When present (production on Pages), requests are routed internally:
    - Browser → Pages → Pages Function → `API.fetch` → Worker → D1/KV/DO.
  - When absent (local dev), traffic is proxied to `API_BASE_URL`.
- Result: the Worker is **only reachable from the Pages project**, not via a public route.

### 8. Cloudflare Tooling & Testing

- Root `devDependencies` include **`wrangler`** for building and deploying Workers and Pages.
- `apps/api/package.json`:
  - Uses `@cloudflare/workers-types` for strong typing against the Workers runtime.
  - Uses `@cloudflare/vitest-pool-workers` and `vitest` for Worker‑aware tests.

---

## TL;DR

- **Frontend**: Nuxt SPA on **Cloudflare Pages**, with a Pages Function proxy and Service Binding to the API Worker.
- **Backend**: Hono‑based **Cloudflare Worker** using **D1**, **KV**, **Durable Objects**, and **cron triggers**.
- **Security model**: API is **internal-only**; the browser talks only to the Pages origin, and Cloudflare’s internal Service Binding handles communication to the Worker.
