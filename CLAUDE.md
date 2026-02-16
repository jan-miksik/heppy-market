# DEX Paper Trading Agents — Build Prompt & Setup Guide

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [What You Need to Provide](#what-you-need-to-provide)
3. [Protocol Context: x402 & AP2](#protocol-context)
4. [Package Evaluation: ElizaOS & Alternatives](#package-evaluation)
5. [The Build Prompt (Cursor / Claude Code)](#build-prompt)
6. [Validation & Testing Strategy](#validation--testing)
7. [Default Agent Configuration](#default-agent-configuration)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Nuxt 4 Frontend                          │
│  Dashboard · Agent Creator · Trade History · Performance Charts │
│  Deploy: Cloudflare Pages (SSR)                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │ API calls
┌──────────────────────────▼──────────────────────────────────────┐
│                  Cloudflare Workers + Hono                       │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Agent API    │  │ Trade Engine │  │ LLM Router             │  │
│  │ CRUD agents  │  │ Paper trades │  │ OpenRouter (free)      │  │
│  │ Config mgmt  │  │ PnL calc     │  │ Anthropic (paid)       │  │
│  │ Start/Stop   │  │ Slippage sim │  │ Vercel AI SDK          │  │
│  └─────────────┘  └──────────────┘  └────────────────────────┘  │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ DEX Data    │  │ Strategy     │  │ Scheduler              │  │
│  │ DexScreener │  │ Engine       │  │ Cron Triggers          │  │
│  │ Price feeds │  │ TA indicators│  │ Durable Objects        │  │
│  │ Liquidity   │  │ Sentiment    │  │ (agent state)          │  │
│  └─────────────┘  └──────────────┘  └────────────────────────┘  │
│                                                                  │
│  Storage: D1 (trades, agents, snapshots)                        │
│  Cache: KV (price cache, LLM response cache)                    │
│  State: Durable Objects (running agent instances)                │
└─────────────────────────────────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   DexScreener API    OpenRouter API   Base Chain RPCs
   (free, no key)     (free models)    (public RPCs for
                                        on-chain reads)
```

### Why This Stack

| Choice                 | Reasoning                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| **Hono on CF Workers** | Edge-native, fast cold starts, Durable Objects for agent state, Cron Triggers for scheduled analysis |
| **Nuxt 4 on CF Pages** | SSR, your existing expertise, great DX                                                               |
| **Cloudflare D1**      | SQLite at edge, zero config, free tier generous for paper trading                                    |
| **Cloudflare KV**      | Price cache, LLM response cache                                                                      |
| **Durable Objects**    | Each agent gets its own stateful instance — perfect for running trading loops                        |
| **Vercel AI SDK**      | Provider-agnostic LLM calls, works on CF Workers, has `@openrouter/ai-sdk-provider`                  |
| **DexScreener API**    | Free, no API key, supports Base chain, real-time pair data                                           |

---

## What You Need to Provide

### Before Starting (Must Have)

| Item                              | How to Get                                                    | Used For                                         |
| --------------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| **OpenRouter API key**            | [openrouter.ai](https://openrouter.ai) → Dashboard → API Keys | Free LLM models (DeepSeek, Llama, Mistral, etc.) |
| **Cloudflare account**            | [dash.cloudflare.com](https://dash.cloudflare.com)            | Workers, D1, KV, Pages                           |
| **Wrangler CLI installed**        | `npm install -g wrangler` then `wrangler login`               | Deploy & dev                                     |
| **Node.js 20+**                   | `node --version` to check                                     | Runtime                                          |
| **Git repo** (empty, initialized) | Create on GitHub                                              | Version control                                  |

### Optional (Needed Later)

| Item                                           | When Needed                                                  |
| ---------------------------------------------- | ------------------------------------------------------------ |
| **Anthropic API key**                          | When you want to use Claude as a paid agent brain            |
| **Base RPC URL** (Alchemy/QuickNode free tier) | If DexScreener rate limits hit — direct on-chain price reads |
| **Telegram bot token**                         | If you want trade alert notifications                        |

### Decision Points (Answer These Upfront)

The prompt below includes sensible defaults for all of these, but you can override:

1. **Starting paper balance**: `$10,000 USDC` (default)
2. **Default trading pairs**: `WETH/USDC`, `cbBTC/WETH`, `AERO/USDC` on Base (default)
3. **Default DEX**: Aerodrome + Uniswap V3 on Base (default)
4. **Notifications**: Console logging only (default) — can add Telegram later
5. **Time zones**: UTC for all timestamps (default)

---

## Protocol Context

### x402 — When & How to Use It

**What it is**: Coinbase's open payment protocol using HTTP 402 status code for native stablecoin micropayments. V2 launched late 2025, processed 100M+ payments.

**Relevance to this project**: x402 fits as a **future monetization layer**, not a core requirement for MVP. Potential use cases:

- **Agent-as-a-Service**: Charge other users per-query to access your trained agent's signals via x402 paywall
- **Premium data feeds**: Gate access to your agent's trade history/performance data behind x402 micropayments
- **Agent-to-agent payments**: If your Level 1 agent needs to buy data/compute from other agents

**Recommendation for MVP**: Skip x402 integration. Build the trading agents first. Add x402 as a monetization layer once agents are producing valuable signals. The prompt includes a placeholder architecture for it.

**When you're ready to add it**:

```
npm install x402-hono  # Hono middleware for x402
# Wraps any route with pay-per-request using USDC on Base
```

### AP2 (Agent Payments Protocol) — Context

**What it is**: Google's open-source protocol (September 2025) for secure agent-to-agent financial transactions. Extends Google's A2A (Agent-to-Agent) protocol with payment capabilities. Backed by Coinbase, Ethereum Foundation, PayPal, American Express.

**Relevance**: AP2 is the **governance/compliance layer** for agent payments. It uses "Mandates" (cryptographically signed contracts) to define what an agent is authorized to spend. x402 can be used as a settlement rail within AP2.

**For this project**: AP2 becomes relevant when:

- Your agents need to autonomously pay for external data/APIs
- You want to expose your agents as services that other agents can pay for
- You need compliance-grade payment authorization

**Recommendation for MVP**: Not needed. AP2 is infrastructure for multi-party agent ecosystems. Your paper trading platform is single-user. Revisit when agents move from paper to real trading.

### ERC-8004 (Trustless Agents) — Context

**What it is**: Ethereum standard (August 2025) for on-chain agent identity, reputation, and validation registries. Gives AI agents verifiable blockchain identities.

**For this project**: Relevant later if you want your agents to have on-chain identities with public reputation scores based on their paper trading performance. Cool feature but not MVP.

---

## Package Evaluation

### ElizaOS — Verdict: Don't Use

From our previous analysis, the core issues remain:

- **No paper trading mode** — designed for real on-chain transactions
- **v2 stability issues** — broken package dependencies, installation failures
- **Too opinionated** — character file system adds complexity without value for your use case
- **Token ecosystem overhead** — lots of project weight from $ELIZAOS tokenomics

### What to Use Instead

| Need                          | Package                                                 | Why                                                                                           |
| ----------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **LLM calls**                 | `ai` (Vercel AI SDK) + `@openrouter/ai-sdk-provider`    | Provider-agnostic, works on CF Workers, structured output support, streaming                  |
| **DEX price data**            | DexScreener API (no package needed, just `fetch`)       | Free, no key, Base chain support, pair data + OHLCV                                           |
| **Technical analysis**        | `technicalindicators` (npm)                             | Pure JS, no native deps, works on CF Workers — RSI, MACD, EMA, Bollinger, etc.                |
| **On-chain reads** (optional) | `viem`                                                  | Lightweight, TypeScript-first, Base chain support — for reading pool reserves, token balances |
| **Scheduling**                | Cloudflare Cron Triggers + Durable Objects              | Native to platform, no external scheduler needed                                              |
| **Database**                  | Cloudflare D1 + Drizzle ORM                             | SQLite at edge, Drizzle for type-safe queries                                                 |
| **Validation**                | `zod`                                                   | Schema validation for agent configs, trade records, API responses                             |
| **Charts (frontend)**         | Lightweight charting lib (e.g., `unovis` or `chart.js`) | Trade history visualization, PnL curves                                                       |

### Other Frameworks Considered

| Framework                          | Verdict               | Why Not                                                                                     |
| ---------------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| **LangChain.js**                   | Skip                  | Too heavy for CF Workers, OpenTelemetry doesn't work on edge                                |
| **AutoGPT / CrewAI**               | Skip                  | Python, not TS — wrong ecosystem                                                            |
| **MAHORAGA**                       | Interesting reference | CF Workers based, but Alpaca-focused (CEX, not DEX) — borrow architecture ideas, don't fork |
| **TradingAgents (TauricResearch)** | Reference only        | Python/LangGraph — great multi-agent patterns to port to TS                                 |

---

## Build Prompt

### For Claude Code

Save this as `CLAUDE.md` in your project root:

```markdown
# CLAUDE.md — DEX Paper Trading Agents Platform

## Project Overview

Build a DEX paper trading platform where users create AI-powered trading agents
that simulate trades on Base chain DEXes. Agents use LLMs (via OpenRouter free
tier) to analyze markets and make paper trading decisions with configurable
autonomy levels.

## Critical Context

- This is PAPER TRADING only — no real transactions, no wallets, no signing
- All "trades" are simulated using real price data from DexScreener API
- Agents run as Cloudflare Durable Objects with Cron Trigger scheduling
- LLM calls go through Vercel AI SDK → OpenRouter (free models)
- Default chain is Base, default DEXes are Aerodrome and Uniswap V3

## Tech Stack (Non-Negotiable)

- **Backend**: Cloudflare Workers + Hono framework
- **Frontend**: Nuxt 4 (deployed to Cloudflare Pages)
- **Database**: Cloudflare D1 with Drizzle ORM
- **Cache**: Cloudflare KV (price cache, LLM response cache)
- **Agent State**: Cloudflare Durable Objects
- **LLM**: Vercel AI SDK (`ai` package) + `@openrouter/ai-sdk-provider`
- **Price Data**: DexScreener API (free, no key needed)
- **TA**: `technicalindicators` npm package
- **Validation**: Zod for all schemas
- **Monorepo**: Turborepo with `apps/web` (Nuxt) and `apps/api` (Workers)

## Project Structure
```

dex-trading-agents/
├── apps/
│ ├── api/ # Cloudflare Workers + Hono
│ │ ├── src/
│ │ │ ├── index.ts # Hono app entry, route registration
│ │ │ ├── routes/
│ │ │ │ ├── agents.ts # CRUD for trading agents
│ │ │ │ ├── trades.ts # Trade history, stats
│ │ │ │ ├── pairs.ts # DEX pair data proxy/cache
│ │ │ │ └── health.ts # Health check
│ │ │ ├── services/
│ │ │ │ ├── llm-router.ts # Vercel AI SDK + OpenRouter setup
│ │ │ │ ├── dex-data.ts # DexScreener API client
│ │ │ │ ├── paper-engine.ts # Paper trade execution & PnL
│ │ │ │ ├── strategy.ts # Strategy engine (TA + LLM analysis)
│ │ │ │ └── indicators.ts # Technical analysis wrapper
│ │ │ ├── agents/
│ │ │ │ ├── trading-agent.ts # Durable Object class
│ │ │ │ ├── agent-loop.ts # Analysis → Decision → Execute loop
│ │ │ │ └── prompts.ts # System prompts per autonomy level
│ │ │ ├── db/
│ │ │ │ ├── schema.ts # Drizzle schema
│ │ │ │ └── migrations/ # D1 migrations
│ │ │ ├── types/
│ │ │ │ ├── agent.ts # Agent config types
│ │ │ │ ├── trade.ts # Trade record types
│ │ │ │ └── dex.ts # DEX data types
│ │ │ └── lib/
│ │ │ ├── validation.ts # Zod schemas
│ │ │ └── utils.ts # Helpers
│ │ ├── wrangler.toml
│ │ ├── package.json
│ │ └── tsconfig.json
│ └── web/ # Nuxt 4 app
│ ├── pages/
│ │ ├── index.vue # Dashboard overview
│ │ ├── agents/
│ │ │ ├── index.vue # Agent list
│ │ │ ├── create.vue # Agent creation wizard
│ │ │ └── [id].vue # Agent detail + live status
│ │ └── trades/
│ │ └── index.vue # Trade history + filters
│ ├── components/
│ │ ├── AgentCard.vue
│ │ ├── TradeTable.vue
│ │ ├── PnLChart.vue
│ │ ├── ConfidenceGauge.vue
│ │ └── AgentConfigForm.vue
│ ├── composables/
│ │ ├── useAgents.ts
│ │ ├── useTrades.ts
│ │ └── useApi.ts
│ └── nuxt.config.ts
├── packages/
│ └── shared/ # Shared types & validation
│ ├── types.ts
│ └── validation.ts
├── turbo.json
├── package.json
└── CLAUDE.md

````

## Database Schema (D1 + Drizzle)

```typescript
// agents table
{
  id: text primary key (nanoid),
  name: text not null,
  status: text not null default 'stopped', // 'running' | 'stopped' | 'paused'
  autonomy_level: integer not null, // 1 = full auto, 2 = semi, 3 = strict rules
  config: text not null, // JSON blob of AgentConfig
  llm_model: text not null, // e.g. "deepseek/deepseek-chat-v3-0324:free"
  created_at: text not null,
  updated_at: text not null,
}

// trades table
{
  id: text primary key (nanoid),
  agent_id: text not null references agents(id),
  pair: text not null, // "WETH/USDC"
  dex: text not null, // "aerodrome" | "uniswap-v3"
  side: text not null, // "buy" | "sell"
  entry_price: real not null,
  exit_price: real, // null if position still open
  amount_usd: real not null,
  pnl_pct: real, // null if not closed
  pnl_usd: real,
  confidence_before: real not null, // 0-1, LLM confidence before trade
  confidence_after: real, // 0-1, LLM confidence after exit
  reasoning: text not null, // LLM's explanation
  strategy_used: text not null,
  slippage_simulated: real not null default 0.003, // 0.3% default
  status: text not null, // 'open' | 'closed' | 'stopped_out'
  opened_at: text not null,
  closed_at: text,
}

// agent_decisions table (log every LLM call)
{
  id: text primary key,
  agent_id: text not null,
  decision: text not null, // 'buy' | 'sell' | 'hold' | 'close'
  confidence: real not null,
  reasoning: text not null,
  llm_model: text not null,
  llm_latency_ms: integer not null,
  llm_tokens_used: integer,
  market_data_snapshot: text not null, // JSON of prices/indicators at decision time
  created_at: text not null,
}

// performance_snapshots table (periodic)
{
  id: text primary key,
  agent_id: text not null,
  balance: real not null,
  total_pnl_pct: real not null,
  win_rate: real not null,
  total_trades: integer not null,
  sharpe_ratio: real,
  max_drawdown: real,
  snapshot_at: text not null,
}
````

## Agent Configuration Schema (Zod)

```typescript
const AgentConfigSchema = z.object({
  // Identity
  name: z.string().min(1).max(50),
  description: z.string().max(500).optional(),

  // Autonomy
  autonomyLevel: z.enum(["full", "guided", "strict"]),
  // full: agent makes all decisions, adjusts own strategies
  // guided: agent proposes, but within defined bounds
  // strict: agent follows exact rules, LLM only for analysis/reporting

  // LLM
  llmModel: z.string().default("deepseek/deepseek-chat-v3-0324:free"),
  llmFallback: z.string().default("meta-llama/llama-3.3-70b-instruct:free"),
  maxLlmCallsPerHour: z.number().min(1).max(60).default(12),

  // Trading
  chain: z.literal("base").default("base"), // only Base for now
  dexes: z
    .array(z.enum(["aerodrome", "uniswap-v3"]))
    .default(["aerodrome", "uniswap-v3"]),
  pairs: z
    .array(z.string())
    .min(1)
    .max(10)
    .default(["WETH/USDC", "cbBTC/WETH", "AERO/USDC"]),
  paperBalance: z.number().min(100).max(1_000_000).default(10_000),
  maxPositionSizePct: z.number().min(1).max(100).default(20), // max 20% of balance per trade
  maxOpenPositions: z.number().min(1).max(10).default(3),
  stopLossPct: z.number().min(0.5).max(50).default(5), // 5% stop loss
  takeProfitPct: z.number().min(0.5).max(100).default(10), // 10% take profit
  slippageSimulation: z.number().min(0).max(5).default(0.3), // 0.3%

  // Timeframe
  analysisInterval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("1h"),
  // How often the agent wakes up to analyze. Maps to Cron Trigger.

  // Strategies (Level 3 strict mode)
  strategies: z
    .array(
      z.enum([
        "ema_crossover", // EMA 9/21 crossover
        "rsi_oversold", // RSI < 30 buy, > 70 sell
        "macd_signal", // MACD line crosses signal
        "bollinger_bounce", // Price touches lower band
        "volume_breakout", // Volume spike + price breakout
        "llm_sentiment", // LLM analyzes recent trades/volume patterns
        "combined", // LLM weighs multiple indicators
      ]),
    )
    .default(["combined"]),

  // Risk
  maxDailyLossPct: z.number().min(1).max(50).default(10), // stop trading if daily loss > 10%
  cooldownAfterLossMinutes: z.number().min(0).max(1440).default(30),
});
```

## LLM Router Implementation

Use Vercel AI SDK with OpenRouter provider. MUST work on Cloudflare Workers.

```typescript
// Key pattern — provider setup
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { z } from "zod";

const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });

// Structured output for trade decisions
const TradeDecisionSchema = z.object({
  action: z.enum(["buy", "sell", "hold", "close"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  targetPair: z.string().optional(),
  suggestedPositionSizePct: z.number().min(0).max(100).optional(),
});

const { object: decision } = await generateObject({
  model: openrouter("deepseek/deepseek-chat-v3-0324:free"),
  schema: TradeDecisionSchema,
  system: AGENT_SYSTEM_PROMPT, // varies by autonomy level
  prompt: buildAnalysisPrompt(marketData, openPositions, agentConfig),
});
```

## DexScreener Integration

```typescript
// Free API, no key needed
// Base chain ID in DexScreener: "base"

// Get pair data
// GET https://api.dexscreener.com/latest/dex/pairs/base/{pairAddress}

// Search pairs
// GET https://api.dexscreener.com/latest/dex/search?q=WETH%20USDC

// Get token pairs
// GET https://api.dexscreener.com/latest/dex/tokens/{tokenAddress}

// IMPORTANT: Cache responses in KV with 30s-60s TTL to avoid rate limits
// DexScreener rate limit: ~300 requests/minute

// Key data points from DexScreener response:
// - priceUsd, priceNative
// - txns (buys/sells counts per timeframe)
// - volume (per timeframe)
// - priceChange (per timeframe: m5, h1, h6, h24)
// - liquidity (usd, base, quote)
// - fdv, marketCap
```

## Agent Loop (Durable Object)

Each trading agent runs as a Durable Object with this loop:

```
1. WAKE UP (Cron Trigger or alarm)
2. FETCH market data (DexScreener → KV cache)
3. CALCULATE indicators (technicalindicators)
4. BUILD context (market data + indicators + open positions + recent history)
5. LLM ANALYSIS (Vercel AI SDK → OpenRouter)
6. VALIDATE decision (against agent config bounds)
7. EXECUTE paper trade (if action != hold)
8. LOG everything (D1: trade + decision record)
9. CHECK risk limits (daily loss, max positions)
10. SCHEDULE next wake (Durable Object alarm)
```

## System Prompts (Per Autonomy Level)

### Level 1 — Full Autonomy

```
You are an autonomous crypto trading agent operating on Base chain DEXes.
You have full authority to:
- Choose which pairs to analyze from your allowed list
- Select trading strategies dynamically
- Adjust position sizes within bounds
- Suggest configuration tweaks for better performance

Current portfolio: {portfolio_state}
Market data: {market_data}
Recent decisions: {last_10_decisions}
Performance: {performance_summary}

Make a trading decision. If you see a pattern that your current strategy
config doesn't cover, include a "config_suggestion" in your reasoning.
```

### Level 2 — Guided

```
You are a guided crypto trading agent on Base chain.
You analyze markets and make recommendations within defined bounds.
You MUST stay within these constraints:
- Only trade pairs: {allowed_pairs}
- Position size: {min}-{max}% of portfolio
- Strategies: {allowed_strategies}

Current portfolio: {portfolio_state}
Market data: {market_data}

Analyze and recommend a trade. Explain your reasoning clearly.
If the best action is to hold, say so with confidence.
```

### Level 3 — Strict Rules

```
You are a rule-following trading analysis agent.
Your ONLY job is to evaluate technical indicators and report signals.
You do NOT decide trades — the system executes based on rules.

Active rules:
{strategy_rules_yaml}

Current indicator values:
{indicator_values}

Report which rules are triggered and with what confidence.
Format: action, confidence 0-1, explanation of indicator readings.
```

## Cron Trigger Schedule

```toml
# wrangler.toml
[triggers]
crons = [
  "*/1 * * * *",   # Every minute — for 1m agents
  "*/5 * * * *",   # Every 5 minutes
  "*/15 * * * *",  # Every 15 minutes
  "0 * * * *",     # Every hour
  "0 */4 * * *",   # Every 4 hours
  "0 0 * * *",     # Daily
]
```

Each cron wakes the appropriate Durable Objects based on their configured interval.

## API Routes (Hono)

```
GET    /api/health
GET    /api/agents                    # List all agents
POST   /api/agents                    # Create agent
GET    /api/agents/:id                # Get agent detail
PATCH  /api/agents/:id                # Update agent config
DELETE /api/agents/:id                # Delete agent
POST   /api/agents/:id/start          # Start agent
POST   /api/agents/:id/stop           # Stop agent
POST   /api/agents/:id/pause          # Pause agent

GET    /api/agents/:id/trades         # Agent's trade history
GET    /api/agents/:id/decisions      # Agent's decision log
GET    /api/agents/:id/performance    # Performance snapshots

GET    /api/trades                    # All trades across agents
GET    /api/trades/stats              # Aggregate stats

GET    /api/pairs/search?q=           # Search DEX pairs (cached)
GET    /api/pairs/:chain/:address     # Get pair data (cached)

GET    /api/models                    # Available LLM models from OpenRouter
```

## Build Order (Follow This Sequence)

### Phase 1: Foundation (do this first)

1. Initialize Turborepo monorepo with `apps/api` and `apps/web`
2. Set up Hono app in `apps/api` with wrangler.toml (D1, KV, Durable Objects bindings)
3. Create Drizzle schema + run first D1 migration
4. Implement health endpoint + basic CORS middleware
5. **Test**: `wrangler dev` serves health endpoint, D1 is accessible

### Phase 2: Data Layer

6. Build DexScreener API client with KV caching (30s TTL)
7. Build technical indicators wrapper (RSI, EMA, MACD, Bollinger)
8. Build pair search/data proxy endpoints
9. **Test**: Can fetch WETH/USDC price on Base, indicators compute correctly

### Phase 3: Agent Core

10. Build LLM router (Vercel AI SDK + OpenRouter)
11. Build agent CRUD endpoints with Zod validation
12. Build paper trading engine (open/close positions, PnL calculation, slippage simulation)
13. Build Durable Object for agent state management
14. **Test**: Can create agent via API, LLM returns structured trade decision, paper engine calculates PnL

### Phase 4: Agent Loop

15. Implement the full agent analysis loop in Durable Object
16. Wire up Cron Triggers to wake agents
17. Implement risk management (stop loss, take profit, daily loss limit, cooldown)
18. Build decision logging
19. **Test**: Agent wakes on schedule, analyzes, logs decision, executes paper trade if signal found

### Phase 5: Frontend

20. Nuxt 4 app with API composables
21. Dashboard page (aggregate stats, active agents, recent trades)
22. Agent creation wizard (form with all config options + defaults)
23. Agent detail page (status, trade history, decision log, PnL chart)
24. Trade history page with filters
25. **Test**: Full flow — create agent in UI, start it, see trades appear

### Phase 6: Polish

26. Performance snapshots (hourly cron calculates win rate, sharpe, drawdown)
27. Agent comparison view
28. Error handling, retry logic for LLM calls
29. Rate limiting on API routes

## Environment Variables

```bash
# apps/api/.dev.vars (local development)
OPENROUTER_API_KEY=sk-or-v1-xxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxx         # optional, for paid models

# wrangler.toml bindings
# [[ d1_databases ]]
# binding = "DB"
# database_name = "trading-agents"
# database_id = "<auto-generated>"

# [[ kv_namespaces ]]
# binding = "CACHE"
# id = "<auto-generated>"

# [durable_objects]
# bindings = [{ name = "TRADING_AGENT", class_name = "TradingAgentDO" }]
```

## Non-Obvious Technical Notes

1. **Cloudflare Workers can't use Node.js crypto** — use Web Crypto API
2. **Durable Objects have 128MB memory limit** — don't accumulate too much state, offload to D1
3. **D1 has 10MB database limit on free tier** — paper trading won't hit this but be aware
4. **OpenRouter free models rate limit**: typically 20 req/min — implement exponential backoff
5. **DexScreener doesn't provide OHLCV candles via API** — use priceChange percentages + current price to approximate, or compute from trade history
6. **`technicalindicators` works in Workers** — it's pure JS, no native deps
7. **Vercel AI SDK `generateObject` requires models with tool/function calling** — DeepSeek and Llama support this
8. **Durable Object alarms are NOT cron** — they're one-shot timers. Set the next alarm at the end of each loop iteration.

## Code Quality Requirements

- TypeScript strict mode everywhere
- Zod validation on ALL external inputs (API requests, LLM responses, DexScreener data)
- Every function that can fail returns a Result type or throws typed errors
- No `any` types
- Drizzle for all DB queries (no raw SQL)
- All LLM prompts in separate `prompts.ts` file
- Comprehensive JSDoc on public functions

````

### For Cursor

Save the same content above as `CLAUDE.md` (Cursor reads it too), plus create `.cursor/rules` with:

```markdown
# .cursor/rules

## Project Context
This is a DEX paper trading agents platform.
Read CLAUDE.md for complete architecture and requirements.

## Rules
- Always check CLAUDE.md before making architectural decisions
- Follow the Build Order in CLAUDE.md strictly
- Use Hono, not Express or Fastify
- Use Drizzle ORM, not Prisma or raw SQL
- Use Vercel AI SDK, not LangChain
- Use Zod for all validation
- Test each phase before moving to the next
- Commit after each completed phase with descriptive message
- When unsure, choose the simpler implementation

## Coding Style
- TypeScript strict
- Functional style preferred
- No classes except Durable Objects
- Use `const` over `let`
- Prefer named exports
- Error handling: Result pattern or typed errors, never swallow errors
````

---

## Validation & Testing Strategy

### Automated Validation (Agent Should Run These)

```bash
# After Phase 1
wrangler d1 execute trading-agents --command "SELECT 1" # D1 works
curl http://localhost:8787/api/health                     # API responds

# After Phase 2
# Run this test file:
```

```typescript
// tests/dex-data.test.ts
import { describe, it, expect } from "vitest";

describe("DexScreener Client", () => {
  it("fetches WETH/USDC pair on Base", async () => {
    const response = await fetch(
      "https://api.dexscreener.com/latest/dex/search?q=WETH%20USDC%20base",
    );
    const data = await response.json();
    expect(data.pairs.length).toBeGreaterThan(0);
    expect(data.pairs[0].chainId).toBe("base");
    expect(parseFloat(data.pairs[0].priceUsd)).toBeGreaterThan(0);
  });

  it("computes RSI from price data", () => {
    const { RSI } = require("technicalindicators");
    const prices = [
      44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89,
      46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
    ];
    const result = RSI.calculate({ period: 14, values: prices });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toBeGreaterThan(0);
    expect(result[0]).toBeLessThan(100);
  });
});
```

```typescript
// tests/paper-engine.test.ts
describe("Paper Trading Engine", () => {
  it("opens and closes a position with correct PnL", () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.003 });
    const trade = engine.openPosition({
      pair: "WETH/USDC",
      side: "buy",
      price: 2500,
      amountUsd: 1000,
    });
    expect(trade.status).toBe("open");
    // Slippage: bought at 2500 * 1.003 = 2507.50 effective

    const closed = engine.closePosition(trade.id, { price: 2750 });
    // Sold at 2750 * 0.997 = 2741.75 effective
    expect(closed.pnlPct).toBeCloseTo(9.34, 1); // ~9.34% gain
    expect(closed.status).toBe("closed");
    expect(engine.balance).toBeGreaterThan(10000);
  });

  it("respects stop loss", () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.003 });
    const trade = engine.openPosition({
      pair: "WETH/USDC",
      side: "buy",
      price: 2500,
      amountUsd: 1000,
    });

    const shouldStop = engine.checkStopLoss(trade, 2350, 5); // 5% stop loss
    expect(shouldStop).toBe(true);
  });

  it("enforces max position size", () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.003 });
    expect(() =>
      engine.openPosition({
        pair: "WETH/USDC",
        side: "buy",
        price: 2500,
        amountUsd: 5000, // 50% of balance, exceeds 20% default
        maxPositionSizePct: 20,
      }),
    ).toThrow();
  });
});
```

```typescript
// tests/llm-router.test.ts
describe("LLM Router", () => {
  it("returns structured trade decision from OpenRouter", async () => {
    const decision = await getTradeDecision({
      model: "deepseek/deepseek-chat-v3-0324:free",
      marketData: mockMarketData,
      portfolio: mockPortfolio,
      config: mockAgentConfig,
    });
    expect(["buy", "sell", "hold", "close"]).toContain(decision.action);
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
    expect(decision.reasoning.length).toBeGreaterThan(10);
  });

  it("falls back to secondary model on failure", async () => {
    const decision = await getTradeDecision({
      model: "nonexistent/model",
      fallback: "meta-llama/llama-3.3-70b-instruct:free",
      marketData: mockMarketData,
      portfolio: mockPortfolio,
      config: mockAgentConfig,
    });
    expect(decision.action).toBeDefined();
  });
});
```

```typescript
// tests/agent-config.test.ts
describe("Agent Configuration", () => {
  it("validates default config", () => {
    const result = AgentConfigSchema.safeParse({
      name: "Test Agent",
      autonomyLevel: "guided",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paperBalance).toBe(10000);
      expect(result.data.pairs).toContain("WETH/USDC");
    }
  });

  it("rejects invalid autonomy level", () => {
    const result = AgentConfigSchema.safeParse({
      name: "Test",
      autonomyLevel: "yolo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects position size over 100%", () => {
    const result = AgentConfigSchema.safeParse({
      name: "Test",
      autonomyLevel: "strict",
      maxPositionSizePct: 150,
    });
    expect(result.success).toBe(false);
  });
});
```

### Integration Test (End-to-End)

```typescript
// tests/e2e/agent-lifecycle.test.ts
describe("Agent Lifecycle E2E", () => {
  it("creates agent, starts it, produces trades", async () => {
    // 1. Create agent
    const createRes = await fetch("http://localhost:8787/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "E2E Test Agent",
        autonomyLevel: "strict",
        strategies: ["rsi_oversold"],
        pairs: ["WETH/USDC"],
        analysisInterval: "1m",
      }),
    });
    expect(createRes.status).toBe(201);
    const agent = await createRes.json();

    // 2. Start agent
    const startRes = await fetch(
      `http://localhost:8787/api/agents/${agent.id}/start`,
      { method: "POST" },
    );
    expect(startRes.status).toBe(200);

    // 3. Wait for one analysis cycle
    await new Promise((r) => setTimeout(r, 70_000)); // 70s for 1m interval

    // 4. Check decisions were logged
    const decisionsRes = await fetch(
      `http://localhost:8787/api/agents/${agent.id}/decisions`,
    );
    const decisions = await decisionsRes.json();
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].confidence).toBeGreaterThanOrEqual(0);

    // 5. Stop agent
    const stopRes = await fetch(
      `http://localhost:8787/api/agents/${agent.id}/stop`,
      { method: "POST" },
    );
    expect(stopRes.status).toBe(200);
  }, 120_000); // 2 minute timeout
});
```

### Testing Setup

```bash
# Install test dependencies
npm install -D vitest @cloudflare/vitest-pool-workers

