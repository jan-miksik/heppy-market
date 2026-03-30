/**
 * Agent Manager decision loop.
 * Called by AgentManagerDO.alarm() on each scheduled tick.
 * Flow: load managed agents → fetch perf + trades → market data →
 *       load memory → build prompt → LLM call → parse decisions →
 *       execute actions → log to D1 → update memory
 */
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, inArray, sql } from 'drizzle-orm';
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { Env } from '../types/env.js';
import { agents, trades, performanceSnapshots, agentManagers, agentManagerLogs, users } from '../db/schema.js';
import { decryptKey } from '../lib/crypto.js';
import { createDexDataService, getPriceUsd } from '../services/dex-data.js';
import { createGeckoTerminalService } from '../services/gecko-terminal.js';
import { generateId, nowIso } from '../lib/utils.js';
import { normalizePairsForDex } from '../lib/pairs.js';
import { normalizeManagerDecisionInterval } from '../lib/manager-interval-sync.js';
import type { ManagerConfig } from '@something-in-loop/shared';
import { filterSupportedBasePairs, SUPPORTED_BASE_PAIRS, getAgentPersonaTemplate, getDefaultAgentPersona, AGENT_PROFILES } from '@something-in-loop/shared';

const MANAGER_LLM_TIMEOUT_MS = 60_000; // 60s — generous for manager's larger prompt

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

const DEFAULT_FREE_AGENT_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

const FREE_AGENT_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'qwen/qwen3-coder:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'arcee-ai/trinity-large-preview:free',
];

// Keep manager-paid options intentionally narrow: low-cost models only.
// For now, cap to models with <= $3 / 1M input and output tokens.
const PAID_CHEAP_AGENT_MODELS = [
  'google/gemini-3.1-flash-lite-preview',
  'deepseek/deepseek-v3.2',
  'minimax/minimax-m2.5',
  'mistralai/mistral-small-2603',
];

function buildAllowedAgentModels(hasUserOpenRouterKey: boolean): Set<string> {
  const allowed = new Set(FREE_AGENT_MODELS);
  if (hasUserOpenRouterKey) {
    for (const modelId of PAID_CHEAP_AGENT_MODELS) allowed.add(modelId);
  }
  return allowed;
}

function normaliseAgentModel(requested: unknown, allowedModels: Set<string>): string {
  const fallback = DEFAULT_FREE_AGENT_MODEL;
  if (typeof requested !== 'string') return fallback;
  return allowedModels.has(requested) ? requested : fallback;
}

const VALID_AGENT_ANALYSIS_INTERVALS = new Set(['1h', '4h', '1d']);
const LEGACY_AGENT_INTERVAL_MAP: Record<string, string> = {
  '60': '1h',
  '300': '1h',
  '900': '1h',
  '3600': '1h',
  '14400': '4h',
  '86400': '1d',
};

function normalizeRawAnalysisInterval(value: unknown): string | null {
  const raw = typeof value === 'number' && Number.isFinite(value)
    ? String(Math.trunc(value))
    : value;
  if (typeof raw !== 'string') return null;

  let interval = raw.trim();
  if (!interval) return null;

  if (LEGACY_AGENT_INTERVAL_MAP[interval]) interval = LEGACY_AGENT_INTERVAL_MAP[interval];
  if (interval === '1m' || interval === '5m' || interval === '15m') interval = '1h';

  return VALID_AGENT_ANALYSIS_INTERVALS.has(interval) ? interval : null;
}

export function normalizeManagerAnalysisInterval(value: unknown, fallback: string = '1h'): string {
  const normalized = normalizeRawAnalysisInterval(value);
  if (normalized) return normalized;
  const fallbackNormalized = normalizeRawAnalysisInterval(fallback);
  return fallbackNormalized ?? '1h';
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

function computeAutoClosings(prefix: string): string | null {
  const stack: Array<'[' | '{'> = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '[' || ch === '{') stack.push(ch);
    if (ch === ']' || ch === '}') {
      const expected: '[' | '{' = ch === ']' ? '[' : '{';
      if (stack.length === 0 || stack[stack.length - 1] !== expected) return null;
      stack.pop();
    }
  }

  // If we ended inside a string, any truncation repair would be guesswork.
  if (inString) return null;

  let closings = '';
  for (let i = stack.length - 1; i >= 0; i--) {
    closings += stack[i] === '[' ? ']' : '}';
  }
  return closings;
}

