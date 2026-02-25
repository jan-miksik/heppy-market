# Agent Manager Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a meta-agent (AgentManagerDO) that autonomously creates, monitors, evaluates, and modifies trading agents via an alarm-based LLM decision loop.

**Architecture:** `AgentManagerDO` Durable Object mirrors `TradingAgentDO` exactly — alarm-based loop, state in `ctx.storage`, decisions logged to D1 `agent_manager_logs`. A standalone `manager-loop.ts` (mirrors `agent-loop.ts`) fetches agent performance, market data, and memory, then calls the LLM for structured decisions.

**Tech Stack:** Cloudflare Workers + Durable Objects, Hono, Drizzle ORM + D1, Vercel AI SDK + OpenRouter, Zod, Nuxt 4 Vue 3 frontend.

---

## Task 1: DB migration

**Files:**
- Create: `apps/api/src/db/migrations/0003_agent_managers.sql`

**Step 1: Write the migration**

```sql
-- Migration: 0003_agent_managers

ALTER TABLE agents ADD COLUMN manager_id TEXT REFERENCES agent_managers(id);

CREATE TABLE IF NOT EXISTS agent_managers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  config TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stopped',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_manager_logs (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL REFERENCES agent_managers(id),
  action TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_manager_logs_manager_id ON agent_manager_logs(manager_id);
CREATE INDEX IF NOT EXISTS idx_agents_manager_id ON agents(manager_id);
```

**Step 2: Apply migration locally**

```bash
wrangler d1 execute trading-agents --local --file=apps/api/src/db/migrations/0003_agent_managers.sql
```

Expected: `Executed 1 migrations.` (no errors)

---

## Task 2: Drizzle schema update

**Files:**
- Modify: `apps/api/src/db/schema.ts`

**Step 1: Add tables and alter agents**

Add to `apps/api/src/db/schema.ts` after `performanceSnapshots`:

```typescript
export const agentManagers = sqliteTable('agent_managers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerAddress: text('owner_address').notNull(),
  config: text('config').notNull(),
  status: text('status').notNull().default('stopped'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const agentManagerLogs = sqliteTable('agent_manager_logs', {
  id: text('id').primaryKey(),
  managerId: text('manager_id')
    .notNull()
    .references(() => agentManagers.id),
  action: text('action').notNull(),
  reasoning: text('reasoning').notNull(),
  result: text('result').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});
```

Also add `managerId` column to the existing `agents` table definition:

```typescript
managerId: text('manager_id'),
```

(Add it after the `ownerAddress` field in the agents table.)

**Step 2: Verify TypeScript compiles**

```bash
cd /workspace && npm run lint 2>&1 | head -30
```

Expected: no errors in `schema.ts`

---

## Task 3: Shared validation — ManagerConfigSchema

**Files:**
- Modify: `packages/shared/src/validation.ts`
- Test: `packages/shared/src/validation.test.ts` (create if not exists)

**Step 1: Write the failing test**

Create `packages/shared/src/validation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ManagerConfigSchema, CreateManagerRequestSchema } from './validation.js';

describe('ManagerConfigSchema', () => {
  it('accepts valid config', () => {
    const result = ManagerConfigSchema.safeParse({
      llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
      temperature: 0.7,
      decisionInterval: '1h',
      riskParams: { maxTotalDrawdown: 0.2, maxAgents: 5, maxCorrelatedPositions: 3 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects temperature above 2', () => {
    const result = ManagerConfigSchema.safeParse({
      llmModel: 'any-model',
      temperature: 2.5,
      decisionInterval: '1h',
      riskParams: { maxTotalDrawdown: 0.2, maxAgents: 5, maxCorrelatedPositions: 3 },
    });
    expect(result.success).toBe(false);
  });

  it('applies defaults', () => {
    const result = ManagerConfigSchema.parse({
      llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
    });
    expect(result.temperature).toBe(0.7);
    expect(result.decisionInterval).toBe('1h');
    expect(result.riskParams.maxTotalDrawdown).toBe(0.2);
    expect(result.riskParams.maxAgents).toBe(10);
  });
});

describe('CreateManagerRequestSchema', () => {
  it('requires name', () => {
    const result = CreateManagerRequestSchema.safeParse({ llmModel: 'any' });
    expect(result.success).toBe(false);
  });

  it('accepts minimal valid request', () => {
    const result = CreateManagerRequestSchema.safeParse({
      name: 'My Manager',
      llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
    });
    expect(result.success).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm run test --workspace=packages/shared 2>&1 | tail -20
```

Expected: FAIL — `ManagerConfigSchema is not exported`

**Step 3: Add schemas to `packages/shared/src/validation.ts`**

Append after `UpdateAgentRequestSchema`:

```typescript
export const ManagerRiskParamsSchema = z.object({
  maxTotalDrawdown: z.number().min(0.01).max(1).default(0.2),
  maxAgents: z.number().min(1).max(20).default(10),
  maxCorrelatedPositions: z.number().min(1).max(10).default(3),
});

export const ManagerConfigSchema = z.object({
  llmModel: z.string().default('nvidia/nemotron-3-nano-30b-a3b:free'),
  temperature: z.number().min(0).max(2).default(0.7),
  decisionInterval: z.enum(['1h', '4h', '1d']).default('1h'),
  riskParams: ManagerRiskParamsSchema.default({}),
});

export type ManagerConfig = z.infer<typeof ManagerConfigSchema>;

export const CreateManagerRequestSchema = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  llmModel: z.string().default('nvidia/nemotron-3-nano-30b-a3b:free'),
  temperature: z.number().min(0).max(2).default(0.7),
  decisionInterval: z.enum(['1h', '4h', '1d']).default('1h'),
  riskParams: ManagerRiskParamsSchema.optional(),
});

export const UpdateManagerRequestSchema = CreateManagerRequestSchema.partial();
```

Also add exports to `packages/shared/src/index.ts` if it exists (or wherever the package re-exports from).

**Step 4: Run test to verify it passes**

```bash
npm run test --workspace=packages/shared 2>&1 | tail -20
```

Expected: PASS

---

## Task 4: Env types + wrangler.toml

**Files:**
- Modify: `apps/api/src/types/env.ts`
- Modify: `apps/api/wrangler.toml`

**Step 1: Export AgentManagerDO from index.ts (placeholder)**

First, add the export line to `apps/api/src/index.ts` (we'll create the file in Task 6, but we need the placeholder now):

Actually, skip this — do it in Task 6 after the DO is created.

**Step 1: Update wrangler.toml**

In `apps/api/wrangler.toml`, update the `[durable_objects]` section:

```toml
[durable_objects]
bindings = [
  { name = "TRADING_AGENT", class_name = "TradingAgentDO" },
  { name = "AGENT_MANAGER", class_name = "AgentManagerDO" }
]
```

Update the `[[migrations]]` section:

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["TradingAgentDO", "AgentManagerDO"]
```

Also update the `[env.production.durable_objects]` and `[[env.production.migrations]]` sections the same way.

**Step 2: Update `apps/api/src/types/env.ts`**

```typescript
import type { TradingAgentDO } from '../agents/trading-agent.js';
import type { AgentManagerDO } from '../agents/agent-manager.js';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  TRADING_AGENT: DurableObjectNamespace<TradingAgentDO>;
  AGENT_MANAGER: DurableObjectNamespace<AgentManagerDO>;
  OPENROUTER_API_KEY: string;
  ANTHROPIC_API_KEY?: string;
  CORS_ORIGINS?: string;
}
```

---

## Task 5: Manager loop — RED tests

**Files:**
- Create: `apps/api/src/agents/manager-loop.test.ts`

**Step 1: Write tests (all will fail — no implementation yet)**

Create `apps/api/src/agents/manager-loop.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseManagerDecisions, buildManagerPrompt, executeManagerAction } from './manager-loop.js';
import type { ManagerDecision, ManagedAgentSnapshot } from './manager-loop.js';

