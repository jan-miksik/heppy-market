import { drizzle } from 'drizzle-orm/d1';
import { AgentBehaviorConfigSchema, AgentConfigSchema } from '@something-in-loop/shared';
import { agentDecisions } from '../../db/schema.js';
import type { Env } from '../../types/env.js';
import { generateId, nowIso } from '../../lib/utils.js';
import { checkLlmRateLimit } from '../../lib/global-rate-limiter.js';
import { resolveAgentPersonaMd } from '../resolve-agent-persona.js';
import { getTradeDecision } from '../../services/llm-router.js';
import { logStructuredError } from '../../lib/agent-errors.js';
import { createLogger } from '../../lib/logger.js';
import { PaperEngine } from '../../services/paper-engine.js';
import type { MarketDataItem, RecentDecision } from './types.js';
import type { CachedAgentRow } from '../trading-agent.js';
import type { TradeDecisionRequest } from '../../services/llm-router.js';

type BuildTradeRequestParams = {
  engine: PaperEngine;
  pairsToFetch: string[];
  marketData: MarketDataItem[];
  recentDecisions: RecentDecision[];
  config: ReturnType<typeof AgentConfigSchema.parse>;
  agentRow: Pick<CachedAgentRow, 'name' | 'personaMd' | 'profileId'>;
};

export function buildBaseTradeRequest(params: BuildTradeRequestParams): {
  tradeRequest: TradeDecisionRequest;
  minConfidence: number;
} {
  const { engine, pairsToFetch, marketData, recentDecisions, config, agentRow } = params;

  const openPositionsSummary = engine.openPositions.map((pos) => {
    const currentPriceData = marketData.find((m) => m.pair === pos.pair);
    const currentPrice = currentPriceData?.priceUsd ?? pos.entryPrice;
    const unrealizedPct =
      pos.side === 'buy'
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
    return {
      pair: pos.pair,
      side: pos.side,
      entryPrice: pos.entryPrice,
      amountUsd: pos.amountUsd,
      unrealizedPct,
      currentPrice,
      openedAt: pos.openedAt,
      slPct: config.stopLossPct,
      tpPct: config.takeProfitPct,
    };
  });

  const effectiveBehavior = AgentBehaviorConfigSchema.parse(config.behavior ?? {});
  const minConfidence = effectiveBehavior.confidenceThreshold / 100;

  return {
    tradeRequest: {
      portfolioState: {
        balance: engine.balance,
        openPositions: engine.openPositions.length,
        dailyPnlPct: engine.getDailyPnlPct(),
        totalPnlPct: engine.getTotalPnlPct(),
      },
      openPositions: openPositionsSummary,
      marketData,
      lastDecisions: recentDecisions,
      config: {
        pairs: pairsToFetch,
        maxPositionSizePct: config.maxPositionSizePct,
        maxOpenPositions: config.maxOpenPositions,
        stopLossPct: config.stopLossPct,
        takeProfitPct: config.takeProfitPct,
      },
      behavior: config.behavior,
      personaMd: resolveAgentPersonaMd({
        agentName: agentRow.name,
        agentPersonaMd: agentRow.personaMd,
        agentProfileId: agentRow.profileId,
        config: config as unknown as Record<string, unknown>,
      }),
      behaviorMd: config.behaviorMd ?? null,
      roleMd: config.roleMd ?? null,
    },
    minConfidence,
  };
}

type CheckBaseRateLimitParams = {
  env: Env;
  db: ReturnType<typeof drizzle>;
  log: ReturnType<typeof createLogger>;
  agentId: string;
  ownerAddress: string | null;
  effectiveLlmModel: string;
  marketData: MarketDataItem[];
};

/**
 * Returns true when analysis can continue; false if rate-limited and handled.
 */
export async function checkBaseRateLimitOrHold(params: CheckBaseRateLimitParams): Promise<boolean> {
  const { env, db, log, agentId, ownerAddress, effectiveLlmModel, marketData } = params;
  const rateLimitKey = ownerAddress?.toLowerCase();
  if (!rateLimitKey || !env.RATE_LIMITER) return true;

  const rl = await checkLlmRateLimit(env, rateLimitKey);
  if (rl.allowed) return true;

  log.warn('llm_rate_limited', {
    limitedBy: rl.limitedBy,
    minuteRemaining: rl.minuteRemaining,
    hourRemaining: rl.hourRemaining,
  });
  await db.insert(agentDecisions).values({
    id: generateId('dec'),
    agentId,
    decision: 'hold',
    confidence: 0,
    reasoning: `LLM rate limit reached (${rl.limitedBy} limit). Resets in ${rl.limitedBy === 'minute' ? Math.ceil(rl.minuteResetAt - Date.now() / 1000) : Math.ceil(rl.hourResetAt - Date.now() / 1000)}s.`,
    llmModel: effectiveLlmModel,
    llmLatencyMs: 0,
    marketDataSnapshot: JSON.stringify(marketData),
    createdAt: nowIso(),
  });
  return false;
}

type RunBaseSyncDecisionParams = {
  env: Env;
  db: ReturnType<typeof drizzle>;
  log: ReturnType<typeof createLogger>;
  agentId: string;
  effectiveLlmModel: string;
  effectiveLlmFallback: string;
  allowFallback: boolean;
  llmProvider: 'openrouter' | 'anthropic';
  llmApiKey: string;
  tradeRequest: TradeDecisionRequest;
  marketData: MarketDataItem[];
  temperature: number;
};

export async function runBaseSyncDecision(
  params: RunBaseSyncDecisionParams,
): Promise<Awaited<ReturnType<typeof getTradeDecision>> | null> {
  const {
    env,
    db,
    log,
    agentId,
    effectiveLlmModel,
    effectiveLlmFallback,
    allowFallback,
    llmProvider,
    llmApiKey,
    tradeRequest,
    marketData,
    temperature,
  } = params;

  const doneLlm = log.time('llm_call', { model: effectiveLlmModel });
  try {
    const decision = await getTradeDecision(
      {
        apiKey: llmApiKey,
        model: effectiveLlmModel,
        fallbackModel: effectiveLlmFallback,
        allowFallback,
        temperature,
        timeoutMs: 90_000,
        provider: llmProvider,
        debugLogging: env.LOG_LLM_DEBUG === 'true',
      },
      tradeRequest,
    );
    doneLlm();
    return decision;
  } catch (err) {
    doneLlm();
    const { classifyLlmError } = await import('../../lib/agent-errors.js');
    const classified = classifyLlmError(err, { model: effectiveLlmModel });
    logStructuredError('agent-loop', agentId, classified);
    await db.insert(agentDecisions).values({
      id: generateId('dec'),
      agentId,
      decision: 'hold',
      confidence: 0,
      reasoning: `LLM error [${classified.code}]: ${classified.message}`,
      llmModel: effectiveLlmModel,
      llmLatencyMs: 0,
      marketDataSnapshot: JSON.stringify(marketData),
      createdAt: nowIso(),
    });
    return null;
  }
}
