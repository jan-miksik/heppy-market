# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Heppy Market is a DEX paper trading platform where users create AI-powered trading agents that simulate trades on Base chain DEXes. Agents run as Cloudflare Durable Objects, use LLMs (via OpenRouter free tier) to analyze markets, and execute paper trades with real price data from DexScreener.

## Commands

### Development
```bash
npm run dev:api          # Start Workers dev server on port 8787
npm run dev:web          # Start Nuxt dev server on port 3000
```
Run both in separate terminals. The web app proxies `/api/*` requests to the API via `apps/web/server/api/[...path].ts`.

### Build & Deploy
```bash
npm run build            # Build entire monorepo (Turbo)
npm run deploy:api       # Deploy API to Cloudflare Workers (production)
npm run deploy:web       # Build + deploy web to Cloudflare Pages
```

### Test & Lint
```bash
npm run test             # Run all tests (Vitest)
npm run test --workspace=apps/api  # Run API tests only
npm run lint             # TypeScript typecheck (nuxt typecheck)
```

### Database
```bash
# Apply migrations locally
wrangler d1 execute trading-agents --local --file=apps/api/src/db/migrations/<file>.sql

# Apply to production
wrangler d1 execute trading-agents --env production --file=apps/api/src/db/migrations/<file>.sql
```

## Architecture

### Monorepo Structure
```
apps/api/     # Cloudflare Workers + Hono (backend)
apps/web/     # Nuxt 4 SPA → Cloudflare Pages (frontend)
packages/shared/  # Zod schemas + TypeScript types shared between api and web
```

### Backend (`apps/api/src/`)

**Entry point:** `index.ts` — registers routes, exports `{ fetch, scheduled }` handlers.

**Cron handler** wakes Durable Objects on 5 schedules: `*/5`, `*/15`, `0 *`, `0 */4`, `0 0` (5m/15m/1h/4h/1d). The hourly cron also triggers performance snapshots.

**Agent lifecycle:**
1. Create via `POST /api/agents` (Zod-validated config stored in D1)
2. Start via `POST /api/agents/:id/start` — initializes `PaperEngine`, schedules first DO alarm
3. Each alarm fires `alarm()` in `trading-agent.ts` → calls `runAgentLoop()` → reschedules
4. Stop/pause via dedicated endpoints

**Agent loop** (`agents/agent-loop.ts`):
1. Load agent config from D1
2. Check risk limits (daily loss cap, cooldown after stop-out)
3. Check open positions for stop loss / take profit
4. For each pair: fetch price → compute indicators → call LLM → validate decision → execute paper trade → log to D1
5. Reschedule DO alarm

**Key services:**
- `services/llm-router.ts` — Vercel AI SDK + OpenRouter. Uses `generateObject` for structured trade decisions. Falls back through user model → fallback model → 5 emergency free models.
- `services/paper-engine.ts` — `PaperEngine` class manages balance, open/closed positions, slippage simulation, P&L calculation. Serializable for Durable Object storage.
- `services/dex-data.ts` — DexScreener API client with 60s KV cache. Provides pair search, price data, token lookup.
- `services/indicators.ts` — Wraps `technicalindicators` (pure JS, CF Workers safe): RSI(14), EMA(9,21), MACD(12,26,9), Bollinger(20), SMA(20).
- `services/gecko-terminal.ts` — Alternative/diagnostic price feed.
- `services/snapshot.ts` — Calculates and persists hourly performance metrics (win rate, Sharpe, max drawdown).

**Database** (`db/schema.ts` — Drizzle ORM + D1):
- `agents` — agent config (JSON blob in `config` column)
- `trades` — paper trade records with entry/exit prices, P&L, LLM reasoning
- `agentDecisions` — every LLM call logged with market snapshot
- `performanceSnapshots` — hourly metrics per agent

**Validation** — all external inputs go through Zod schemas in `packages/shared/src/validation.ts` and `lib/validation.ts`.

### Frontend (`apps/web/`)

Nuxt 4 SPA (`ssr: false`), deployed to Cloudflare Pages with `nitro.preset = 'cloudflare-pages'`.

API calls go through `server/api/[...path].ts` proxy → `http://localhost:8787` (dev) or production Workers URL (set via `API_BASE_URL` env var).

Key pages: `pages/index.vue` (dashboard), `pages/agents/index.vue` (list), `pages/agents/[id].vue` (detail + live status), `pages/trades/index.vue` (history).

### Shared Package (`packages/shared/src/`)
- `validation.ts` — `AgentConfigSchema` (Zod) with all agent config fields and defaults
- `types.ts` — TypeScript interfaces for `AgentConfig`, `Trade`, `DexPair`, etc.

## Key Patterns

**Durable Object state** — Agent runtime state (balance, open positions, status) lives in `ctx.storage` inside the DO. D1 stores persistent records. Never accumulate large state in DO memory.

**LLM structured output** — Always use `generateObject` with a Zod schema, never `generateText`. The `TradeDecisionSchema` requires `action`, `confidence`, `reasoning`.

**Paper engine slippage** — Buy: effective price = `entryPrice * (1 + slippagePct/100)`. Sell: effective price = `exitPrice * (1 - slippagePct/100)`. Default 0.3%.

**Agent config JSON** — The `config` column in `agents` table stores the full `AgentConfig` as a JSON string. Parse with `JSON.parse(agent.config) as AgentConfig`.

**KV cache pattern** — All DexScreener responses are cached with 60s TTL. LLM model list cached 1 hour. Cache key format: `dex:search:{query}` or `dex:pair:{chain}:{address}`.

**DO name convention** — Durable Objects are looked up by agent ID: `env.TRADING_AGENT.idFromName(agentId)`.

## Environment Variables

```bash
# apps/api/.dev.vars (local dev — not committed)
OPENROUTER_API_KEY=sk-or-v1-xxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxx   # optional

# Production secrets set via wrangler secret put
```

## Cloudflare Resources

- D1 database: `trading-agents`
- KV namespace: `CACHE`
- Durable Object: `TRADING_AGENT` (class `TradingAgentDO`)
- Workers: `dex-trading-agents-api`
- Pages project: `heppy-market`

## Rules That Apply Now (Paper Trading Phase)

- Agent state lives in Durable Objects, never KV
- Deduplicate DO alarm executions (check status before running loop)
- Validate all inputs with Zod at the Worker edge
- Rate limit outbound calls to DexScreener and OpenRouter
- Never leak internal error details to the frontend

## Task Execution Rules
- Before starting work, read PROGRESS.md and execution-plan.md
- Only work on the NEXT unchecked phase
- After completing a phase, mark it [x] in PROGRESS.md and commit
- After completing a phase, tell the user to run /clear