const mockAgent: ManagedAgentSnapshot = {
  id: 'agent_001',
  name: 'Test Agent',
  status: 'running',
  llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
  config: {
    pairs: ['WETH/USDC'],
    strategies: ['combined'],
    maxPositionSizePct: 5,
    analysisInterval: '1h',
    paperBalance: 10000,
    temperature: 0.7,
  },
  performance: {
    balance: 10500,
    totalPnlPct: 5.0,
    winRate: 0.6,
    totalTrades: 10,
    sharpeRatio: 1.2,
    maxDrawdown: 0.03,
  },
  recentTrades: [],
};

describe('parseManagerDecisions', () => {
  it('parses valid JSON array of decisions', () => {
    const raw = JSON.stringify([
      { action: 'hold', agentId: 'agent_001', reasoning: 'performing well' },
    ]);
    const decisions = parseManagerDecisions(raw);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('hold');
    expect(decisions[0].agentId).toBe('agent_001');
  });

  it('strips reasoning tags from response', () => {
    const raw = '<think>internal</think>[{"action":"hold","agentId":"a1","reasoning":"ok"}]';
    const decisions = parseManagerDecisions(raw);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('hold');
  });

  it('returns empty array on invalid JSON', () => {
    const decisions = parseManagerDecisions('not json at all');
    expect(decisions).toEqual([]);
  });

  it('filters out decisions with invalid actions', () => {
    const raw = JSON.stringify([
      { action: 'hold', agentId: 'a1', reasoning: 'ok' },
      { action: 'invalid_action', agentId: 'a2', reasoning: 'bad' },
    ]);
    const decisions = parseManagerDecisions(raw);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('hold');
  });
});

describe('buildManagerPrompt', () => {
  it('includes agent performance data', () => {
    const prompt = buildManagerPrompt({
      agents: [mockAgent],
      marketData: [],
      memory: { hypotheses: [], parameter_history: [], market_regime: null, last_evaluation_at: '' },
      managerConfig: { llmModel: 'any', temperature: 0.7, decisionInterval: '1h', riskParams: { maxTotalDrawdown: 0.2, maxAgents: 10, maxCorrelatedPositions: 3 } },
    });
    expect(prompt).toContain('Test Agent');
    expect(prompt).toContain('5.0'); // pnl pct
    expect(prompt).toContain('WETH/USDC');
  });

  it('includes memory hypotheses when present', () => {
    const prompt = buildManagerPrompt({
      agents: [mockAgent],
      marketData: [],
      memory: {
        hypotheses: [{ description: 'Lower temp helps', tested_at: '2026-01-01', outcome: 'confirmed', still_valid: true }],
        parameter_history: [],
        market_regime: null,
        last_evaluation_at: '',
      },
      managerConfig: { llmModel: 'any', temperature: 0.7, decisionInterval: '1h', riskParams: { maxTotalDrawdown: 0.2, maxAgents: 10, maxCorrelatedPositions: 3 } },
    });
    expect(prompt).toContain('Lower temp helps');
  });

  it('includes instructions for valid action types', () => {
    const prompt = buildManagerPrompt({
      agents: [mockAgent],
      marketData: [],
      memory: { hypotheses: [], parameter_history: [], market_regime: null, last_evaluation_at: '' },
      managerConfig: { llmModel: 'any', temperature: 0.7, decisionInterval: '1h', riskParams: { maxTotalDrawdown: 0.2, maxAgents: 10, maxCorrelatedPositions: 3 } },
    });
    expect(prompt).toContain('create_agent');
    expect(prompt).toContain('pause_agent');
    expect(prompt).toContain('modify_agent');
    expect(prompt).toContain('terminate_agent');
    expect(prompt).toContain('hold');
  });
});

describe('executeManagerAction', () => {
  it('returns error result for unknown action', async () => {
    const mockDb = {} as any;
    const mockEnv = {} as any;
    const result = await executeManagerAction(
      { action: 'unknown_action' as any, reasoning: 'test' },
      mockDb,
      mockEnv,
      'manager_001',
      'owner_addr'
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('unknown');
  });

  it('returns success for hold action', async () => {
    const mockDb = {} as any;
    const mockEnv = {} as any;
    const result = await executeManagerAction(
      { action: 'hold', reasoning: 'all good' },
      mockDb,
      mockEnv,
      'manager_001',
      'owner_addr'
    );
    expect(result.success).toBe(true);
  });
});
```

**Step 2: Run to verify RED**

```bash
npm run test --workspace=apps/api -- --reporter=verbose 2>&1 | grep -E "(FAIL|PASS|Error)" | head -20
```

Expected: FAIL — `manager-loop.js not found`

---

## Task 6: Manager loop — GREEN implementation

**Files:**
- Create: `apps/api/src/agents/manager-loop.ts`

**Step 1: Create manager-loop.ts**

```typescript
/**
 * Agent Manager decision loop.
 * Called by AgentManagerDO.alarm() on each scheduled tick.
 * Flow: load managed agents → fetch perf + trades → market data →
 *       load memory → build prompt → LLM call → parse decisions →
 *       execute actions → log to D1 → update memory
 */
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, and } from 'drizzle-orm';
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { Env } from '../types/env.js';
import { agents, trades, performanceSnapshots, agentManagers, agentManagerLogs } from '../db/schema.js';
import { createDexDataService, getPriceUsd } from '../services/dex-data.js';
import { createGeckoTerminalService } from '../services/gecko-terminal.js';
import { generateId, nowIso } from '../lib/utils.js';
import type { ManagerConfig } from '@dex-agents/shared';

export type ManagerAction = 'create_agent' | 'pause_agent' | 'modify_agent' | 'terminate_agent' | 'hold';

export interface ManagerDecision {
  action: ManagerAction;
  agentId?: string;
  params?: Record<string, unknown>;
  reasoning: string;
}

export interface ManagerMemory {
  hypotheses: Array<{
    description: string;
    tested_at: string;
    outcome: string;
    still_valid: boolean;
  }>;
  parameter_history: Array<{
    agent_id: string;
    change: string;
    change_at: string;
    outcome_after_n_cycles: string | null;
  }>;
  market_regime: {
    detected_at: string;
    regime: 'trending' | 'ranging' | 'volatile';
    reasoning: string;
  } | null;
  last_evaluation_at: string;
}

export interface ManagedAgentSnapshot {
  id: string;
  name: string;
  status: string;
  llmModel: string;
  config: {
    pairs: string[];
    strategies: string[];
    maxPositionSizePct: number;
    analysisInterval: string;
    paperBalance: number;
    temperature: number;
  };
  performance: {
    balance: number;
    totalPnlPct: number;
    winRate: number;
    totalTrades: number;
    sharpeRatio: number | null;
    maxDrawdown: number | null;
  };
  recentTrades: Array<{
    pair: string;
    side: string;
    pnlPct: number | null;
    openedAt: string;
    closedAt: string | null;
  }>;
}

