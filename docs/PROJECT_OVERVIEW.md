## initRoot – Project Overview

## TL;DR

- **Frontend**: Nuxt SPA on **Cloudflare Pages**, with a Pages Function proxy and Service Binding to the API Worker.
- **Backend**: Hono‑based **Cloudflare Worker** using **D1**, **KV**, **Durable Objects**, and **cron triggers**.
- **Shared**: Single `packages/shared` package owns all validation schemas and prompt-builder functions — used by API and frontend.
- **Security model**: API is **internal-only**; the browser talks only to the Pages origin, and Cloudflare's internal Service Binding handles communication to the Worker.



**initRoot** (monorepo name `initRoot`) is an AI‑assisted paper‑trading platform for DEXes.

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

- **Shared package (`packages/shared`)**
  - Exports validation schemas (`AgentConfigSchema`, `SelfModificationSchema`, etc.) used by both frontend and backend.
  - Exports prompt builders (`BASE_AGENT_PROMPT`, `buildJsonSchemaInstruction`, `buildBehaviorSection`, `buildConstraintsSection`) — consumed by the agent loop, the API prompt-preview endpoint, and the frontend edit page for live preview.

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
    `npx wrangler pages deploy dist --project-name=something-in-loop`.
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
  - `name = "something-in-loop-api"`
  - `main = "dist/worker.js"`
  - `compatibility_date = "2026-02-12"`
  - `compatibility_flags = ["nodejs_compat"]`
- Build pipeline from monorepo root (root `package.json`):
  - `build:worker` bundles `apps/api/src/index.ts` with esbuild for the Workers runtime.

### 3. D1 (Cloudflare's SQLite database)

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
    - `0 * * * *` (hourly)
    - `0 */4 * * *` (every 4 hours)
    - `0 0 * * *` (daily)
- `apps/api/src/index.ts` scheduled handler:
  - Logs which cron fired.
  - For hourly cron (`0 * * * *`), runs `snapshotAllAgents(env)`.
  - For all crons, queries D1 for running agents, filters by `analysisInterval`, and tells the appropriate Durable Objects to perform analysis.

### 7. Service Bindings (internal-only API)

- Service binding from Pages → Worker (see `docs/DEPLOY.md` and `apps/web/wrangler.toml`):
  - `[[services]] binding = "API"`, `service = "something-in-loop-api"`.
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
- **Playwright e2e** (`e2e/`, `playwright.config.ts`):
  - `global.setup.ts` authenticates via `GET /dev-login` (dev/test-only Pages Function that creates a server-side session without wallet signing).
  - `smoke.spec.ts` — page-load and navigation smoke tests.
  - `persona.spec.ts` — agent persona edit + prompt-preview integration tests.
  - `apps/web/server/routes/dev-login.get.ts` — dev-only Nitro route; disabled in production.

---

## Key Subsystems

### Agent Loop (`apps/api/src/agents/agent-loop.ts`)

Called by `TradingAgentDO.alarm()` on each scheduled tick. Full flow:

1. Load + migrate agent config from D1 (clamps out-of-range LLM-generated values, upgrades legacy interval strings).
2. Drain any `pendingTrade` from DO storage (durability: if D1 write failed last tick, retry now).
3. Check daily loss limit and cooldown — pause agent or skip tick if triggered.
4. Check open positions for stop-loss / take-profit using `price-resolver.ts`. Tracks consecutive price-miss counter; alerts after 3 misses.
5. Fetch OHLCV market data: **GeckoTerminal** primary → **DexScreener** fallback → **well-known token address** last resort. Fetches **hourly (48 candles) and daily (30 candles) in parallel**.
6. Compute technical indicators: hourly RSI, EMA9/21, MACD, Bollinger Bands when ≥14 candles; daily RSI/EMA/Bollinger for trend context when daily data is available.
7. Call LLM (`getTradeDecision`) via OpenRouter or Anthropic (only for tester-role users). Supports per-user OpenRouter key (stored encrypted in D1).
8. Log decision to `agentDecisions` table (includes raw prompt + raw response for debugging).
9. Handle self-modification suggestions (gated by autonomy level and confidence/cooldown checks).
10. Execute paper trade via `PaperEngine` if confidence ≥ 0.65 and position limits allow.

### Self-Modification System

Agents can suggest changes to themselves (persona, behavior, and — if `full` autonomy — hard config):
- LLM returns optional `selfModification` field in the trade decision JSON.
- Validated against `SelfModificationSchema` (shared package).
- Gated by: confidence ≥ 0.6, cooldown cycles, and autonomy level.
- `guided` autonomy: can modify `personaMd`, `behavior`, and `roleMd`, not hard config.
- `full` autonomy: can also modify `stopLossPct`, `takeProfitPct`, `maxPositionSizePct`.
- `autoApplySelfModification: true` → applied immediately; otherwise status = `pending`, user must approve via API.
- API endpoints for user review: `GET/POST /api/agents/:id/self-modifications`, `.../approve`, `.../reject`.

### Agent Edit Page (`apps/web/pages/agents/[id]/edit.vue`)