function tryRepairTruncatedJsonArray(arraySlice: string): unknown[] | null {
  const slice = arraySlice.trimEnd();
  if (!slice.trimStart().startsWith('[')) return null;

  // Collect cut points outside of strings. We'll try trimming at these points and
  // auto-closing any unbalanced braces/brackets to form valid JSON.
  const cutPoints: number[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === ',' || ch === '}' || ch === ']') cutPoints.push(i);
  }

  const candidates = cutPoints.slice(-80).reverse();
  for (const idx of candidates) {
    const ch = slice[idx];
    let prefix = ch === ',' ? slice.slice(0, idx) : slice.slice(0, idx + 1);
    prefix = prefix.trimEnd();
    if (!prefix) continue;

    const closings = computeAutoClosings(prefix);
    if (!closings) continue;
    try {
      const parsed = JSON.parse(prefix + closings);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* keep trying */ }
  }

  // Last resort: try auto-closing without trimming (helps when only the final `]` is missing).
  const closings = computeAutoClosings(slice);
  if (!closings) return null;
  try {
    const parsed = JSON.parse(slice + closings);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
      } catch {
        // Try a best-effort repair even when a closing `]` exists, since models sometimes
        // emit trailing commas or get cut mid-token but still produce a stray `]`.
        const repaired = tryRepairTruncatedJsonArray(cleaned.slice(arrStart, arrEnd + 1));
        if (repaired) {
          const decisions = normaliseParsed(repaired);
          if (decisions.length > 0) return decisions;
        }
        /* fall through */
      }
    } else {
      // Repair common truncation mode: output cut mid-field (e.g., token limit), leaving the JSON array unclosed.
      const repaired = tryRepairTruncatedJsonArray(cleaned.slice(arrStart));
      if (repaired) {
        const decisions = normaliseParsed(repaired);
        if (decisions.length > 0) return decisions;
      }
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
  managerPersonaMd?: string | null;
  hasUserOpenRouterKey?: boolean;
}): string {
  const { agents: managedAgents, marketData, memory, managerConfig, managerPersonaMd } = ctx;
  const hasUserOpenRouterKey = !!ctx.hasUserOpenRouterKey;
  const availableModels = hasUserOpenRouterKey
    ? [...FREE_AGENT_MODELS, ...PAID_CHEAP_AGENT_MODELS]
    : FREE_AGENT_MODELS;

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

  const b = managerConfig.behavior;
  const behaviorSection = b
    ? `## Your Management Style
- Risk Tolerance: ${b.riskTolerance} | Management Style: ${b.managementStyle}
- Creation Aggressiveness: ${b.creationAggressiveness}/100 | Performance Patience: ${b.performancePatience}/100
- Diversification: ${b.diversificationPreference} | Rebalance Frequency: ${b.rebalanceFrequency}
- Philosophy: ${b.philosophyBias}` : '';

  const personaSection = managerPersonaMd ? `## Your Persona\n${managerPersonaMd}\n` : '';

  return `${personaSection}You are an Agent Manager overseeing a portfolio of paper trading agents on Base chain DEXes.

## Managed Agents (${managedAgents.length})
${agentSummaries || 'No agents yet.'}

## Current Market Conditions
${marketSummary}

## Memory & Hypotheses
${memorySummary}

## Risk Limits
${riskSummary}
${behaviorSection ? '\n' + behaviorSection : ''}
## Allowed Trading Pairs
When creating or modifying agents, you MUST choose pairs only from this allowlist:
${SUPPORTED_BASE_PAIRS.map((p: string) => `- "${p}"`).join('\n')}

## Allowed Agent Analysis Intervals
When creating or modifying agents, "analysisInterval" MUST be one of:
- "1h"
- "4h"
- "1d"
Do not use unsupported legacy values like "1m", "5m", "15m", "30m", or numeric seconds/minutes.

## Available LLM Models For Agents
Use only these llmModel IDs when creating or modifying agents:
${availableModels.map((m) => `- "${m}"`).join('\n')}

${hasUserOpenRouterKey
  ? 'The user has OpenRouter connected, so you may use free models and low-cost paid models (up to $3 per 1M tokens).'
  : 'The user has no connected OpenRouter key, so you must use free models only.'}
If unsure, default to "${DEFAULT_FREE_AGENT_MODEL}".

## Available Agent Profiles
When creating agents, pick a profileId that naturally fits your management style and risk tolerance — or combine several across your fleet for diversity. You can also write a fully custom personaMd instead.
${AGENT_PROFILES.map((p) => `- "${p.id}" ${p.emoji} ${p.name}: ${p.description}`).join('\n')}

## Instructions
Evaluate each agent's performance and decide what actions to take this cycle.

Valid actions:
- "create_agent": spawn a new agent. Params: name, pairs, llmModel, temperature, analysisInterval (1h|4h|1d), strategies, paperBalance; optional: profileId (from the list above — sets the agent's persona), personaMd (custom markdown persona, overrides profileId), stopLossPct, takeProfitPct, maxPositionSizePct, maxOpenPositions, maxDailyLossPct, cooldownAfterLossMinutes. Choose risk parameters that reflect your own risk tolerance.
- "start_agent": start a stopped or paused agent (provide agentId)
- "pause_agent": pause an underperforming agent (provide agentId)
- "modify_agent": change agent parameters (provide agentId + params). Params can include: name, pairs, llmModel, temperature, analysisInterval (1h|4h|1d), strategies, paperBalance, stopLossPct, takeProfitPct, maxPositionSizePct, maxOpenPositions, personaMd (markdown), profileId, etc.
- "terminate_agent": permanently stop an agent (provide agentId)
- "hold": no action needed (provide agentId, or omit for portfolio-level hold)

IMPORTANT: Respond with ONLY a valid JSON array — no markdown, no explanation.
Each element: { "action": "<action>", "agentId": "<id or omit>", "params": {<optional>}, "reasoning": "<why>" }
Output constraints:
- Keep each "reasoning" under 160 characters.
- Prefer "profileId" over "personaMd" to keep output short; only include "personaMd" if absolutely necessary, and keep it under 400 characters.
- Omit params that you want to keep at defaults.

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
  ownerAddress: string,
  hasUserOpenRouterKey = false
): Promise<{ success: boolean; detail?: string; error?: string }> {
  const { action, agentId, params } = decision;
  const allowedModels = buildAllowedAgentModels(hasUserOpenRouterKey);

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
      const previousAnalysisInterval = normalizeManagerAnalysisInterval(existingConfig.analysisInterval, '1h');
      const { personaMd: paramsPersona, ...restParams } = params as Record<string, unknown> & { personaMd?: string };
      const patch: Record<string, unknown> = { ...restParams };
      if (typeof patch.llmModel === 'string') {
        patch.llmModel = normaliseAgentModel(patch.llmModel, allowedModels);
      }
      if (patch.analysisInterval !== undefined) {
        patch.analysisInterval = normalizeManagerAnalysisInterval(patch.analysisInterval, previousAnalysisInterval);
      }
      if (patch.pairs != null && Array.isArray(patch.pairs)) {
        const normalized = normalizePairsForDex(patch.pairs as string[]);
        const supported = filterSupportedBasePairs(normalized);
        // Never allow the manager to set an empty/unsupported pair list.
        // If the LLM suggested unsupported pairs only, keep existing pairs unchanged.
        if (supported.length > 0) {
          patch.pairs = supported;
        } else {
          delete (patch as any).pairs;
        }
      }
      const mergedConfig = { ...existingConfig, ...patch };
      const nextAnalysisInterval = normalizeManagerAnalysisInterval(
        mergedConfig.analysisInterval,
        previousAnalysisInterval
      );
      mergedConfig.analysisInterval = nextAnalysisInterval;
      const analysisIntervalChanged = nextAnalysisInterval !== previousAnalysisInterval;
      const updates: Partial<typeof agents.$inferInsert> = {
        config: JSON.stringify(mergedConfig),
        llmModel: (mergedConfig.llmModel ?? agent.llmModel) || DEFAULT_FREE_AGENT_MODEL,
        updatedAt: nowIso(),
      };
      if (paramsPersona !== undefined) {
        updates.personaMd = typeof paramsPersona === 'string' ? paramsPersona : null;
      }
      await db.update(agents).set(updates).where(eq(agents.id, agentId));
      const [updatedAgent] = await db.select().from(agents).where(eq(agents.id, agentId));

      if (agent.status === 'running' && updatedAgent) {
        const doId = env.TRADING_AGENT.idFromName(agentId);
        const stub = env.TRADING_AGENT.get(doId);

        try {
          await stub.fetch(
            new Request('http://do/sync-config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                agentRow: {
                  id: updatedAgent.id,
                  name: updatedAgent.name,
                  status: updatedAgent.status,
                  config: updatedAgent.config,
                  ownerAddress: updatedAgent.ownerAddress ?? null,
                  llmModel: updatedAgent.llmModel ?? null,
                  profileId: updatedAgent.profileId ?? null,
                  personaMd: updatedAgent.personaMd ?? null,
                },
              }),
            }),
          );
        } catch (err) {
          console.warn(`[manager-loop] failed to sync config cache to TRADING_AGENT DO for ${agentId}:`, err);
        }

        if (analysisIntervalChanged) {
          try {
            await stub.fetch(
              new Request('http://do/set-interval', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ analysisInterval: nextAnalysisInterval }),
              }),
            );
          } catch (err) {
            console.warn(`[manager-loop] failed to sync interval to TRADING_AGENT DO for ${agentId}:`, err);
          }
        }
      }
      return { success: true, detail: `Agent ${agentId} modified` };
    }

    case 'create_agent': {
      if (!params) return { success: false, error: 'create_agent requires params' };
      const agentName = String(params.name ?? 'Manager-created Agent');
      const paperBalance = Number(params.paperBalance ?? 10000);
      const slippageSimulation = 0.3;
      const analysisInterval = normalizeManagerAnalysisInterval(params.analysisInterval, '1h');
      const llmModel = normaliseAgentModel(params.llmModel, allowedModels);
      // Use the LLM-chosen profileId if it's a valid agent profile, otherwise no profile.
      const validAgentProfileIds = new Set(AGENT_PROFILES.map((p) => p.id));
      const llmProfileId = typeof params.profileId === 'string' ? params.profileId : null;
      const profileId = llmProfileId && validAgentProfileIds.has(llmProfileId) ? llmProfileId : null;
      const personaMd =
        (typeof params.personaMd === 'string' && params.personaMd.trim())
          ? params.personaMd.trim()
          : profileId
          ? getAgentPersonaTemplate(profileId, agentName)
          : getDefaultAgentPersona(agentName);
      const normalizedPairs = normalizePairsForDex((params.pairs as string[] | undefined) ?? ['WETH/USDC']);
      const supportedPairs = filterSupportedBasePairs(normalizedPairs);
      const config = {
        name: agentName,
        llmModel,
        temperature: params.temperature ?? 0.7,
        pairs: supportedPairs.length > 0 ? supportedPairs : ['WETH/USDC'],
        analysisInterval,
        strategies: params.strategies ?? ['combined'],
        paperBalance,
        maxPositionSizePct: params.maxPositionSizePct ?? 5,
        maxOpenPositions: params.maxOpenPositions ?? 3,
        stopLossPct: params.stopLossPct ?? 5,
        takeProfitPct: params.takeProfitPct ?? 7,
        slippageSimulation,
        maxDailyLossPct: params.maxDailyLossPct ?? 10,
        cooldownAfterLossMinutes: params.cooldownAfterLossMinutes ?? 30,
        chain: 'base',
        dexes: ['aerodrome', 'uniswap-v3'],
        maxLlmCallsPerHour: 12,
        allowFallback: false,
        llmFallback: DEFAULT_FREE_AGENT_MODEL,
      };
      const id = generateId('agent');
      const now = nowIso();
      await db.insert(agents).values({
        id,
        name: agentName,
        status: 'running',
    autonomyLevel: 2,
        config: JSON.stringify(config),
        llmModel,
        ownerAddress,
        managerId,
        personaMd,
        profileId,
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
  // Enable FK enforcement (session-level in SQLite, must be set per connection)
  try { await db.run(sql`PRAGMA foreign_keys = ON`); } catch { /* non-fatal */ }

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
  const runtimeDecisionInterval = normalizeManagerDecisionInterval(
    (config as { decisionInterval?: string }).decisionInterval,
  );
  // Keep DO scheduling state aligned with DB config on every cycle.
  try {
    await ctx.storage.put('decisionInterval', runtimeDecisionInterval);
  } catch (err) {
    console.warn(`[manager-loop] ${managerId}: failed to sync decisionInterval into DO storage:`, err);
  }

  // 2. Load all managed agents
  const managedRows = await db.select().from(agents).where(eq(agents.managerId, managerId));

  // 3. Build agent snapshots — batch queries instead of N+1
  const agentSnapshots: ManagedAgentSnapshot[] = [];

  if (managedRows.length > 0) {
    const agentIds = managedRows.map((r) => r.id);

    // Batch: fetch all snapshots for managed agents, sorted newest-first
    const allSnapshots = await db
      .select()
      .from(performanceSnapshots)
      .where(inArray(performanceSnapshots.agentId, agentIds))
      .orderBy(desc(performanceSnapshots.snapshotAt));

    // Keep only the most recent snapshot per agent
    const latestSnapshotByAgent = new Map<string, typeof allSnapshots[number]>();
    for (const snap of allSnapshots) {
      if (!latestSnapshotByAgent.has(snap.agentId)) {
        latestSnapshotByAgent.set(snap.agentId, snap);
      }
    }

    // Batch: fetch recent trades for all managed agents, sorted newest-first
    const allRecentTrades = await db
      .select({ agentId: trades.agentId, pair: trades.pair, side: trades.side, pnlPct: trades.pnlPct, openedAt: trades.openedAt, closedAt: trades.closedAt })
      .from(trades)
      .where(inArray(trades.agentId, agentIds))
      .orderBy(desc(trades.openedAt));

    // Group by agentId, keep top 10 per agent
    const tradesByAgent = new Map<string, typeof allRecentTrades>();
    for (const trade of allRecentTrades) {
      const existing = tradesByAgent.get(trade.agentId) ?? [];
      if (existing.length < 10) existing.push(trade);
      tradesByAgent.set(trade.agentId, existing);
    }

    for (const row of managedRows) {
      const agentConfig = JSON.parse(row.config) as ManagedAgentSnapshot['config'];
      const perfRow = latestSnapshotByAgent.get(row.id);
      const recentTrades = tradesByAgent.get(row.id) ?? [];

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
  const ownerAddr = managerRow.ownerAddress?.toLowerCase();
  const [ownerUser] = ownerAddr
    ? await db
      .select({ openRouterKey: users.openRouterKey })
      .from(users)
      .where(eq(users.walletAddress, ownerAddr))
    : [];
  const hasUserOpenRouterKey = !!ownerUser?.openRouterKey;

  const prompt = buildManagerPrompt({
    agents: agentSnapshots,
    marketData,
    memory,
    managerConfig: config,
    managerPersonaMd: managerRow.personaMd,
    hasUserOpenRouterKey,
  });

  console.log('[manager-loop] === FULL PROMPT SENT TO MANAGER LLM ===');
  console.log('[manager-loop] Manager ID:', managerId);
  console.log('[manager-loop] Model:', config.llmModel);
  console.log('[manager-loop] Prompt length (chars):', prompt.length);
  console.log('[manager-loop] personaMd from DB:', managerRow.personaMd ?? '(none)');
  console.log('[manager-loop] --- PROMPT ---');
  console.log(prompt);
  console.log('[manager-loop] === END PROMPT ===');

  let rawResponse = '';
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  if (!env.OPENROUTER_API_KEY) {
    console.warn(`[manager-loop] ${managerId}: OPENROUTER_API_KEY not set — holding`);
    rawResponse = JSON.stringify([{ action: 'hold', reasoning: 'No API key configured' }]);
  } else {
    try {
      let orApiKey = env.OPENROUTER_API_KEY;
      if (ownerAddr) {
        if (ownerUser?.openRouterKey) {
          try {
            orApiKey = await decryptKey(ownerUser.openRouterKey, env.KEY_ENCRYPTION_SECRET);
          } catch {
            console.warn('[manager-loop] failed to decrypt user OR key, using server fallback');
          }
        }
      }
      const openrouter = createOpenRouter({ apiKey: orApiKey });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Manager LLM timed out after ${MANAGER_LLM_TIMEOUT_MS / 1000}s`)),
          MANAGER_LLM_TIMEOUT_MS
        )
      );
      const result = await Promise.race([
        generateText({
          model: openrouter(config.llmModel),
          messages: [{ role: 'user', content: prompt }],
          temperature: config.temperature,
          maxOutputTokens: 2048,
        }),
        timeoutPromise,
      ]);
      rawResponse = result.text;
      usage = (result as any).usage ?? {};
      console.log('[manager-loop] === RAW LLM RESPONSE ===');
      console.log(rawResponse);
      console.log('[manager-loop] === END RESPONSE ===');
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
    const actionResult = await executeManagerAction(
      decision,
      db,
      env,
      managerId,
      managerRow.ownerAddress,
      hasUserOpenRouterKey
    );
    const result = {
      ...actionResult,
      llmPromptText: prompt,
      llmRawResponse: rawResponse,
    };
    await db.insert(agentManagerLogs).values({
      id: generateId('mlog'),
      managerId,
      action: decision.action,
      reasoning: decision.reasoning,
      result: JSON.stringify(result),
      llmPromptTokens: usage.inputTokens ?? null,
      llmCompletionTokens: usage.outputTokens ?? null,
      createdAt: nowIso(),
    });
    console.log(`[manager-loop] ${managerId}: ${decision.action} → ${JSON.stringify(result)}`);
  }

  // 10. Update memory timestamp
  const updatedMemory: ManagerMemory = { ...memory, last_evaluation_at: nowIso() };
  await ctx.storage.put('memory', updatedMemory);

  console.log(`[manager-loop] ${managerId}: Cycle complete. ${decisions.length} decisions.`);
}