const VALID_ACTIONS: ManagerAction[] = ['create_agent', 'pause_agent', 'modify_agent', 'terminate_agent', 'hold'];

/** Strip reasoning tags and extract JSON array from LLM response */
export function parseManagerDecisions(raw: string): ManagerDecision[] {
  try {
    // Strip reasoning tags (DeepSeek, etc.)
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // Extract JSON array
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    cleaned = cleaned.slice(start, end + 1);

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((d) => d && typeof d === 'object' && VALID_ACTIONS.includes(d.action))
      .map((d) => ({
        action: d.action as ManagerAction,
        agentId: typeof d.agentId === 'string' ? d.agentId : undefined,
        params: d.params && typeof d.params === 'object' ? d.params : undefined,
        reasoning: typeof d.reasoning === 'string' ? d.reasoning : '',
      }));
  } catch {
    return [];
  }
}

export function buildManagerPrompt(ctx: {
  agents: ManagedAgentSnapshot[];
  marketData: Array<{ pair: string; priceUsd: number; priceChange: Record<string, number | undefined>; indicators?: Record<string, unknown> }>;
  memory: ManagerMemory;
  managerConfig: ManagerConfig;
}): string {
  const { agents: managedAgents, marketData, memory, managerConfig } = ctx;

  const agentSummaries = managedAgents.map((a) => `
Agent: ${a.name} (id: ${a.id})
  Status: ${a.status}
  Pairs: ${a.config.pairs.join(', ')}
  Model: ${a.llmModel} (temp: ${a.config.temperature})
  Performance: PnL=${a.performance.totalPnlPct.toFixed(2)}%, WinRate=${(a.performance.winRate * 100).toFixed(1)}%, Trades=${a.performance.totalTrades}, Sharpe=${a.performance.sharpeRatio?.toFixed(2) ?? 'N/A'}, MaxDD=${a.performance.maxDrawdown != null ? (a.performance.maxDrawdown * 100).toFixed(1) + '%' : 'N/A'}
  Balance: $${a.performance.balance.toFixed(2)}
  Recent trades (last ${a.recentTrades.length}): ${a.recentTrades.map((t) => `${t.side} ${t.pair} PnL=${t.pnlPct?.toFixed(2) ?? 'open'}%`).join(', ') || 'none'}
`).join('\n');

  const marketSummary = marketData.length > 0
    ? marketData.map((m) => `${m.pair}: $${m.priceUsd} (1h: ${m.priceChange.h1 ?? 'N/A'}%, 24h: ${m.priceChange.h24 ?? 'N/A'}%)`).join('\n')
    : 'No market data available';

  const memorySummary = memory.hypotheses.length > 0
    ? memory.hypotheses.map((h) => `- "${h.description}" (tested: ${h.tested_at}, outcome: ${h.outcome}, still_valid: ${h.still_valid})`).join('\n')
    : 'No prior hypotheses.';

  const riskSummary = `MaxDrawdown: ${(managerConfig.riskParams.maxTotalDrawdown * 100).toFixed(0)}%, MaxAgents: ${managerConfig.riskParams.maxAgents}, MaxCorrelated: ${managerConfig.riskParams.maxCorrelatedPositions}`;

  return `You are an Agent Manager overseeing a portfolio of paper trading agents on Base chain DEXes.

## Managed Agents (${managedAgents.length})
${agentSummaries}

## Current Market Conditions
${marketSummary}

## Your Memory (prior decisions and hypotheses)
${memorySummary}

## Risk Limits
${riskSummary}

## Your Task
Evaluate each agent's performance and decide what actions to take this cycle.

Valid actions:
- "create_agent": spawn a new agent with specified params (provide params: { name, pairs, llmModel, temperature, analysisInterval, strategies, paperBalance })
- "pause_agent": pause an underperforming agent (provide agentId)
- "modify_agent": change an agent's parameters (provide agentId + params with fields to change)
- "terminate_agent": permanently stop an agent that is beyond recovery (provide agentId)
- "hold": no action needed for this agent (provide agentId, or omit for portfolio-level hold)

IMPORTANT: Respond with ONLY a valid JSON array — no markdown, no explanation.
Each element: { "action": "<action>", "agentId": "<id or omit>", "params": {<optional>}, "reasoning": "<why>" }

Example:
[
  { "action": "hold", "agentId": "agent_001", "reasoning": "Strong 5% PnL, consistent win rate" },
  { "action": "pause_agent", "agentId": "agent_002", "reasoning": "Drawdown exceeds 15%, needs review" }
]`;
}

/** Execute a single manager decision against D1 + DO stubs */
export async function executeManagerAction(
  decision: ManagerDecision,
  db: ReturnType<typeof drizzle>,
  env: Env,
  managerId: string,
  ownerAddress: string
): Promise<{ success: boolean; detail?: string; error?: string }> {
  const { action, agentId, params, reasoning } = decision;

  switch (action) {
    case 'hold':
      return { success: true, detail: 'No action taken' };

    case 'pause_agent': {
      if (!agentId) return { success: false, error: 'pause_agent requires agentId' };
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return { success: false, error: `Agent ${agentId} not found` };
      if (agent.status === 'running') {
        const doId = env.TRADING_AGENT.idFromName(agentId);
        const stub = env.TRADING_AGENT.get(doId);
        await stub.fetch(new Request('http://do/pause', { method: 'POST' }));
      }
      await db.update(agents).set({ status: 'paused', updatedAt: nowIso() }).where(eq(agents.id, agentId));
      return { success: true, detail: `Agent ${agentId} paused` };
    }

    case 'terminate_agent': {
      if (!agentId) return { success: false, error: 'terminate_agent requires agentId' };
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return { success: false, error: `Agent ${agentId} not found` };
      if (agent.status === 'running' || agent.status === 'paused') {
        const doId = env.TRADING_AGENT.idFromName(agentId);
        const stub = env.TRADING_AGENT.get(doId);
        await stub.fetch(new Request('http://do/stop', { method: 'POST' }));
      }
      await db.update(agents).set({ status: 'stopped', managerId: null, updatedAt: nowIso() }).where(eq(agents.id, agentId));
      return { success: true, detail: `Agent ${agentId} terminated and unlinked from manager` };
    }

    case 'modify_agent': {
      if (!agentId || !params) return { success: false, error: 'modify_agent requires agentId and params' };
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return { success: false, error: `Agent ${agentId} not found` };
      const existingConfig = JSON.parse(agent.config);
      const mergedConfig = { ...existingConfig, ...params };
      await db.update(agents).set({
        config: JSON.stringify(mergedConfig),
        llmModel: (mergedConfig.llmModel ?? agent.llmModel) || 'nvidia/nemotron-3-nano-30b-a3b:free',
        updatedAt: nowIso(),
      }).where(eq(agents.id, agentId));
      return { success: true, detail: `Agent ${agentId} modified` };
    }

    case 'create_agent': {
      if (!params) return { success: false, error: 'create_agent requires params' };
      const id = generateId('agent');
      const now = nowIso();
      const config = {
        name: params.name ?? 'Manager-created Agent',
        autonomyLevel: 'guided',
        llmModel: params.llmModel ?? 'nvidia/nemotron-3-nano-30b-a3b:free',
        temperature: params.temperature ?? 0.7,
        pairs: params.pairs ?? ['WETH/USDC'],
        analysisInterval: params.analysisInterval ?? '1h',
        strategies: params.strategies ?? ['combined'],
        paperBalance: params.paperBalance ?? 10000,
        maxPositionSizePct: params.maxPositionSizePct ?? 5,
        maxOpenPositions: 3,
        stopLossPct: 5,
        takeProfitPct: 7,
        slippageSimulation: 0.3,
        maxDailyLossPct: 10,
        cooldownAfterLossMinutes: 30,
        chain: 'base',
        dexes: ['aerodrome', 'uniswap-v3'],
      };
      await db.insert(agents).values({
        id,
        name: String(params.name ?? 'Manager-created Agent'),
        status: 'stopped',
        autonomyLevel: 2,
        config: JSON.stringify(config),
        llmModel: String(params.llmModel ?? 'nvidia/nemotron-3-nano-30b-a3b:free'),
        ownerAddress,
        managerId,
        createdAt: now,
        updatedAt: now,
      });
      return { success: true, detail: `Agent ${id} created and linked to manager` };
    }

    default:
      return { success: false, error: `Unknown action: ${String(action)}` };
  }
}

