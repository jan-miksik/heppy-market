import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { agentDecisions, agents, trades } from '../../db/schema.js';
import { generateId, nowIso } from '../../lib/utils.js';
import { normalizePairForDex } from '../../lib/pairs.js';
import { createLogger } from '../../lib/logger.js';
import { getTradeDecision } from '../../services/llm-router.js';
import { tryExecuteInitiaTick } from '../../services/initia-executor.js';
import { PaperEngine, type Position } from '../../services/paper-engine.js';
import { resolveCurrentPriceUsd } from '../../services/price-resolver.js';
import type { Env } from '../../types/env.js';
import type { MarketDataItem, RecentDecision } from './types.js';

export type ExecuteDecisionParams = {
  agentId: string;
  engine: PaperEngine;
  marketData: MarketDataItem[];
  pairsToFetch: string[];
  recentDecisions: RecentDecision[];
  effectiveLlmModel: string;
  minConfidence: number;
  maxOpenPositions: number;
  maxPositionSizePct: number;
  dexes: string[];
  strategies: string[];
  slippageSimulation: number;
  /** Agent chain — passed from cached agent row to avoid an extra D1 query. */
  chain?: string | null;
  /** Whether agent is in paper mode — passed from cached agent row to avoid an extra D1 query. */
  isPaper?: boolean | null;
  env: Env;
  db: ReturnType<typeof drizzle>;
  ctx: DurableObjectState;
  tickStart?: number;
  log: ReturnType<typeof createLogger>;
};

const SNAPSHOT_MAX_BYTES = 8192;
function snapshotMarketData(data: unknown): string {
  const full = JSON.stringify(data);
  return full.length > SNAPSHOT_MAX_BYTES ? full.slice(0, SNAPSHOT_MAX_BYTES) : full;
}