Full-featured two-panel edit UI:
- **Sticky command bar**: breadcrumb + running-badge + Cancel/Save actions (Save targets the form's `form` attribute).
- **Left panel**: `AgentConfigForm` with `hide-persona-editor` and `hide-footer` flags (persona editing is in the right panel).
- **Right panel – Prompt Preview**:
  - **[SYSTEM]** collapsible pill: live-computed from `BASE_AGENT_PROMPT + buildJsonSchemaInstruction(autonomyLevel)` — updates immediately when autonomy level changes in the form.
  - **[MARKET DATA]** collapsible pill: API-fetched from `GET /api/agents/:id/prompt-preview`, refreshable.
  - **[EDITABLE SETUP]** always-visible block with live preview: behavior section (auto-generated or custom markdown), persona section, constraints section. Toggle to edit mode for inline textarea editing with auto-resize, Reset buttons, and Custom/auto-generated badges.
- Optimistic version conflict: PATCH includes `_version` (agent's `updatedAt`); server returns 409 on conflict.
- **Prompt-preview parity**: `GET /api/agents/:id/prompt-preview` builds the prompt identically to the agent-loop — includes `roleMd`, persona fallback chain (`personaMd` column → config blob → profile template → default), matching what the LLM actually receives.

### API Endpoints (agents)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | List agents owned by auth user |
| POST | `/api/agents` | Create agent |
| GET | `/api/agents/:id` | Get agent |
| PATCH | `/api/agents/:id` | Update agent config (supports `_version` optimistic lock) |
| DELETE | `/api/agents/:id` | Delete agent + all related data |
| POST | `/api/agents/:id/start` | Start agent (wakes DO) |
| POST | `/api/agents/:id/stop` | Stop agent |
| POST | `/api/agents/:id/pause` | Pause agent |
| POST | `/api/agents/:id/reset` | Reset paper balance |
| POST | `/api/agents/:id/analyze` | Manual analysis trigger |
| GET | `/api/agents/:id/status` | Live DO status |
| GET | `/api/agents/:id/trades` | Trade history |
| GET | `/api/agents/:id/decisions` | Decision log |
| GET | `/api/agents/:id/performance` | Performance snapshots |
| GET | `/api/agents/:id/persona` | Get persona markdown |
| PUT | `/api/agents/:id/persona` | Set persona markdown |
| POST | `/api/agents/:id/persona/reset` | Reset persona to profile template |
| GET | `/api/agents/:id/prompt-preview` | Build full prompt from last market snapshot |
| GET | `/api/agents/:id/self-modifications` | List self-modification suggestions |
| POST | `/api/agents/:id/self-modifications/:modId/approve` | Apply a pending modification |
| POST | `/api/agents/:id/self-modifications/:modId/reject` | Reject a pending modification |

### LLM Routing (`apps/api/src/services/llm-router.ts`)

- Uses Vercel AI SDK with `generateObject` + Zod schema for structured output.
- Routes to **Anthropic** if model starts with `claude-` and `ANTHROPIC_API_KEY` is set (tester-role only).
- Routes to **OpenRouter** for all other models; resolves per-user encrypted OR key from D1, falls back to server key.
- `buildJsonSchemaInstruction(autonomyLevel)` (shared package) appends the response schema to the system prompt; `selfModification` field varies by autonomy level.

### Shared Package (`packages/shared`)

Exports consumed by both API and frontend:
- **Validation schemas**: `AgentConfigSchema` (default `analysisInterval: '1h'`; optional `roleMd` field up to 4 000 chars), `SelfModificationSchema`, `TradeDecisionSchema`, `CreateAgentRequestSchema`, `UpdateAgentRequestSchema`, `ManagerConfigSchema`, `CreateBehaviorProfileSchema`, `UpdatePersonaSchema`, persona template helpers.
- **Prompt builders**: `BASE_AGENT_PROMPT`, `buildJsonSchemaInstruction`, `buildBehaviorSection`, `buildConstraintsSection` — single source of truth for agent prompt construction.
- **Persona helpers**: `getAgentPersonaTemplate`, `getDefaultAgentPersona` — used by both agent-loop and prompt-preview to apply the same fallback chain.

### Services

| File | Purpose |
|------|---------|
| `gecko-terminal.ts` | Primary OHLCV source — pool search + price series (48 hourly + 30 daily candles) |
| `dex-data.ts` | DexScreener fallback — pair search + token address lookup |
| `price-resolver.ts` | Resolves current price for open position SL/TP checks |
| `paper-engine.ts` | PaperEngine: open/close positions, P&L math, slippage simulation |
| `indicators.ts` | Technical indicators wrapping `technicalindicators` npm package |
| `snapshot.ts` | Periodic performance snapshot writes to D1 |
| `llm-router.ts` | LLM call routing, JSON extraction, fallback handling |

### Agent Utilities (`apps/api/src/agents/`)

| File | Purpose |
|------|---------|
| `resolve-agent-persona.ts` | Centralises persona resolution — 4-source precedence: `agents.personaMd` column → `config.personaMd` blob → profile template → default persona |

### Lib Utilities

| File | Purpose |
|------|---------|
| `auth.ts` | SIWE authentication + session management (security boundary) |
| `crypto.ts` | AES-GCM encryption/decryption for user API keys stored in D1 |
| `pairs.ts` | Pair name normalization (e.g. `ETH-USD` → `WETH/USDC`) |
| `rate-limit.ts` | Per-agent LLM call rate limiting |
| `utils.ts` | `generateId`, `nowIso`, `autonomyLevelToInt`, `intToAutonomyLevel` |
| `validation.ts` | Request body validation helper + `ValidationError` class |

---

## Frontend Route Structure

```text
apps/web/pages/
  agents/
    index.vue          — agent list
    new.vue            — create agent form
    [id]/
      index.vue        — agent detail / dashboard
      edit.vue         — agent config editor with live prompt preview
```

---