/** Run one full manager decision cycle */
export async function runManagerLoop(
  managerId: string,
  env: Env,
  ctx: DurableObjectState
): Promise<void> {
  const db = drizzle(env.DB);

  // 1. Load manager config
  const [managerRow] = await db.select().from(agentManagers).where(eq(agentManagers.id, managerId));
  if (!managerRow) {
    console.log(`[manager-loop] Manager ${managerId} not found`);
    return;
  }
  if (managerRow.status !== 'running') {
    console.log(`[manager-loop] Manager ${managerId} not running (status=${managerRow.status}), skipping`);
    return;
  }

  const config = JSON.parse(managerRow.config) as ManagerConfig;

  // 2. Load all managed agents
  const managedRows = await db.select().from(agents).where(eq(agents.managerId, managerId));
  if (managedRows.length === 0 && config.riskParams.maxAgents > 0) {
    console.log(`[manager-loop] Manager ${managerId}: no managed agents yet`);
  }

  // 3. Build agent snapshots with perf + recent trades
  const agentSnapshots: ManagedAgentSnapshot[] = [];
  for (const row of managedRows) {
    const agentConfig = JSON.parse(row.config) as ManagedAgentSnapshot['config'];

    // Latest performance snapshot
    const [perfRow] = await db
      .select()
      .from(performanceSnapshots)
      .where(eq(performanceSnapshots.agentId, row.id))
      .orderBy(desc(performanceSnapshots.snapshotAt))
      .limit(1);

    // Last 10 trades
    const recentTrades = await db
      .select({ pair: trades.pair, side: trades.side, pnlPct: trades.pnlPct, openedAt: trades.openedAt, closedAt: trades.closedAt })
      .from(trades)
      .where(eq(trades.agentId, row.id))
      .orderBy(desc(trades.openedAt))
      .limit(10);

    agentSnapshots.push({
      id: row.id,
      name: row.name,
      status: row.status,
      llmModel: row.llmModel,
      config: {
        pairs: agentConfig.pairs ?? [],
        strategies: agentConfig.strategies ?? [],
        maxPositionSizePct: agentConfig.maxPositionSizePct ?? 5,
        analysisInterval: agentConfig.analysisInterval ?? '1h',
        paperBalance: agentConfig.paperBalance ?? 10000,
        temperature: agentConfig.temperature ?? 0.7,
      },
      performance: {
        balance: perfRow?.balance ?? agentConfig.paperBalance ?? 10000,
        totalPnlPct: perfRow?.totalPnlPct ?? 0,
        winRate: perfRow?.winRate ?? 0,
        totalTrades: perfRow?.totalTrades ?? 0,
        sharpeRatio: perfRow?.sharpeRatio ?? null,
        maxDrawdown: perfRow?.maxDrawdown ?? null,
      },
      recentTrades,
    });
  }

  // 4. Gather all unique pairs across managed agents
  const allPairs = [...new Set(agentSnapshots.flatMap((a) => a.config.pairs))].slice(0, 5);

  // 5. Fetch market data for managed pairs
  const geckoSvc = createGeckoTerminalService(env.CACHE);
  const dexSvc = createDexDataService(env.CACHE);
  const marketData: Array<{ pair: string; priceUsd: number; priceChange: Record<string, number | undefined>; indicators?: Record<string, unknown> }> = [];

  for (const pairName of allPairs) {
    const query = pairName.replace('/', ' ');
    try {
      const pools = await geckoSvc.searchPools(query);
      const pool = pools.find((p: any) => {
        const tokens = pairName.split('/').map((t) => t.trim().toUpperCase());
        return tokens.every((t: string) => p.name.toUpperCase().includes(t));
      });
      if (pool && pool.priceUsd > 0) {
        marketData.push({ pair: pairName, priceUsd: pool.priceUsd, priceChange: pool.priceChange });
        continue;
      }
    } catch { /* fallthrough */ }

    try {
      const results = await dexSvc.searchPairs(query);
      const basePair = results
        .filter((p: any) => p.chainId === 'base')
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] as any;
      if (basePair) {
        marketData.push({
          pair: pairName,
          priceUsd: getPriceUsd(basePair),
          priceChange: { h1: basePair.priceChange?.h1, h24: basePair.priceChange?.h24 },
        });
      }
    } catch { /* skip */ }
  }

  // 6. Load memory from ctx.storage
  const memory = (await ctx.storage.get<ManagerMemory>('memory')) ?? {
    hypotheses: [],
    parameter_history: [],
    market_regime: null,
    last_evaluation_at: '',
  };

  // 7. Build prompt and call LLM
  const prompt = buildManagerPrompt({ agents: agentSnapshots, marketData, memory, managerConfig: config });

  let rawResponse = '';
  if (!env.OPENROUTER_API_KEY) {
    console.warn(`[manager-loop] ${managerId}: OPENROUTER_API_KEY not set — skipping LLM call`);
    rawResponse = JSON.stringify([{ action: 'hold', reasoning: 'No API key configured' }]);
  } else {
    try {
      const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
      const result = await generateText({
        model: openrouter(config.llmModel),
        messages: [{ role: 'user', content: prompt }],
        temperature: config.temperature,
        maxTokens: 2048,
      });
      rawResponse = result.text;
    } catch (err) {
      console.error(`[manager-loop] ${managerId}: LLM error:`, err);
      rawResponse = JSON.stringify([{ action: 'hold', reasoning: `LLM error: ${String(err)}` }]);
    }
  }

  // 8. Parse decisions
  const decisions = parseManagerDecisions(rawResponse);
  if (decisions.length === 0) {
    console.warn(`[manager-loop] ${managerId}: No valid decisions parsed from LLM response`);
    decisions.push({ action: 'hold', reasoning: 'Could not parse LLM response' });
  }

  // 9. Execute decisions and log each
  for (const decision of decisions) {
    const result = await executeManagerAction(decision, db, env, managerId, managerRow.ownerAddress);
    await db.insert(agentManagerLogs).values({
      id: generateId('mlog'),
      managerId,
      action: decision.action,
      reasoning: decision.reasoning,
      result: JSON.stringify(result),
      createdAt: nowIso(),
    });
    console.log(`[manager-loop] ${managerId}: ${decision.action} → ${JSON.stringify(result)}`);
  }

  // 10. Update memory
  const updatedMemory: ManagerMemory = {
    ...memory,
    last_evaluation_at: nowIso(),
  };
  await ctx.storage.put('memory', updatedMemory);

  console.log(`[manager-loop] ${managerId}: Cycle complete. ${decisions.length} decisions made.`);
}
```

**Step 2: Run tests to verify GREEN**

```bash
npm run test --workspace=apps/api -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|✓|✗)" | head -30
```

Expected: all manager-loop tests PASS

---

## Task 7: AgentManagerDO

**Files:**
- Create: `apps/api/src/agents/agent-manager.ts`

**Step 1: Create the DO (mirrors TradingAgentDO)**

```typescript
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env.js';
import { runManagerLoop } from './manager-loop.js';