# vitest.config.ts — for unit tests (fast, no Workers runtime)
# vitest.config.integration.ts — for integration tests (uses miniflare)
```

### Manual Smoke Tests (For You to Verify)

After each phase, the agent should print a checklist. You verify:

**Phase 1 ✓**

- [ ] `wrangler dev` starts without errors
- [ ] `curl localhost:8787/api/health` returns 200
- [ ] D1 migration ran (check Cloudflare dashboard)

**Phase 2 ✓**

- [ ] `curl localhost:8787/api/pairs/search?q=WETH` returns Base pairs
- [ ] Price is a reasonable number (>0, not NaN)

**Phase 3 ✓**

- [ ] Can POST to `/api/agents` and get back created agent
- [ ] Invalid config (e.g., `autonomyLevel: "yolo"`) returns 400

**Phase 4 ✓**

- [ ] Start an agent, wait 2 minutes, check `/api/agents/:id/decisions`
- [ ] Decisions have confidence scores and reasoning
- [ ] If a trade was taken, it appears in `/api/agents/:id/trades`

**Phase 5 ✓**

- [ ] Nuxt app loads at localhost:3000
- [ ] Can create agent through UI
- [ ] Agent detail page shows live data

---

## Default Agent Configuration

When a user creates an agent without specifying everything, these defaults apply:

```json
{
  "name": "Agent #1",
  "autonomyLevel": "guided",
  "llmModel": "deepseek/deepseek-chat-v3-0324:free",
  "llmFallback": "meta-llama/llama-3.3-70b-instruct:free",
  "maxLlmCallsPerHour": 12,
  "chain": "base",
  "dexes": ["aerodrome", "uniswap-v3"],
  "pairs": ["WETH/USDC", "cbBTC/WETH", "AERO/USDC"],
  "paperBalance": 10000,
  "maxPositionSizePct": 20,
  "maxOpenPositions": 3,
  "stopLossPct": 5,
  "takeProfitPct": 10,
  "slippageSimulation": 0.3,
  "analysisInterval": "1h",
  "strategies": ["combined"],
  "maxDailyLossPct": 10,
  "cooldownAfterLossMinutes": 30
}
```
