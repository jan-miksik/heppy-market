import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { agents, agentDecisions } from '../../db/schema.js';
import { submitPerpExecutionPlan } from '../../services/initia-executor.js';
import type { PerpTradeDecisionRequest } from '../../services/llm-router.js';
import { getPerpTradeDecision } from '../../services/llm-router.js';
import { generateId, nowIso } from '../../lib/utils.js';
import { resolveAgentPersonaMd } from '../resolve-agent-persona.js';
import type { CachedAgentRow } from '../trading-agent.js';
import { planPerpExecution } from '../execution-planner.js';
import type { PerpPositionState } from '../perp-state-machine.js';
import type { Env } from '../../types/env.js';
import { normalizePairForDex } from '../../lib/pairs.js';
import type { MarketDataItem, RecentDecision } from './types.js';
import { persistTrade } from './execution.js';

const SNAPSHOT_MAX_BYTES = 8192;
function snapshotMarketData(data: unknown): string {
  const full = JSON.stringify(data);
  return full.length > SNAPSHOT_MAX_BYTES ? full.slice(0, SNAPSHOT_MAX_BYTES) : full;
}
import { createLogger } from '../../lib/logger.js';
import { AgentConfigSchema } from '@something-in-loop/shared';
import { logStructuredError } from '../../lib/agent-errors.js';
import { PaperEngine } from '../../services/paper-engine.js';

export type RunInitiaPerpPathParams = {
  agentId: string;
  engine: PaperEngine;
  env: Env;
  db: ReturnType<typeof drizzle>;
  ctx: DurableObjectState;
  log: ReturnType<typeof createLogger>;
  tickStart: number;
  agentRow: Pick<CachedAgentRow, 'name' | 'profileId' | 'personaMd'>;
  config: ReturnType<typeof AgentConfigSchema.parse>;
  pairsToFetch: string[];
  marketData: MarketDataItem[];
  recentDecisions: RecentDecision[];
  effectiveLlmModel: string;
  effectiveLlmFallback: string;
  allowFallback: boolean;
  llmProvider: 'openrouter' | 'anthropic';
  llmApiKey: string;
};