function intervalToMs(interval: string): number {
  switch (interval) {
    case '1h': return 60 * 60_000;
    case '4h': return 4 * 60 * 60_000;
    case '1d': return 24 * 60 * 60_000;
    default:   return 60 * 60_000;
  }
}

export class AgentManagerDO extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      const managerId = (await this.ctx.storage.get<string>('managerId')) ?? null;
      const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
      const tickCount = (await this.ctx.storage.get<number>('tickCount')) ?? 0;
      const nextAlarmAt = (await this.ctx.storage.get<number>('nextAlarmAt')) ?? null;
      const memory = await this.ctx.storage.get('memory');
      return Response.json({ managerId, status, tickCount, nextAlarmAt, hasMemory: !!memory });
    }

    if (url.pathname === '/start' && request.method === 'POST') {
      const body = (await request.json()) as { managerId: string; decisionInterval?: string };

      await this.ctx.storage.put('managerId', body.managerId);
      await this.ctx.storage.put('status', 'running');
      await this.ctx.storage.put('decisionInterval', body.decisionInterval ?? '1h');

      const intervalMs = intervalToMs(body.decisionInterval ?? '1h');
      const firstTick = Math.min(5_000, intervalMs);
      const nextAlarmAt = Date.now() + firstTick;
      await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
      await this.ctx.storage.setAlarm(nextAlarmAt);

      return Response.json({ ok: true, status: 'running' });
    }

    if (url.pathname === '/stop' && request.method === 'POST') {
      await this.ctx.storage.put('status', 'stopped');
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true, status: 'stopped' });
    }

    if (url.pathname === '/pause' && request.method === 'POST') {
      await this.ctx.storage.put('status', 'paused');
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true, status: 'paused' });
    }

    return new Response('Not Found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const status = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
    if (status !== 'running') return;

    const managerId = await this.ctx.storage.get<string>('managerId');
    if (!managerId) return;

    const tickCount = ((await this.ctx.storage.get<number>('tickCount')) ?? 0) + 1;
    await this.ctx.storage.put('tickCount', tickCount);

    try {
      await runManagerLoop(managerId, this.env, this.ctx);
    } catch (err) {
      console.error(`[AgentManagerDO] alarm error for ${managerId}:`, err);
    } finally {
      try {
        const currentStatus = (await this.ctx.storage.get<string>('status')) ?? 'stopped';
        if (currentStatus === 'running') {
          const interval = (await this.ctx.storage.get<string>('decisionInterval')) ?? '1h';
          const nextAlarmAt = Date.now() + intervalToMs(interval);
          await this.ctx.storage.put('nextAlarmAt', nextAlarmAt);
          await this.ctx.storage.setAlarm(nextAlarmAt);
        }
      } catch (rescheduleErr) {
        console.error(`[AgentManagerDO] CRITICAL: failed to reschedule alarm for ${managerId}:`, rescheduleErr);
      }
    }
  }
}
```

**Step 2: Export from index.ts**

Add to `apps/api/src/index.ts` after the TradingAgentDO export line:

```typescript
export { AgentManagerDO } from './agents/agent-manager.js';
```

**Step 3: Verify TypeScript**

```bash
cd /workspace && npm run lint 2>&1 | head -30
```

Expected: no errors

---

## Task 8: API routes — RED tests

**Files:**
- Create: `apps/api/src/routes/managers.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// We test the route handlers in isolation by importing the route module
// and binding a mock D1 + DO environment.

describe('GET /api/managers', () => {
  it('returns empty array when no managers exist', async () => {
    // This test will pass once routes/managers.ts is created
    // For now it fails because the module doesn't exist
    const { default: managersRoute } = await import('./managers.js');
    expect(managersRoute).toBeDefined();
  });
});

describe('POST /api/managers', () => {
  it('rejects request missing name', async () => {
    const { CreateManagerRequestSchema } = await import('@dex-agents/shared');
    const result = CreateManagerRequestSchema.safeParse({ llmModel: 'any-model' });
    expect(result.success).toBe(false);
  });

  it('accepts valid create request', async () => {
    const { CreateManagerRequestSchema } = await import('@dex-agents/shared');
    const result = CreateManagerRequestSchema.safeParse({
      name: 'Alpha Manager',
      llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
      decisionInterval: '4h',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Alpha Manager');
      expect(result.data.decisionInterval).toBe('4h');
      expect(result.data.temperature).toBe(0.7); // default
    }
  });
});
```

**Step 2: Run to see RED**

```bash
npm run test --workspace=apps/api -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL)" | head -20
```

Expected: FAIL on the import test (module not found)

---

## Task 9: API routes — GREEN implementation

**Files:**
- Create: `apps/api/src/routes/managers.ts`
- Modify: `apps/api/src/index.ts`

**Step 1: Create routes/managers.ts**

```typescript
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import type { AuthVariables } from '../lib/auth.js';
import { agentManagers, agentManagerLogs, agents } from '../db/schema.js';
import { CreateManagerRequestSchema, UpdateManagerRequestSchema } from '@dex-agents/shared';
import { validateBody, ValidationError } from '../lib/validation.js';
import { generateId, nowIso } from '../lib/utils.js';

const managersRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function formatManager(r: typeof agentManagers.$inferSelect) {
  return {
    ...r,
    config: JSON.parse(r.config),
  };
}

async function requireManagerOwnership(
  db: ReturnType<typeof drizzle>,
  id: string,
  walletAddress: string
): Promise<typeof agentManagers.$inferSelect | null> {
  const [manager] = await db.select().from(agentManagers).where(eq(agentManagers.id, id));
  if (!manager) return null;
  if (manager.ownerAddress !== walletAddress) return null;
  return manager;
}

/** GET /api/managers */
managersRoute.get('/', async (c) => {
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(agentManagers)
    .where(eq(agentManagers.ownerAddress, walletAddress))
    .orderBy(desc(agentManagers.createdAt));
  return c.json({ managers: rows.map(formatManager) });
});

