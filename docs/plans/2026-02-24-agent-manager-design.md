# Agent Manager — Design Document

**Date:** 2026-02-24
**Phase:** F
**Approach:** Thin DO + Heavy D1 (Approach A)

---

## Overview

An Agent Manager is a meta-agent that autonomously creates, monitors, evaluates, and optimizes trading agents. It runs as a Cloudflare Durable Object with an alarm-based decision loop, mirroring the existing `TradingAgentDO` pattern exactly.

---

## Data Model

### New tables

```sql
-- Manager configuration and state
agent_managers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  config       TEXT NOT NULL,  -- JSON: AgentManagerConfig
  status       TEXT NOT NULL DEFAULT 'stopped',  -- stopped | running | paused
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
)

-- Every LLM decision the manager makes
agent_manager_logs (
  id          TEXT PRIMARY KEY,
  manager_id  TEXT NOT NULL REFERENCES agent_managers(id),
  action      TEXT NOT NULL,     -- create_agent | pause_agent | modify_agent | terminate_agent | hold | evaluate
  reasoning   TEXT NOT NULL,     -- LLM reasoning string
  result      TEXT NOT NULL,     -- JSON: outcome or error
  created_at  TEXT NOT NULL
)
```

### Altered table

```sql
ALTER TABLE agents ADD COLUMN manager_id TEXT REFERENCES agent_managers(id);
```

### AgentManagerConfig (JSON schema)

```ts
{
  llmModel: string,
  temperature: number,        // 0.0–2.0, default 0.7
  decisionInterval: string,   // '1h' | '4h' | '1d'
  riskParams: {
    maxTotalDrawdown: number,  // e.g. 0.20 = 20%
    maxAgents: number,         // e.g. 10
    maxCorrelatedPositions: number  // e.g. 3
  }
}
```

---

## AgentManagerDO

Mirrors `TradingAgentDO` exactly.

### ctx.storage keys

| Key | Type | Description |
|-----|------|-------------|
| `managerId` | string | Bound manager ID |
| `status` | string | running / stopped / paused |
| `memory` | JSON | Structured memory blob (see below) |
| `tickCount` | number | Incremented each alarm |

### HTTP endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Return managerId, status, tickCount, last memory summary |
| POST | `/start` | Initialize + schedule first alarm |
| POST | `/stop` | Stop loop, delete alarm |
| POST | `/pause` | Pause loop, delete alarm |

### Alarm loop

1. Guard: if status !== 'running', return early
2. Load `managerId` from storage
3. Call `runManagerLoop(managerId, env, ctx)`
4. Reschedule alarm in `finally` (same pattern as TradingAgentDO)

### runManagerLoop steps

1. Load manager config + all managed agents from D1
2. For each managed agent: load last 10 trades + latest performance snapshot
3. Fetch current prices/indicators for all managed pairs via DexScreener
4. Read `memory` from ctx.storage
5. Build LLM prompt with all four data sources:
   - Agent performance metrics (P&L, win rate, Sharpe, max drawdown, trade count)
   - Recent trade history (last 10 trades per agent)
   - Current market conditions (prices + RSI/EMA indicators)
   - Manager memory log (previous decisions and outcomes)
6. Call LLM via `generateText` + JSON extraction (existing llm-router pattern)
7. Parse decision array: `{ action, agentId?, params?, reasoning }[]`
8. Execute actions:
   - `create_agent` → POST to agents D1 + start DO
   - `pause_agent` → update agent status, stop DO alarm
   - `modify_agent` → PATCH agent config in D1
   - `terminate_agent` → stop DO alarm + mark agent terminated
   - `hold` → no-op, log reasoning
9. Log each decision to `agent_manager_logs` in D1
10. Update `memory` blob in ctx.storage

### Memory blob structure

```ts
{
  hypotheses: Array<{
    description: string,
    tested_at: string,
    outcome: string,
    still_valid: boolean
  }>,
  parameter_history: Array<{
    agent_id: string,
    change: string,
    change_at: string,
    outcome_after_n_cycles: string | null
  }>,
  market_regime: {
    detected_at: string,
    regime: 'trending' | 'ranging' | 'volatile',
    reasoning: string
  } | null,
  last_evaluation_at: string
}
```

---

## API Routes

All routes under `/api/managers/*`, protected by existing auth middleware.

```
GET    /api/managers               list user's managers
POST   /api/managers               create manager
GET    /api/managers/:id           get manager detail
PATCH  /api/managers/:id           update config
DELETE /api/managers/:id           delete manager
POST   /api/managers/:id/start     start decision loop
POST   /api/managers/:id/stop      stop loop
POST   /api/managers/:id/pause     pause loop
GET    /api/managers/:id/logs      paginated decision logs (default 20/page)
GET    /api/managers/:id/agents    agents under this manager
```

---

## Frontend

### New pages

| Route | Component | Description |
|-------|-----------|-------------|
| `/managers` | `pages/managers/index.vue` | Card grid of user's managers |
| `/managers/new` | `pages/managers/new.vue` | Creation form |
| `/managers/[id]` | `pages/managers/[id].vue` | Detail: agents, logs, memory, controls |

### New components

| Component | Purpose |
|-----------|---------|
| `ManagerCard.vue` | Status pill, agent count, last decision time |
| `ManagerConfigForm.vue` | Name, LLM, temperature slider, interval, risk params |
| `ManagerLogsTable.vue` | Paginated decision log table |

### Navigation

Add "Managers" link to existing app nav layout.

---

## TDD Plan

Tests written RED first, then implementation GREEN.

### Test files

1. `apps/api/src/routes/managers.test.ts` — CRUD, auth enforcement, log pagination
2. `apps/api/src/agents/manager-loop.test.ts` — decision parsing, action execution (mocked), memory update
3. `packages/shared/src/validation.test.ts` (extend) — `ManagerConfigSchema` Zod validation
4. `apps/web/components/ManagerConfigForm.test.ts` — validation, default values
5. `apps/web/components/ManagerLogsTable.test.ts` — rendering, pagination

---

## Out of Scope (this phase)

- A/B testing framework
- In-app alerting
- Research agent spawning (Step 6 from plan — if time permits)
- JWKS / key rotation

These are marked as TODO comments in code.