export async function runInitiaPerpPath(params: RunInitiaPerpPathParams): Promise<void> {
  const {
    agentId,
    engine,
    env,
    db,
    ctx,
    log,
    tickStart,
    agentRow,
    config,
    pairsToFetch,
    marketData,
    recentDecisions,
    effectiveLlmModel,
    effectiveLlmFallback,
    allowFallback,
    llmProvider,
    llmApiKey,
  } = params;

  let initiaSyncState: Record<string, unknown> | null = null;
  try {
    const [initiaRow] = await db
      .select({ initiaSyncState: agents.initiaSyncState })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (initiaRow?.initiaSyncState) {
      const parsed = JSON.parse(initiaRow.initiaSyncState) as Record<string, unknown>;
      if (typeof parsed === 'object' && parsed !== null) initiaSyncState = parsed;
    }
  } catch {
    // non-fatal
  }

  const targetPair = normalizePairForDex(pairsToFetch[0]);
  const openBuyPos = engine.openPositions.find((p) => p.pair === targetPair && p.side === 'buy');
  const openSellPos = engine.openPositions.find((p) => p.pair === targetPair && p.side === 'sell');
  const currentPositionState: PerpPositionState = openBuyPos ? 'LONG' : openSellPos ? 'SHORT' : 'FLAT';

  const perpRequest: PerpTradeDecisionRequest = {
    portfolioState: {
      balance: engine.balance,
      openPositions: engine.openPositions.length,
      dailyPnlPct: engine.getDailyPnlPct(),
      totalPnlPct: engine.getTotalPnlPct(),
    },
    currentPositionState,
    marketData,
    lastDecisions: recentDecisions,
    config: {
      pairs: pairsToFetch,
      maxPositionSizePct: config.maxPositionSizePct,
    },
    behavior: config.behavior,
    personaMd: resolveAgentPersonaMd({
      agentName: agentRow.name,
      agentPersonaMd: agentRow.personaMd ?? null,
      agentProfileId: agentRow.profileId ?? null,
      config: config as unknown as Record<string, unknown>,
    }),
    behaviorMd: config.behaviorMd ?? null,
    roleMd: config.roleMd ?? null,
  };

  let perpDecision: Awaited<ReturnType<typeof getPerpTradeDecision>>;
  const doneLlmPerp = log.time('llm_call_perp', { model: effectiveLlmModel });
  try {
    perpDecision = await getPerpTradeDecision(
      {
        apiKey: llmApiKey,
        model: effectiveLlmModel,
        fallbackModel: effectiveLlmFallback,
        allowFallback,
        temperature: config.temperature,
        timeoutMs: 90_000,
        provider: llmProvider,
        debugLogging: env.LOG_LLM_DEBUG === 'true',
      },
      perpRequest,
    );
  } catch (err) {
    doneLlmPerp();
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
      marketDataSnapshot: snapshotMarketData(marketData),
      createdAt: nowIso(),
    });
    return;
  }
  doneLlmPerp();

  log.info('perp_decision', {
    action: perpDecision.action,
    confidence: perpDecision.confidence,
    model: perpDecision.modelUsed,
    llm_latency_ms: perpDecision.latencyMs,
  });

  const pairData = marketData.find((m) => m.pair === targetPair);

  const collateralTokenAddress = config.allowedTradeTokens?.[0] as `0x${string}` | undefined;
  const vaultBalances: Record<string, bigint> = {};
  if (collateralTokenAddress) {
    const raw = initiaSyncState?.showcaseTokenBalanceWei ?? initiaSyncState?.vaultBalanceWei;
    vaultBalances[collateralTokenAddress] = typeof raw === 'string' && raw.length > 0 ? BigInt(raw) : 0n;
  }

  let paperErrorStr = '';
  let executedPaperTrade = false;
  let paperCloseReason: string | undefined;

  if (pairData && pairData.priceUsd > 0 && perpDecision.action !== 'HOLD') {
    try {
      if (perpDecision.action === 'OPEN_LONG' || perpDecision.action === 'OPEN_SHORT') {
        const amountUsd = (engine.balance * perpDecision.sizePct) / 100;
        const side = perpDecision.action === 'OPEN_LONG' ? 'buy' : 'sell';
        const position = engine.openPosition({
          agentId,
          pair: targetPair,
          dex: config.dexPlatformId ?? 'mock-perp-v1',
          side,
          price: pairData.priceUsd,
          amountUsd,
          maxPositionSizePct: config.maxPositionSizePct,
          balance: engine.balance,
          confidence: perpDecision.confidence,
          reasoning: perpDecision.rationale,
          strategyUsed: 'perp-only',
        });
        await ctx.storage.put('pendingTrade', position);
        await persistTrade(db, position);
        await ctx.storage.delete('pendingTrade');
        executedPaperTrade = true;
      } else if (perpDecision.action === 'CLOSE_LONG' || perpDecision.action === 'CLOSE_SHORT') {
        const side = perpDecision.action === 'CLOSE_LONG' ? 'buy' : 'sell';
        const openPos = engine.openPositions.find((p) => p.pair === targetPair && p.side === side);
        if (openPos) {
          const closed = engine.closePosition(openPos.id, {
            price: pairData.priceUsd,
            confidence: perpDecision.confidence,
            closeReason: 'llm_decision',
          });
          await ctx.storage.put('pendingTrade', closed);
          await persistTrade(db, closed);
          await ctx.storage.delete('pendingTrade');
          executedPaperTrade = true;
        } else {
          paperCloseReason = 'no matching open position found in paper engine';
        }
      }
    } catch (paperErr) {
      log.warn('perp_paper_trade_failed', { error: String(paperErr) });
      paperErrorStr = String(paperErr);
    }
  }

  const canPlan = collateralTokenAddress && pairData && pairData.priceUsd > 0;
  const plan = canPlan
    ? planPerpExecution({
        decision: perpDecision,
        currentState: currentPositionState,
        vaultBalances,
        marketPriceUsd: pairData.priceUsd,
        agentConfig: config,
        perpDexAddressOverride: env.MOCK_PERP_DEX_ADDRESS as `0x${string}` | undefined,
      })
    : ({ skip: 'no_balance' } as const);

  const isHold = perpDecision.action === 'HOLD';
  let executionNote = '';
  if (isHold) {
    executionNote = 'Execution: HOLD';
  } else if ('skip' in plan) {
    executionNote = `Execution: skipped (${plan.skip})`;
    if (paperErrorStr) executionNote += ` | Paper error: ${paperErrorStr}`;
    else if (paperCloseReason) executionNote += ` | Paper skip: ${paperCloseReason}`;
    else if (executedPaperTrade && plan.skip !== 'no_balance') executionNote += ` | Paper trade: OK`;
  } else {
    executionNote = `Execution: ${perpDecision.action} ${targetPair} via ${plan.perpDexPlatformId}`;
  }

  await db.insert(agentDecisions).values({
    id: generateId('dec'),
    agentId,
    decision: perpDecision.action.toLowerCase(),
    confidence: perpDecision.confidence,
    reasoning: `${perpDecision.rationale}\n\n—\n${executionNote}`,
    llmModel: perpDecision.modelUsed,
    llmLatencyMs: perpDecision.latencyMs,
    llmTokensUsed: perpDecision.tokensUsed,
    llmPromptTokens: perpDecision.tokensIn ?? null,
    llmCompletionTokens: perpDecision.tokensOut ?? null,
    marketDataSnapshot: JSON.stringify(marketData),
    llmPromptText: perpDecision.llmPromptText ?? null,
    llmRawResponse: perpDecision.llmRawResponse ?? null,
    createdAt: nowIso(),
  });

  try {
    await ctx.storage.put(
      'recentDecisions',
      [{ decision: perpDecision.action.toLowerCase(), confidence: perpDecision.confidence, createdAt: nowIso() }, ...recentDecisions].slice(0, 10),
    );
  } catch {
    // non-fatal
  }

  if (!('skip' in plan)) {
    const onchainResult = await submitPerpExecutionPlan({
      plan,
      env,
      log,
      agentId,
      syncState: initiaSyncState,
    });
    if (!onchainResult.executed) {
      log.info('perp_onchain_skipped', { reason: onchainResult.reason ?? 'unknown' });
    } else {
      log.info('perp_onchain_submitted', { tx_hash: onchainResult.txHash });
    }
  } else {
    log.info('perp_plan_skip', { action: perpDecision.action, reason: plan.skip });
  }

  log.info('tick_end', {
    duration_ms: Date.now() - tickStart,
    pairs_fetched: marketData.length,
    open_positions: engine.openPositions.length,
    balance: engine.balance,
  });
}