/** POST /api/managers */
managersRoute.post('/', async (c) => {
  const body = await validateBody(c, CreateManagerRequestSchema);
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const id = generateId('mgr');
  const now = nowIso();
  const config = {
    llmModel: body.llmModel,
    temperature: body.temperature,
    decisionInterval: body.decisionInterval,
    riskParams: body.riskParams ?? { maxTotalDrawdown: 0.2, maxAgents: 10, maxCorrelatedPositions: 3 },
  };

  await db.insert(agentManagers).values({
    id,
    name: body.name,
    ownerAddress: walletAddress,
    config: JSON.stringify(config),
    status: 'stopped',
    createdAt: now,
    updatedAt: now,
  });

  const [created] = await db.select().from(agentManagers).where(eq(agentManagers.id, id));
  return c.json(formatManager(created), 201);
});

/** GET /api/managers/:id */
managersRoute.get('/:id', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);
  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  // Include DO status
  const doId = c.env.AGENT_MANAGER.idFromName(id);
  const stub = c.env.AGENT_MANAGER.get(doId);
  let doStatus: Record<string, unknown> = {};
  try {
    const res = await stub.fetch(new Request('http://do/status'));
    doStatus = await res.json() as Record<string, unknown>;
  } catch { /* ignore */ }

  return c.json({ ...formatManager(manager), doStatus });
});

/** PATCH /api/managers/:id */
managersRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const body = await validateBody(c, UpdateManagerRequestSchema);
  const db = drizzle(c.env.DB);

  const existing = await requireManagerOwnership(db, id, walletAddress);
  if (!existing) return c.json({ error: 'Manager not found' }, 404);

  const existingConfig = JSON.parse(existing.config);
  const mergedConfig = { ...existingConfig, ...body };

  await db.update(agentManagers).set({
    name: body.name ?? existing.name,
    config: JSON.stringify(mergedConfig),
    updatedAt: nowIso(),
  }).where(eq(agentManagers.id, id));

  const [updated] = await db.select().from(agentManagers).where(eq(agentManagers.id, id));
  return c.json(formatManager(updated));
});

/** DELETE /api/managers/:id */
managersRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const existing = await requireManagerOwnership(db, id, walletAddress);
  if (!existing) return c.json({ error: 'Manager not found' }, 404);

  if (existing.status === 'running' || existing.status === 'paused') {
    const doId = c.env.AGENT_MANAGER.idFromName(id);
    const stub = c.env.AGENT_MANAGER.get(doId);
    await stub.fetch(new Request('http://do/stop', { method: 'POST' }));
  }

  // Unlink managed agents (don't delete them)
  await db.update(agents).set({ managerId: null }).where(eq(agents.managerId, id));
  await db.delete(agentManagerLogs).where(eq(agentManagerLogs.managerId, id));
  await db.delete(agentManagers).where(eq(agentManagers.id, id));
  return c.json({ ok: true });
});

/** POST /api/managers/:id/start */
managersRoute.post('/:id/start', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  const config = JSON.parse(manager.config) as { decisionInterval?: string };
  const doId = c.env.AGENT_MANAGER.idFromName(id);
  const stub = c.env.AGENT_MANAGER.get(doId);

  await stub.fetch(new Request('http://do/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ managerId: id, decisionInterval: config.decisionInterval ?? '1h' }),
  }));

  await db.update(agentManagers).set({ status: 'running', updatedAt: nowIso() }).where(eq(agentManagers.id, id));
  return c.json({ ok: true, status: 'running' });
});

/** POST /api/managers/:id/stop */
managersRoute.post('/:id/stop', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  const doId = c.env.AGENT_MANAGER.idFromName(id);
  const stub = c.env.AGENT_MANAGER.get(doId);
  await stub.fetch(new Request('http://do/stop', { method: 'POST' }));

  await db.update(agentManagers).set({ status: 'stopped', updatedAt: nowIso() }).where(eq(agentManagers.id, id));
  return c.json({ ok: true, status: 'stopped' });
});

/** POST /api/managers/:id/pause */
managersRoute.post('/:id/pause', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  const doId = c.env.AGENT_MANAGER.idFromName(id);
  const stub = c.env.AGENT_MANAGER.get(doId);
  await stub.fetch(new Request('http://do/pause', { method: 'POST' }));

  await db.update(agentManagers).set({ status: 'paused', updatedAt: nowIso() }).where(eq(agentManagers.id, id));
  return c.json({ ok: true, status: 'paused' });
});

/** GET /api/managers/:id/logs?page=1&limit=20 */
managersRoute.get('/:id/logs', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10)));
  const offset = (page - 1) * limit;

  const logs = await db
    .select()
    .from(agentManagerLogs)
    .where(eq(agentManagerLogs.managerId, id))
    .orderBy(desc(agentManagerLogs.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    logs: logs.map((l) => ({ ...l, result: JSON.parse(l.result) })),
    page,
    limit,
  });
});

/** GET /api/managers/:id/agents */
managersRoute.get('/:id/agents', async (c) => {
  const id = c.req.param('id');
  const walletAddress = c.get('walletAddress');
  const db = drizzle(c.env.DB);

  const manager = await requireManagerOwnership(db, id, walletAddress);
  if (!manager) return c.json({ error: 'Manager not found' }, 404);

  const managedAgents = await db.select().from(agents).where(eq(agents.managerId, id));
  return c.json({
    agents: managedAgents.map((r) => ({
      ...r,
      config: JSON.parse(r.config),
    })),
  });
});

