/**
 * Agent Manager decision loop.
 * Called by AgentManagerDO.alarm() on each scheduled tick.
 * Flow: load managed agents → fetch perf + trades → market data →
 *       load memory → build prompt → LLM call → parse decisions →
 *       execute actions → log to D1 → update memory
 */
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc } from 'drizzle-orm';
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { Env } from '../types/env.js';
import { agents, trades, performanceSnapshots, agentManagers, agentManagerLogs } from '../db/schema.js';
import { createDexDataService, getPriceUsd } from '../services/dex-data.js';
import { createGeckoTerminalService } from '../services/gecko-terminal.js';
import { generateId, nowIso } from '../lib/utils.js';
import type { ManagerConfig } from '@dex-agents/shared';

export type ManagerAction = 'create_agent' | 'start_agent' | 'pause_agent' | 'modify_agent' | 'terminate_agent' | 'hold';

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

const VALID_ACTIONS: ManagerAction[] = ['create_agent', 'start_agent', 'pause_agent', 'modify_agent', 'terminate_agent', 'hold'];

// Restrict manager-created agents to free OpenRouter models only, to avoid accidental paid usage.
const FREE_AGENT_MODELS = new Set<string>([
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'stepfun/step-3.5-flash:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'arcee-ai/trinity-large-preview:free',
]);

function normaliseAgentModel(requested: unknown): string {
  const fallback = 'nvidia/nemotron-3-nano-30b-a3b:free';
  if (typeof requested !== 'string') return fallback;
  return FREE_AGENT_MODELS.has(requested) ? requested : fallback;
}

/** Find the index of the bracket/brace that closes the one opened at `openIdx`. */
function findClosingBracket(str: string, openIdx: number): number {
  const open = str[openIdx];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    if (ch === close) { if (--depth === 0) return i; }
  }
  return -1;
}

function normaliseParsed(items: unknown[]): ManagerDecision[] {
  return items
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && VALID_ACTIONS.includes((d as any).action))
    .map((d) => ({
      action: d.action as ManagerAction,
      agentId: typeof d.agentId === 'string' ? d.agentId : undefined,
      params: d.params && typeof d.params === 'object' ? d.params as Record<string, unknown> : undefined,
      reasoning: typeof d.reasoning === 'string' ? d.reasoning : '',
    }));
}

/** Strip reasoning tags and extract JSON array (or single object) from LLM response */
export function parseManagerDecisions(raw: string): ManagerDecision[] {
  // Strip reasoning tags (DeepSeek, Qwen thinking, etc.)
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Strip markdown code fences
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/s);
  if (fenced) cleaned = fenced[1].trim();

  // Strategy 1: find first `[` and its proper matching `]`
  const arrStart = cleaned.indexOf('[');
  if (arrStart !== -1) {
    const arrEnd = findClosingBracket(cleaned, arrStart);
    if (arrEnd !== -1) {
      try {
        const parsed = JSON.parse(cleaned.slice(arrStart, arrEnd + 1));
        if (Array.isArray(parsed)) {
          const decisions = normaliseParsed(parsed);
          if (decisions.length > 0) return decisions;
        }
      } catch { /* fall through */ }
    }
  }

  // Strategy 2: model returned a single JSON object instead of an array
  const objStart = cleaned.indexOf('{');
  if (objStart !== -1) {
    const objEnd = findClosingBracket(cleaned, objStart);
    if (objEnd !== -1) {
      try {
        const parsed = JSON.parse(cleaned.slice(objStart, objEnd + 1));
        const decisions = normaliseParsed([parsed]);
        if (decisions.length > 0) return decisions;
      } catch { /* fall through */ }
    }
  }

  return [];
}