function parseInitiaSyncState(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Execute a trade decision returned by the LLM.
 * Called from both the synchronous agent-loop path and the async /receive-decision endpoint.
 */
export async function executeTradeDecision(
  decision: Awaited<ReturnType<typeof getTradeDecision>>,
  params: ExecuteDecisionParams,
): Promise<void> {
  const {
    agentId,
    engine,
    marketData,
    pairsToFetch,
    recentDecisions,
    minConfidence,
    maxOpenPositions,
    maxPositionSizePct,
    dexes,
    strategies,
    slippageSimulation,
    chain,
    isPaper,
    env,
    db,
    ctx,
    tickStart,
    log,
  } = params;

  const wantsTrade = decision.action === 'buy' || decision.action === 'sell';
  const hasCapacity = engine.openPositions.length < maxOpenPositions;
  const meetsConfidence = decision.confidence >= minConfidence;

  let executionNote: string | null = null;
  if (wantsTrade && !meetsConfidence) {
    executionNote = `Execution: skipped (confidence ${(decision.confidence * 100).toFixed(0)}% < threshold ${(minConfidence * 100).toFixed(0)}%).`;
  } else if (wantsTrade && !hasCapacity) {
    executionNote = `Execution: skipped (already at max open positions: ${engine.openPositions.length}/${maxOpenPositions}).`;
  }

  // Only fetch initiaSyncState from D1 when running an Initia onchain agent.
  // chain/isPaper come from the cached agent row passed by the caller.
  const shouldAttemptOnchain = chain === 'initia' && !isPaper;
  let initiaSyncState: Record<string, unknown> | null = null;
  if (shouldAttemptOnchain) {
    const [agentRow] = await db
      .select({ initiaSyncState: agents.initiaSyncState })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    initiaSyncState = parseInitiaSyncState(agentRow?.initiaSyncState ?? null);
  }
  let executedPaperTrade = false;

  const decisionId = generateId('dec');
  await db.insert(agentDecisions).values({
    id: decisionId,
    agentId,
    decision: decision.action,
    confidence: decision.confidence,
    reasoning: executionNote ? `${decision.reasoning}\n\n—\n${executionNote}` : decision.reasoning,
    llmModel: decision.modelUsed,
    llmLatencyMs: decision.latencyMs,
    llmTokensUsed: decision.tokensUsed,
    llmPromptTokens: decision.tokensIn ?? null,
    llmCompletionTokens: decision.tokensOut ?? null,
    marketDataSnapshot: snapshotMarketData(marketData),
    llmPromptText: decision.llmPromptText ?? null,
    llmRawResponse: decision.llmRawResponse ?? null,
    createdAt: nowIso(),
  });

  const decisionCreatedAt = nowIso();
  try {
    const newCachedDecision: RecentDecision = {
      decision: decision.action,
      confidence: decision.confidence,
      createdAt: decisionCreatedAt,
    };
    const updatedDecisions = [newCachedDecision, ...recentDecisions].slice(0, 10);
    await ctx.storage.put('recentDecisions', updatedDecisions);
  } catch {
    // non-fatal
  }

  broadcastAgentEvent(ctx, {
    type: 'decision',
    agentId,
    decision: decision.action,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    balance: engine.balance,
    openPositions: engine.openPositions.length,
    createdAt: decisionCreatedAt,
  });

  log.info('decision', {
    action: decision.action,
    confidence: decision.confidence,
    model: decision.modelUsed,
    llm_latency_ms: decision.latencyMs,
    tokens_in: decision.tokensIn,
    tokens_out: decision.tokensOut,
    execution_note: executionNote ?? undefined,
  });
  console.log(`[agent-loop] ${agentId}: Decision=${decision.action} confidence=${decision.confidence.toFixed(2)}`);

  if ((decision.action === 'buy' || decision.action === 'sell') && meetsConfidence && hasCapacity) {
    const targetPairName = normalizePairForDex(decision.targetPair ?? pairsToFetch[0]);
    const pairData = marketData.find((m) => m.pair === targetPairName);
    if (!pairData || pairData.priceUsd === 0) {
      console.warn(`[agent-loop] ${agentId}: No price data for ${targetPairName}`);
      return;
    }

    // The marketData snapshot may be up to 1h old (KV cache) or up to 5 min
    // frozen inside pendingLlmContext on the queued /receive-decision path.
    // Re-resolve at open-time so entryPrice reflects the true current price.
    let entryPriceUsd = 0;
    try {
      entryPriceUsd = await resolveCurrentPriceUsd(env, targetPairName, { bypassCache: true });
    } catch (err) {
      console.warn(`[agent-loop] ${agentId}: Fresh price resolve threw for ${targetPairName}:`, err);
    }
    if (entryPriceUsd <= 0) {
      console.warn(
        `[agent-loop] ${agentId}: Fresh price unavailable for ${targetPairName}; skipping open to avoid stale entry.`,
      );
      log.info('trade_open_skipped', { pair: targetPairName, reason: 'fresh_price_unavailable' });
      return;
    }

    const positionSizePct = Math.min(decision.suggestedPositionSizePct ?? 10, maxPositionSizePct);
    const amountUsd = (engine.balance * positionSizePct) / 100;

    try {
      const position = engine.openPosition({
        agentId,
        pair: targetPairName,
        dex: dexes[0] ?? 'aerodrome',
        side: decision.action as 'buy' | 'sell',
        price: entryPriceUsd,
        amountUsd,
        maxPositionSizePct,
        balance: engine.balance,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        strategyUsed: strategies[0] ?? 'combined',
        slippagePct: slippageSimulation,
      });
      await ctx.storage.put('pendingTrade', position);
      await persistTrade(db, position);
      await ctx.storage.delete('pendingTrade');
      log.info('trade_open', {
        pair: targetPairName,
        side: decision.action,
        amount_usd: amountUsd,
        price_usd: entryPriceUsd,
        quoted_price_usd: pairData.priceUsd,
        position_size_pct: positionSizePct,
        confidence: decision.confidence,
      });
      executedPaperTrade = true;
      broadcastAgentEvent(ctx, {
        type: 'trade',
        event: 'open',
        agentId,
        pair: targetPairName,
        side: decision.action,
        amountUsd,
        priceUsd: entryPriceUsd,
        balance: engine.balance,
        openPositions: engine.openPositions.length,
      });
      console.log(`[agent-loop] ${agentId}: Opened ${decision.action} ${targetPairName} $${amountUsd.toFixed(2)} @ $${entryPriceUsd}`);
    } catch (err) {
      console.error(`[agent-loop] ${agentId}: Failed to open position:`, err);
      log.error('trade_open_failed', { pair: targetPairName, side: decision.action, error: String(err) });
    }
  } else if (decision.action === 'close' && engine.openPositions.length > 0) {
    let closedAnyPosition = false;
    for (const position of engine.openPositions) {
      const pairData = marketData.find((m) => m.pair === position.pair);
      if (!pairData) continue;
      try {
        const closed = engine.closePosition(position.id, {
          price: pairData.priceUsd,
          confidence: decision.confidence,
          closeReason: 'llm_decision',
        });
        await ctx.storage.put('pendingTrade', closed);
        await persistTrade(db, closed);
        await ctx.storage.delete('pendingTrade');
        await ctx.storage.delete(`priceMiss:${position.id}`);
        log.info('trade_close', {
          pair: position.pair,
          side: position.side,
          pnl_pct: closed.pnlPct,
          pnl_usd: closed.pnlUsd,
          price_usd: pairData.priceUsd,
          reason: 'llm_close',
        });
        broadcastAgentEvent(ctx, {
          type: 'trade',
          event: 'close',
          agentId,
          pair: position.pair,
          side: position.side,
          pnlPct: closed.pnlPct,
          pnlUsd: closed.pnlUsd,
          priceUsd: pairData.priceUsd,
          balance: engine.balance,
          openPositions: engine.openPositions.length,
        });
        console.log(`[agent-loop] ${agentId}: Closed ${position.pair} PnL=${closed.pnlPct?.toFixed(2)}%`);
        closedAnyPosition = true;
      } catch (err) {
        console.warn(`[agent-loop] ${agentId}: Failed to close position:`, err);
      }
    }
    if (closedAnyPosition) executedPaperTrade = true;
  }

  if (shouldAttemptOnchain && wantsTrade && meetsConfidence && executedPaperTrade) {
    const onchainResult = await tryExecuteInitiaTick({
      env,
      log,
      agentId,
      syncState: initiaSyncState,
    });
    if (!onchainResult.executed) {
      log.info('initia_tick_skipped', { reason: onchainResult.reason ?? 'unknown' });
    }
  }

  if (tickStart !== undefined) {
    log.info('tick_end', {
      duration_ms: Date.now() - tickStart,
      pairs_fetched: marketData.length,
      open_positions: engine.openPositions.length,
      balance: engine.balance,
    });
  }
}

/** Upsert a trade record to D1 */
export async function persistTrade(db: ReturnType<typeof drizzle>, position: Position): Promise<void> {
  await db
    .insert(trades)
    .values({
      id: position.id,
      agentId: position.agentId,
      pair: position.pair,
      dex: position.dex,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: position.exitPrice ?? null,
      amountUsd: position.amountUsd,
      pnlPct: position.pnlPct ?? null,
      pnlUsd: position.pnlUsd ?? null,
      confidenceBefore: position.confidenceBefore,
      confidenceAfter: position.confidenceAfter ?? null,
      reasoning: position.reasoning,
      strategyUsed: position.strategyUsed,
      slippageSimulated: position.slippageSimulated,
      status: position.status,
      closeReason: position.closeReason ?? null,
      openedAt: position.openedAt,
      closedAt: position.closedAt ?? null,
    })
    .onConflictDoUpdate({
      target: trades.id,
      set: {
        exitPrice: position.exitPrice ?? null,
        pnlPct: position.pnlPct ?? null,
        pnlUsd: position.pnlUsd ?? null,
        confidenceAfter: position.confidenceAfter ?? null,
        status: position.status,
        closeReason: position.closeReason ?? null,
        closedAt: position.closedAt ?? null,
      },
    });
}

/** Broadcast a JSON event to all WebSocket clients connected to this DO. */
function broadcastAgentEvent(ctx: DurableObjectState, event: Record<string, unknown>): void {
  const json = JSON.stringify(event);
  for (const ws of ctx.getWebSockets()) {
    try {
      ws.send(json);
    } catch {
      // client gone, runtime will clean up
    }
  }
}