export default managersRoute;
```

**Step 2: Register route in index.ts**

In `apps/api/src/index.ts`:

Add import:
```typescript
import managersRoute from './routes/managers.js';
```

Add auth middleware (after the existing `/api/compare/*` middleware line):
```typescript
app.use('/api/managers/*', authMiddleware as any);
```

Add route (after the compare route):
```typescript
app.route('/api/managers', managersRoute);
```

Also add to the routes array in the root handler:
```
'GET  /api/managers',
'POST /api/managers',
'GET  /api/managers/:id',
'PATCH /api/managers/:id',
'DELETE /api/managers/:id',
'POST /api/managers/:id/start',
'POST /api/managers/:id/stop',
'POST /api/managers/:id/pause',
'GET  /api/managers/:id/logs',
'GET  /api/managers/:id/agents',
```

**Step 3: Run all tests**

```bash
npm run test --workspace=apps/api -- --reporter=verbose 2>&1 | tail -30
```

Expected: all tests pass

**Step 4: Build to verify no type errors**

```bash
cd /workspace && npm run build 2>&1 | tail -20
```

Expected: build succeeds

---

## Task 10: Frontend — ManagerConfigForm.vue

**Files:**
- Create: `apps/web/components/ManagerConfigForm.vue`

**Step 1: Create the component**

```vue
<template>
  <form @submit.prevent="handleSubmit" class="space-y-6">
    <div>
      <label class="block text-sm font-medium text-gray-400 mb-1">Name</label>
      <input
        v-model="form.name"
        type="text"
        maxlength="50"
        placeholder="Alpha Manager"
        class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-green-500"
        required
      />
    </div>

    <div>
      <label class="block text-sm font-medium text-gray-400 mb-1">LLM Model</label>
      <select
        v-model="form.llmModel"
        class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-green-500"
      >
        <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option>
      </select>
    </div>

    <div>
      <label class="block text-sm font-medium text-gray-400 mb-1">
        Temperature: {{ form.temperature.toFixed(1) }}
        <span class="text-xs text-gray-500 ml-2">Lower = more deterministic, Higher = more creative</span>
      </label>
      <input
        v-model.number="form.temperature"
        type="range"
        min="0" max="2" step="0.1"
        class="w-full accent-green-500"
      />
    </div>

    <div>
      <label class="block text-sm font-medium text-gray-400 mb-1">Decision Interval</label>
      <select
        v-model="form.decisionInterval"
        class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-green-500"
      >
        <option value="1h">Every 1 hour</option>
        <option value="4h">Every 4 hours</option>
        <option value="1d">Every 24 hours</option>
      </select>
    </div>

    <fieldset class="border border-gray-700 rounded p-4">
      <legend class="text-sm font-medium text-gray-400 px-2">Risk Parameters</legend>
      <div class="space-y-4 mt-2">
        <div>
          <label class="block text-sm text-gray-400 mb-1">Max Total Drawdown: {{ (form.riskParams.maxTotalDrawdown * 100).toFixed(0) }}%</label>
          <input v-model.number="form.riskParams.maxTotalDrawdown" type="range" min="0.01" max="1" step="0.01" class="w-full accent-green-500" />
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Max Agents: {{ form.riskParams.maxAgents }}</label>
          <input v-model.number="form.riskParams.maxAgents" type="range" min="1" max="20" step="1" class="w-full accent-green-500" />
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Max Correlated Positions: {{ form.riskParams.maxCorrelatedPositions }}</label>
          <input v-model.number="form.riskParams.maxCorrelatedPositions" type="range" min="1" max="10" step="1" class="w-full accent-green-500" />
        </div>
      </div>
    </fieldset>

    <div v-if="error" class="text-red-400 text-sm">{{ error }}</div>

    <div class="flex gap-3">
      <button
        type="submit"
        :disabled="loading"
        class="flex-1 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-medium py-2 px-4 rounded transition-colors"
      >
        {{ loading ? 'Saving…' : (isEdit ? 'Save Changes' : 'Create Manager') }}
      </button>
      <button
        v-if="onCancel"
        type="button"
        @click="onCancel"
        class="px-4 py-2 border border-gray-600 text-gray-400 hover:text-white rounded transition-colors"
      >
        Cancel
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';

const props = defineProps<{
  initial?: {
    name?: string;
    llmModel?: string;
    temperature?: number;
    decisionInterval?: string;
    riskParams?: { maxTotalDrawdown: number; maxAgents: number; maxCorrelatedPositions: number };
  };
  isEdit?: boolean;
  onCancel?: () => void;
}>();

const emit = defineEmits<{ (e: 'submit', value: typeof form): void }>();

const loading = ref(false);
const error = ref('');

const form = reactive({
  name: props.initial?.name ?? '',
  llmModel: props.initial?.llmModel ?? 'nvidia/nemotron-3-nano-30b-a3b:free',
  temperature: props.initial?.temperature ?? 0.7,
  decisionInterval: props.initial?.decisionInterval ?? '1h',
  riskParams: {
    maxTotalDrawdown: props.initial?.riskParams?.maxTotalDrawdown ?? 0.2,
    maxAgents: props.initial?.riskParams?.maxAgents ?? 10,
    maxCorrelatedPositions: props.initial?.riskParams?.maxCorrelatedPositions ?? 3,
  },
});

// Fetch models from API
const models = ref([{ id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nvidia Nemotron Nano 30B (free)' }]);
const { data: modelsData } = await useFetch('/api/models').catch(() => ({ data: ref(null) }));
if (modelsData.value?.models) models.value = modelsData.value.models;

async function handleSubmit() {
  error.value = '';
  if (!form.name.trim()) { error.value = 'Name is required'; return; }
  loading.value = true;
  try {
    emit('submit', { ...form });
  } finally {
    loading.value = false;
  }
}
</script>
```

---

## Task 11: Frontend — ManagerCard.vue

**Files:**
- Create: `apps/web/components/ManagerCard.vue`

```vue
<template>
  <NuxtLink :to="`/managers/${manager.id}`" class="block">
    <div class="bg-gray-900 border border-gray-700 rounded-lg p-4 hover:border-green-700 transition-colors">
      <div class="flex items-start justify-between mb-3">
        <h3 class="text-white font-semibold truncate">{{ manager.name }}</h3>
        <span :class="statusClass" class="text-xs px-2 py-0.5 rounded-full font-medium ml-2 shrink-0">
          {{ manager.status }}
        </span>
      </div>
      <div class="text-sm text-gray-400 space-y-1">
        <div>Model: <span class="text-gray-300">{{ shortModel }}</span></div>
        <div>Interval: <span class="text-gray-300">{{ manager.config?.decisionInterval ?? '—' }}</span></div>
        <div>Agents: <span class="text-gray-300">{{ agentCount }}</span></div>
      </div>
      <div class="mt-3 text-xs text-gray-600">
        Created {{ new Date(manager.createdAt).toLocaleDateString() }}
      </div>
    </div>
  </NuxtLink>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  manager: {
    id: string;
    name: string;
    status: string;
    config: { llmModel?: string; decisionInterval?: string } | null;
    createdAt: string;
  };
  agentCount?: number;
}>();

const statusClass = computed(() => ({
  'bg-green-900 text-green-300': props.manager.status === 'running',
  'bg-yellow-900 text-yellow-300': props.manager.status === 'paused',
  'bg-gray-800 text-gray-400': props.manager.status === 'stopped',
}));

const shortModel = computed(() => {
  const m = props.manager.config?.llmModel ?? '';
  return m.split('/').pop()?.replace(':free', '') ?? m;
});
</script>
```

---

## Task 12: Frontend — /managers page

**Files:**
- Create: `apps/web/pages/managers/index.vue`

```vue
<template>
  <div class="p-6 max-w-6xl mx-auto">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-white">Agent Managers</h1>
      <NuxtLink to="/managers/new" class="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded text-sm font-medium transition-colors">
        + New Manager
      </NuxtLink>
    </div>

    <div v-if="pending" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div v-for="i in 3" :key="i" class="bg-gray-900 border border-gray-800 rounded-lg p-4 animate-pulse">
        <div class="h-5 bg-gray-800 rounded w-2/3 mb-3" />
        <div class="h-4 bg-gray-800 rounded w-1/2 mb-2" />
        <div class="h-4 bg-gray-800 rounded w-1/3" />
      </div>
    </div>

    <div v-else-if="managers.length === 0" class="text-center py-20 text-gray-500">
      <p class="text-lg mb-2">No managers yet</p>
      <p class="text-sm">Create a manager to autonomously run and optimize your trading agents.</p>
    </div>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <ManagerCard
        v-for="m in managers"
        :key="m.id"
        :manager="m"
        :agent-count="agentCounts[m.id] ?? 0"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

definePageMeta({ middleware: 'auth' });

const { data, pending } = await useFetch('/api/managers');
const managers = computed(() => data.value?.managers ?? []);
const agentCounts = ref<Record<string, number>>({});
</script>
```

---

## Task 13: Frontend — /managers/new page

**Files:**
- Create: `apps/web/pages/managers/new.vue`

```vue
<template>
  <div class="p-6 max-w-2xl mx-auto">
    <div class="flex items-center gap-3 mb-6">
      <NuxtLink to="/managers" class="text-gray-400 hover:text-white text-sm">← Managers</NuxtLink>
      <h1 class="text-xl font-bold text-white">New Manager</h1>
    </div>
    <div class="bg-gray-900 border border-gray-700 rounded-lg p-6">
      <ManagerConfigForm @submit="handleCreate" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';

definePageMeta({ middleware: 'auth' });

const router = useRouter();

async function handleCreate(form: Record<string, unknown>) {
  await $fetch('/api/managers', {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
  router.push('/managers');
}
</script>
```

---

## Task 14: Frontend — /managers/[id] detail page

**Files:**
- Create: `apps/web/pages/managers/[id].vue`

```vue
<template>
  <div class="p-6 max-w-6xl mx-auto">
    <div class="flex items-center gap-3 mb-6">
      <NuxtLink to="/managers" class="text-gray-400 hover:text-white text-sm">← Managers</NuxtLink>
      <h1 class="text-xl font-bold text-white truncate">{{ manager?.name }}</h1>
      <span v-if="manager" :class="statusClass" class="text-xs px-2 py-0.5 rounded-full">{{ manager.status }}</span>
    </div>

    <div v-if="pending" class="text-gray-400">Loading…</div>
    <div v-else-if="!manager" class="text-red-400">Manager not found.</div>
    <div v-else class="space-y-6">

      <!-- Controls -->
      <div class="flex gap-3">
        <button v-if="manager.status !== 'running'" @click="start" class="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded text-sm font-medium">Start</button>
        <button v-if="manager.status === 'running'" @click="pause" class="bg-yellow-700 hover:bg-yellow-600 text-white px-4 py-2 rounded text-sm font-medium">Pause</button>
        <button v-if="manager.status !== 'stopped'" @click="stop" class="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded text-sm font-medium">Stop</button>
        <NuxtLink :to="`/managers/${manager.id}/edit`" class="border border-gray-600 text-gray-400 hover:text-white px-4 py-2 rounded text-sm transition-colors">Edit</NuxtLink>
      </div>

      <!-- Managed Agents -->
      <section>
        <h2 class="text-lg font-semibold text-white mb-3">Managed Agents ({{ managedAgents.length }})</h2>
        <div v-if="managedAgents.length === 0" class="text-gray-500 text-sm">No agents yet. The manager will create them based on its strategy.</div>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-gray-400 border-b border-gray-700">
              <tr>
                <th class="text-left py-2 pr-4">Name</th>
                <th class="text-left py-2 pr-4">Status</th>
                <th class="text-left py-2 pr-4">Pairs</th>
                <th class="text-left py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in managedAgents" :key="a.id" class="border-b border-gray-800">
                <td class="py-2 pr-4">
                  <NuxtLink :to="`/agents/${a.id}`" class="text-green-400 hover:underline">{{ a.name }}</NuxtLink>
                </td>
                <td class="py-2 pr-4 text-gray-300">{{ a.status }}</td>
                <td class="py-2 pr-4 text-gray-400 text-xs">{{ a.config?.pairs?.join(', ') }}</td>
                <td class="py-2">
                  <NuxtLink :to="`/agents/${a.id}`" class="text-xs text-gray-500 hover:text-white">View →</NuxtLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Decision Logs -->
      <section>
        <h2 class="text-lg font-semibold text-white mb-3">Recent Decisions</h2>
        <div v-if="logs.length === 0" class="text-gray-500 text-sm">No decisions logged yet.</div>
        <div v-else class="space-y-2">
          <div v-for="log in logs" :key="log.id" class="bg-gray-900 border border-gray-800 rounded p-3 text-sm">
            <div class="flex items-center gap-2 mb-1">
              <span :class="actionClass(log.action)" class="px-2 py-0.5 rounded text-xs font-medium">{{ log.action }}</span>
              <span class="text-gray-500 text-xs">{{ new Date(log.createdAt).toLocaleString() }}</span>
            </div>
            <p class="text-gray-300">{{ log.reasoning }}</p>
            <p v-if="log.result?.detail" class="text-gray-500 text-xs mt-1">{{ log.result.detail }}</p>
          </div>
        </div>
        <button v-if="logs.length === 20" @click="loadMoreLogs" class="mt-3 text-sm text-gray-500 hover:text-white">Load more…</button>
      </section>

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRoute } from 'vue-router';

definePageMeta({ middleware: 'auth' });

const route = useRoute();
const id = route.params.id as string;

const { data, pending, refresh } = await useFetch(`/api/managers/${id}`);
const manager = computed(() => data.value ?? null);

const { data: agentsData } = await useFetch(`/api/managers/${id}/agents`);
const managedAgents = computed(() => agentsData.value?.agents ?? []);

const { data: logsData } = await useFetch(`/api/managers/${id}/logs`);
const logs = ref(logsData.value?.logs ?? []);

const statusClass = computed(() => ({
  'bg-green-900 text-green-300': manager.value?.status === 'running',
  'bg-yellow-900 text-yellow-300': manager.value?.status === 'paused',
  'bg-gray-800 text-gray-400': manager.value?.status === 'stopped',
}));

function actionClass(action: string) {
  if (action === 'create_agent') return 'bg-blue-900 text-blue-300';
  if (action === 'pause_agent' || action === 'terminate_agent') return 'bg-red-900 text-red-300';
  if (action === 'modify_agent') return 'bg-yellow-900 text-yellow-300';
  return 'bg-gray-800 text-gray-400';
}

async function start() {
  await $fetch(`/api/managers/${id}/start`, { method: 'POST', credentials: 'include' });
  refresh();
}
async function stop() {
  await $fetch(`/api/managers/${id}/stop`, { method: 'POST', credentials: 'include' });
  refresh();
}
async function pause() {
  await $fetch(`/api/managers/${id}/pause`, { method: 'POST', credentials: 'include' });
  refresh();
}
async function loadMoreLogs() {
  const next = await $fetch<{ logs: typeof logs.value }>(`/api/managers/${id}/logs?page=2`);
  logs.value.push(...(next.logs ?? []));
}
</script>
```

---

## Task 15: Frontend — navigation link

**Files:**
- Modify: `apps/web/app.vue` OR the layout file that contains navigation

**Step 1: Find the nav file**

```bash
grep -r "agents" /workspace/apps/web/layouts/ --include="*.vue" -l 2>/dev/null || grep -r "NuxtLink" /workspace/apps/web/app.vue
```

**Step 2: Add Managers link**

Find the navigation section and add after the Agents link:

```html
<NuxtLink to="/managers" class="...same classes as existing nav links...">Managers</NuxtLink>
```

---

## Task 16: Run full test suite

```bash
npm run test --workspace=apps/api -- --reporter=verbose 2>&1 | tail -40
```

Expected: all tests pass

```bash
npm run build 2>&1 | tail -20
```

Expected: build succeeds with no type errors

---

## Notes

- Research agents (step 6 from execution-plan.md Phase F) are marked TODO in `manager-loop.ts` — not implemented in this phase
- A/B testing: TODO comment in code
- In-app alerting: TODO comment in code
- The `manager_id` column addition via `ALTER TABLE` must happen before the `agent_managers` table create in the migration (SQLite requires FK targets to exist)

  **CORRECTION**: SQLite does not enforce FK order in `CREATE TABLE` the same way — but it's safest to create `agent_managers` first, then alter `agents`. Reorder migration accordingly:

  ```sql
  CREATE TABLE IF NOT EXISTS agent_managers (...);
  CREATE TABLE IF NOT EXISTS agent_manager_logs (...);
  ALTER TABLE agents ADD COLUMN manager_id TEXT REFERENCES agent_managers(id);
  ```