export function buildManagerPrompt(ctx: {
  agents: ManagedAgentSnapshot[];
  marketData: Array<{ pair: string; priceUsd: number; priceChange: Record<string, number | undefined>; indicators?: Record<string, unknown> }>;
  memory: ManagerMemory;
  managerConfig: ManagerConfig;
}): string {
  const { agents: managedAgents, marketData, memory, managerConfig } = ctx;

  const agentSummaries = managedAgents.map((a) =>
    `Agent: ${a.name} (id: ${a.id})\n` +
    `  Status: ${a.status} | Pairs: ${a.config.pairs.join(', ')} | Model: ${a.llmModel} temp=${a.config.temperature}\n` +
    `  PnL: ${a.performance.totalPnlPct.toFixed(2)}% | WinRate: ${(a.performance.winRate * 100).toFixed(1)}% | Trades: ${a.performance.totalTrades} | Sharpe: ${a.performance.sharpeRatio?.toFixed(2) ?? 'N/A'} | MaxDD: ${a.performance.maxDrawdown != null ? (a.performance.maxDrawdown * 100).toFixed(1) + '%' : 'N/A'}\n` +
    `  Balance: $${a.performance.balance.toFixed(2)}\n` +
    `  Recent trades: ${a.recentTrades.map((t) => `${t.side} ${t.pair} PnL=${t.pnlPct?.toFixed(2) ?? 'open'}%`).join(', ') || 'none'}`
  ).join('\n\n');

  const marketSummary = marketData.length > 0
    ? marketData.map((m) => `${m.pair}: $${m.priceUsd} (1h: ${m.priceChange.h1 ?? 'N/A'}%, 24h: ${m.priceChange.h24 ?? 'N/A'}%)`).join('\n')
    : 'No market data available';

  const memorySummary = memory.hypotheses.length > 0
    ? memory.hypotheses.map((h) => `- "${h.description}" (tested: ${h.tested_at}, outcome: ${h.outcome}, valid: ${h.still_valid})`).join('\n')
    : 'No prior hypotheses.';

  const riskSummary = `MaxDrawdown: ${(managerConfig.riskParams.maxTotalDrawdown * 100).toFixed(0)}%, MaxAgents: ${managerConfig.riskParams.maxAgents}, MaxCorrelated: ${managerConfig.riskParams.maxCorrelatedPositions}`;

  return `You are an Agent Manager overseeing a portfolio of paper trading agents on Base chain DEXes.

## Managed Agents (${managedAgents.length})
${agentSummaries || 'No agents yet.'}

## Current Market Conditions
${marketSummary}

## Memory & Hypotheses
${memorySummary}

## Risk Limits
${riskSummary}

## Model Cost Constraints
You must use only the following free OpenRouter models when creating or modifying agents:
- "nvidia/nemotron-3-nano-30b-a3b:free"
- "stepfun/step-3.5-flash:free"
- "nvidia/nemotron-nano-9b-v2:free"
- "arcee-ai/trinity-large-preview:free"

Never propose or use any paid or other model IDs (no OpenAI, GPT-4, GPT-3.5, etc). If unsure, default to "nvidia/nemotron-3-nano-30b-a3b:free".

## Instructions
Evaluate each agent's performance and decide what actions to take this cycle.

Valid actions:
- "create_agent": spawn a new agent (provide params: { name, pairs, llmModel, temperature, analysisInterval, strategies, paperBalance })
- "start_agent": start a stopped or paused agent (provide agentId)
- "pause_agent": pause an underperforming agent (provide agentId)
- "modify_agent": change agent parameters (provide agentId + params)
- "terminate_agent": permanently stop an agent (provide agentId)
- "hold": no action needed (provide agentId, or omit for portfolio-level hold)

IMPORTANT: Respond with ONLY a valid JSON array — no markdown, no explanation.
Each element: { "action": "<action>", "agentId": "<id or omit>", "params": {<optional>}, "reasoning": "<why>" }

Example:
[
  { "action": "hold", "agentId": "agent_001", "reasoning": "Strong performance, no changes needed" },
  { "action": "pause_agent", "agentId": "agent_002", "reasoning": "Drawdown exceeds 15%" }
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
  const { action, agentId, params } = decision;

  switch (action) {
    case 'hold':
      return { success: true, detail: 'No action taken' };

    case 'start_agent': {
      if (!agentId) return { success: false, error: 'start_agent requires agentId' };
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return { success: false, error: `Agent ${agentId} not found` };
      if (agent.status === 'running') return { success: true, detail: `Agent ${agentId} already running` };
      const agentConfig = JSON.parse(agent.config) as { paperBalance?: number; slippageSimulation?: number; analysisInterval?: string };
      const doId = env.TRADING_AGENT.idFromName(agentId);
      const stub = env.TRADING_AGENT.get(doId);
      await stub.fetch(new Request('http://do/start', {
        method: 'POST',
        body: JSON.stringify({
          agentId,
          paperBalance: agentConfig.paperBalance ?? 10000,
          slippageSimulation: agentConfig.slippageSimulation ?? 0.3,
          analysisInterval: agentConfig.analysisInterval ?? '1h',
        }),
      }));
      await db.update(agents).set({ status: 'running', updatedAt: nowIso() }).where(eq(agents.id, agentId));
      return { success: true, detail: `Agent ${agentId} started` };
    }

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
      return { success: true, detail: `Agent ${agentId} terminated` };
    }

    case 'modify_agent': {
      if (!agentId || !params) return { success: false, error: 'modify_agent requires agentId and params' };
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return { success: false, error: `Agent ${agentId} not found` };
      const existingConfig = JSON.parse(agent.config);
      const patch: Record<string, unknown> = { ...params };
      if (typeof patch.llmModel === 'string') {
        patch.llmModel = normaliseAgentModel(patch.llmModel);
      }
      const mergedConfig = { ...existingConfig, ...patch };
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
      const paperBalance = Number(params.paperBalance ?? 10000);
      const slippageSimulation = 0.3;
      const analysisInterval = String(params.analysisInterval ?? '1h');
      const llmModel = normaliseAgentModel(params.llmModel);
      const config = {
        name: params.name ?? 'Manager-created Agent',
        autonomyLevel: 'guided',
        llmModel,
        temperature: params.temperature ?? 0.7,
        pairs: params.pairs ?? ['WETH/USDC'],
        analysisInterval,
        strategies: params.strategies ?? ['combined'],
        paperBalance,
        maxPositionSizePct: params.maxPositionSizePct ?? 5,
        maxOpenPositions: 3,
        stopLossPct: 5,
        takeProfitPct: 7,
        slippageSimulation,
        maxDailyLossPct: 10,
        cooldownAfterLossMinutes: 30,
        chain: 'base',
        dexes: ['aerodrome', 'uniswap-v3'],
        maxLlmCallsPerHour: 12,
        allowFallback: false,
        llmFallback: 'nvidia/nemotron-3-nano-30b-a3b:free',
      };
      await db.insert(agents).values({
        id,
        name: String(params.name ?? 'Manager-created Agent'),
        status: 'running',
        autonomyLevel: 2,
        config: JSON.stringify(config),
        llmModel,
        ownerAddress,
        managerId,
        createdAt: now,
        updatedAt: now,
      });
      // Start the TradingAgentDO immediately
      const doId = env.TRADING_AGENT.idFromName(id);
      const stub = env.TRADING_AGENT.get(doId);
      await stub.fetch(new Request('http://do/start', {
        method: 'POST',
        body: JSON.stringify({ agentId: id, paperBalance, slippageSimulation, analysisInterval }),
      }));
      return { success: true, detail: `Agent ${id} created and started` };
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

  // 3. Build agent snapshots with perf + recent trades
  const agentSnapshots: ManagedAgentSnapshot[] = [];
  for (const row of managedRows) {
    const agentConfig = JSON.parse(row.config) as ManagedAgentSnapshot['config'];

    const [perfRow] = await db
      .select()
      .from(performanceSnapshots)
      .where(eq(performanceSnapshots.agentId, row.id))
      .orderBy(desc(performanceSnapshots.snapshotAt))
      .limit(1);

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

  // 5. Fetch market data
  const geckoSvc = createGeckoTerminalService(env.CACHE);
  const dexSvc = createDexDataService(env.CACHE);
  const marketData: Array<{ pair: string; priceUsd: number; priceChange: Record<string, number | undefined> }> = [];

  for (const pairName of allPairs) {
    const query = pairName.replace('/', ' ');
    try {
      const pools = await geckoSvc.searchPools(query);
      const pool = pools.find((p: any) => {
        const tokens = pairName.split('/').map((t: string) => t.trim().toUpperCase());
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

  // 6. Load memory from DO storage
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
    console.warn(`[manager-loop] ${managerId}: OPENROUTER_API_KEY not set — holding`);
    rawResponse = JSON.stringify([{ action: 'hold', reasoning: 'No API key configured' }]);
  } else {
    try {
      const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
      const result = await generateText({
        model: openrouter(config.llmModel),
        messages: [{ role: 'user', content: prompt }],
        temperature: config.temperature,
        maxOutputTokens: 2048,
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
    const preview = rawResponse.slice(0, 500);
    console.warn(`[manager-loop] ${managerId}: No valid decisions parsed. Raw response (first 500 chars): ${preview}`);
    decisions.push({
      action: 'hold',
      // Use the raw model output as the human-readable reasoning instead of a scary parse error.
      reasoning: preview || 'Holding this cycle (no structured decisions returned by model).',
    });
  }

  // 9. Execute and log each decision
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

  // 10. Update memory timestamp
  const updatedMemory: ManagerMemory = { ...memory, last_evaluation_at: nowIso() };
  await ctx.storage.put('memory', updatedMemory);

  console.log(`[manager-loop] ${managerId}: Cycle complete. ${decisions.length} decisions.`);
}
