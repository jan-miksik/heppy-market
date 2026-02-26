# Heppy Market — DEX Paper Trading Agents Platform

A fully functional platform for creating and running AI-powered paper trading agents on Base chain DEXes.

---

## What It Does

Users create trading agents that simulate trades using real market data from DexScreener. Each agent uses an LLM (via OpenRouter free tier) to analyze markets, make trade decisions, track performance, and log reasoning — all without touching real funds.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Cloudflare Workers + Hono |
| Frontend | Nuxt 4 (SPA, Cloudflare Pages) |
| Database | Cloudflare D1 (SQLite) + Drizzle ORM |
| Cache | Cloudflare KV |
| Agent State | Cloudflare Durable Objects |
| Scheduling | Cron Triggers + DO Alarms |
| LLM | Vercel AI SDK + OpenRouter (free models) |
| Price Data | DexScreener API (free, no key) |
| Technical Analysis | `technicalindicators` npm package |
| Validation | Zod |
| Monorepo | Turborepo |

---

## Project Structure

```
heppy-market/
├── apps/
│   ├── api/          # Cloudflare Workers + Hono backend
│   └── web/          # Nuxt 4 frontend
└── packages/
    └── shared/       # Shared types & Zod schemas
```

### Backend (`apps/api`)

```
src/
├── index.ts                  # App entry, route registration, cron handler
├── agents/
│   ├── trading-agent.ts      # Durable Object (agent state + lifecycle)
│   ├── agent-loop.ts         # Analysis → Decision → Execute loop
│   └── prompts.ts            # System prompts per autonomy level
├── routes/
│   ├── agents.ts             # CRUD + start/stop/pause/reset
│   ├── trades.ts             # Trade history & aggregate stats
│   ├── pairs.ts              # DEX pair search (cached)
│   └── comparison.ts         # Agent comparison metrics
├── services/
│   ├── llm-router.ts         # OpenRouter integration, structured output
│   ├── paper-engine.ts       # Trade execution, PnL, slippage simulation
│   ├── dex-data.ts           # DexScreener API client + KV cache
│   ├── indicators.ts         # RSI, EMA, MACD, Bollinger Bands
│   ├── snapshot.ts           # Win rate, Sharpe ratio, max drawdown
│   └── gecko-terminal.ts     # Alternative price data source
└── db/
    ├── schema.ts             # Drizzle table definitions
    └── migrations/           # D1 SQL migrations
```

### Frontend (`apps/web`)

```
pages/
├── index.vue                 # Dashboard (stats, active agents, recent trades)
├── agents/
│   ├── index.vue             # Agent list + create modal
│   └── [id].vue              # Agent detail (status, trades, charts, decisions)
└── trades/
    └── index.vue             # Full trade history with filters

components/
├── AgentCard.vue             # Agent card with start/stop controls
├── AgentConfigForm.vue       # Full config form (20+ options)
├── TradeTable.vue            # Sortable trade list
├── PnLChart.vue              # Cumulative P&L chart (Chart.js)
├── DexChart.vue              # DEX pair visualization
└── PairPicker.vue            # Multi-select pair picker
```

---

## Database Schema

| Table | Purpose |
|---|---|
| `agents` | Agent metadata, config (JSON), status |
| `trades` | Open/closed positions with PnL, reasoning |
| `agent_decisions` | Every LLM call logged (latency, tokens, market snapshot) |
| `performance_snapshots` | Periodic metrics (win rate, Sharpe, drawdown) |

---

## API Routes

```
GET/POST   /api/agents              # List / create agents
GET/PATCH/DELETE /api/agents/:id   # Get / update / delete agent
POST       /api/agents/:id/start   # Start agent loop
POST       /api/agents/:id/stop    # Stop agent
POST       /api/agents/:id/pause   # Pause agent
POST       /api/agents/:id/reset   # Reset balance & history

GET        /api/agents/:id/trades       # Trade history
GET        /api/agents/:id/decisions    # LLM decision log
GET        /api/agents/:id/performance  # Performance snapshots

GET        /api/trades             # All trades (filterable)
GET        /api/trades/stats       # Aggregate statistics
GET        /api/pairs/search?q=    # Search DEX pairs (cached)
GET        /api/compare            # Agent comparison metrics
GET        /api/models             # Available OpenRouter models
GET        /api/health             # Health check
```

---

## Agent Configuration

Key options per agent:

| Config | Default | Range |
|---|---|---|
| Paper balance | $10,000 USDC | $100–$1M |
| Autonomy level | `guided` | `full` / `guided` / `strict` |
| Analysis interval | `15m` | `1m`, `5m`, `15m`, `1h`, `4h`, `1d` |
| Trading pairs | WETH/USDC, cbBTC/WETH, AERO/USDC | Any DexScreener pair on Base |
| Max position size | 5% of balance | 1–100% |
| Stop loss | 5% | 0.5–50% |
| Take profit | 7% | 0.5–100% |
| Max open positions | 3 | 1–10 |
| LLM model | `nvidia/nemotron-...free` | Any OpenRouter model |
| Strategies | `combined` | EMA crossover, RSI, MACD, Bollinger, volume, LLM sentiment |

### Autonomy Levels

- **Full** — Agent picks pairs, adjusts strategies, sizes positions autonomously
- **Guided** — Agent analyzes and decides within user-defined bounds
- **Strict** — Rule-based only; LLM reports indicator signals, system executes

---

## Agent Loop

Each agent runs this cycle on its configured interval:

```
1. Wake up (Durable Object alarm)
2. Fetch market data (DexScreener → KV cache, 30s TTL)
3. Compute indicators (RSI, EMA, MACD, Bollinger)
4. Build LLM context (market data + indicators + open positions + history)
5. LLM decision (Vercel AI SDK → OpenRouter structured output)
6. Validate decision (against config bounds + risk limits)
7. Execute paper trade (if not hold)
8. Log decision to D1
9. Check risk limits (daily loss cap, cooldown)
10. Schedule next alarm
```

---

## Deployment

| Component | Target |
|---|---|
| API | Cloudflare Workers (edge, global) |
| Frontend | Cloudflare Pages (SPA, static) |
| Database | Cloudflare D1 |
| Cache | Cloudflare KV |
| Agent State | Cloudflare Durable Objects |

All infrastructure is Cloudflare-native — no external services required except OpenRouter for LLM.

---

## Environment Variables

```bash
# apps/api/.dev.vars
OPENROUTER_API_KEY=sk-or-v1-...
ANTHROPIC_API_KEY=sk-ant-...   # optional
```

---
