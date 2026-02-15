/**
 * Agent analysis loop.
 * Called by TradingAgentDO.alarm() on each scheduled tick.
 * Flow: fetch market data → compute indicators → LLM analysis → validate →
 *       execute paper trade → log decision → check risk limits → reschedule
 */
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import { agents, trades, agentDecisions } from '../db/schema.js';
import { createDexDataService, getPriceUsd, type DexPair } from '../services/dex-data.js';
import { computeIndicators, evaluateSignals, combineSignals } from '../services/indicators.js';
import { PaperEngine, type Position } from '../services/paper-engine.js';
import { getTradeDecision } from '../services/llm-router.js';
import { generateId, nowIso, intToAutonomyLevel } from '../lib/utils.js';

/** Interval string → milliseconds */
function intervalToMs(interval: string): number {
  switch (interval) {
    case '1m':  return 60_000;
    case '5m':  return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h':  return 60 * 60_000;
    case '4h':  return 4 * 60 * 60_000;
    case '1d':  return 24 * 60 * 60_000;
    default:    return 60 * 60_000; // default 1h
  }
}

/** Approximate price series from DexScreener priceChange data */
function approximatePriceSeries(pair: DexPair, points: number = 35): number[] {
  const currentPrice = getPriceUsd(pair);
  if (currentPrice === 0) return [];

  const change1h = (pair.priceChange?.h1 ?? 0) / 100;
  const change24h = (pair.priceChange?.h24 ?? 0) / 100;

  // Linearly interpolate a price series from 24h ago to now
  const prices: number[] = [];
  const startPrice = currentPrice / (1 + change24h);
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    // Add some sinusoidal variation for realistic-looking series
    const trend = startPrice + (currentPrice - startPrice) * t;
    const noise = (Math.sin(i * 1.7) * 0.005 + Math.cos(i * 0.9) * 0.003) * trend;
    prices.push(trend + noise);
  }
  prices[prices.length - 1] = currentPrice;
  return prices;
}

/** Execute the full agent analysis loop for one tick */
export async function runAgentLoop(
  agentId: string,
  engine: PaperEngine,
  env: Env,
  ctx: DurableObjectState
): Promise<void> {
  const db = drizzle(env.DB);

  // 1. Load agent config
  const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agentRow || agentRow.status !== 'running') {
    console.log(`[agent-loop] Agent ${agentId} not running, skipping tick`);
    return;
  }

  const config = JSON.parse(agentRow.config) as {
    pairs: string[];
    dexes: string[];
    llmModel: string;
    llmFallback: string;
    autonomyLevel: string;
    maxPositionSizePct: number;
    maxOpenPositions: number;
    stopLossPct: number;
    takeProfitPct: number;
    maxDailyLossPct: number;
    cooldownAfterLossMinutes: number;
    maxLlmCallsPerHour: number;
    strategies: string[];
    paperBalance: number;
    slippageSimulation: number;
  };

  const autonomyLevel = intToAutonomyLevel(agentRow.autonomyLevel) as 'full' | 'guided' | 'strict';

  // 2. Check risk limits before doing anything
  const dailyPnl = engine.getDailyPnlPct();
  if (dailyPnl <= -config.maxDailyLossPct) {
    console.log(`[agent-loop] ${agentId}: Daily loss limit reached (${dailyPnl.toFixed(2)}%), pausing`);
    await db
      .update(agents)
      .set({ status: 'paused', updatedAt: nowIso() })
      .where(eq(agents.id, agentId));
    return;
  }

  // Check cooldown (look for recent stop-outs)
  if (config.cooldownAfterLossMinutes > 0) {
    const cooldownMs = config.cooldownAfterLossMinutes * 60_000;
    const lastStopOut = await ctx.storage.get<number>('lastStopOutAt');
    if (lastStopOut && Date.now() - lastStopOut < cooldownMs) {
      console.log(`[agent-loop] ${agentId}: In cooldown, skipping tick`);
      return;
    }
  }

  // 3. Check open positions for stop loss / take profit
  for (const position of engine.openPositions) {
    const dexSvc = createDexDataService(env.CACHE);
    const searchResults = await dexSvc.searchPairs(`${position.pair} base`);
    const pair = searchResults.find((p) => p.chainId === 'base');
    if (!pair) continue;

    const currentPrice = getPriceUsd(pair);
    if (currentPrice === 0) continue;

    if (engine.checkStopLoss(position, currentPrice, config.stopLossPct)) {
      const closed = engine.stopOutPosition(position.id, currentPrice);
      await persistTrade(db, closed);
      await ctx.storage.put('lastStopOutAt', Date.now());
      console.log(
        `[agent-loop] ${agentId}: Stop loss triggered for ${position.pair} at $${currentPrice}`
      );
      continue;
    }

    if (engine.checkTakeProfit(position, currentPrice, config.takeProfitPct)) {
      const closed = engine.closePosition(position.id, {
        price: currentPrice,
        reason: 'Take profit triggered',
      });
      await persistTrade(db, closed);
      console.log(
        `[agent-loop] ${agentId}: Take profit triggered for ${position.pair} at $${currentPrice}`
      );
    }
  }

  // 4. Fetch market data for configured pairs
  const dexSvc = createDexDataService(env.CACHE);
  const marketData: Array<{
    pair: string;
    priceUsd: number;
    priceChange: Record<string, number | undefined>;
    volume24h?: number;
    liquidity?: number;
    indicators?: Record<string, unknown>;
  }> = [];

  for (const pairName of config.pairs.slice(0, 5)) {
    // Limit to 5 pairs max
    try {
      const results = await dexSvc.searchPairs(`${pairName} base`);
      const basePair = results.find((p) => p.chainId === 'base');
      if (!basePair) continue;

      const priceUsd = getPriceUsd(basePair);
      const prices = approximatePriceSeries(basePair);
      const indicators = computeIndicators(prices);

      // Summarize indicators for LLM prompt
      const lastRsi = indicators.rsi?.at(-1);
      const lastEma9 = indicators.ema9?.at(-1);
      const lastEma21 = indicators.ema21?.at(-1);
      const lastMacd = indicators.macd?.at(-1);
      const lastBb = indicators.bollingerBands?.at(-1);

      const indicatorSummary: Record<string, unknown> = {};
      if (lastRsi !== undefined) indicatorSummary.rsi = lastRsi.toFixed(2);
      if (lastEma9 !== undefined && lastEma21 !== undefined) {
        indicatorSummary.ema9 = lastEma9.toFixed(4);
        indicatorSummary.ema21 = lastEma21.toFixed(4);
        indicatorSummary.emaTrend = lastEma9 > lastEma21 ? 'bullish' : 'bearish';
      }
      if (lastMacd?.MACD !== undefined) {
        indicatorSummary.macdHistogram = (
          (lastMacd.MACD ?? 0) - (lastMacd.signal ?? 0)
        ).toFixed(6);
      }
      if (lastBb !== undefined) {
        const bandWidth = lastBb.upper - lastBb.lower;
        indicatorSummary.bollingerPB =
          bandWidth > 0
            ? ((priceUsd - lastBb.lower) / bandWidth).toFixed(3)
            : 'N/A';
      }

      marketData.push({
        pair: pairName,
        priceUsd,
        priceChange: {
          m5: basePair.priceChange?.m5,
          h1: basePair.priceChange?.h1,
          h6: basePair.priceChange?.h6,
          h24: basePair.priceChange?.h24,
        },
        volume24h: basePair.volume?.h24,
        liquidity: basePair.liquidity?.usd,
        indicators: indicatorSummary,
      });
    } catch (err) {
      console.warn(`[agent-loop] ${agentId}: Failed to fetch ${pairName}:`, err);
    }
  }

  if (marketData.length === 0) {
    console.warn(`[agent-loop] ${agentId}: No market data available, skipping`);
    return;
  }

  // 5. Get recent decisions for context
  const recentDecisions = await db
    .select({
      decision: agentDecisions.decision,
      confidence: agentDecisions.confidence,
      createdAt: agentDecisions.createdAt,
    })
    .from(agentDecisions)
    .where(eq(agentDecisions.agentId, agentId))
    .orderBy(desc(agentDecisions.createdAt))
    .limit(10);

  // 6. Call LLM for trade decision
  let decision: Awaited<ReturnType<typeof getTradeDecision>>;
  try {
    decision = await getTradeDecision(
      {
        apiKey: env.OPENROUTER_API_KEY,
        model: config.llmModel,
        fallbackModel: config.llmFallback,
        maxRetries: 2,
      },
      {
        autonomyLevel,
        portfolioState: {
          balance: engine.balance,
          openPositions: engine.openPositions.length,
          dailyPnlPct: engine.getDailyPnlPct(),
          totalPnlPct: engine.getTotalPnlPct(),
        },
        marketData,
        lastDecisions: recentDecisions,
        config: {
          pairs: config.pairs,
          maxPositionSizePct: config.maxPositionSizePct,
          strategies: config.strategies,
        },
      }
    );
  } catch (err) {
    console.error(`[agent-loop] ${agentId}: LLM call failed:`, err);
    // Log the failure as a hold decision
    await db.insert(agentDecisions).values({
      id: generateId('dec'),
      agentId,
      decision: 'hold',
      confidence: 0,
      reasoning: `LLM error: ${String(err)}`,
      llmModel: config.llmModel,
      llmLatencyMs: 0,
      marketDataSnapshot: JSON.stringify(marketData),
      createdAt: nowIso(),
    });
    return;
  }

  // 7. Log the decision
  await db.insert(agentDecisions).values({
    id: generateId('dec'),
    agentId,
    decision: decision.action,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    llmModel: decision.modelUsed,
    llmLatencyMs: decision.latencyMs,
    llmTokensUsed: decision.tokensUsed,
    marketDataSnapshot: JSON.stringify(marketData),
    createdAt: nowIso(),
  });

  console.log(
    `[agent-loop] ${agentId}: Decision=${decision.action} confidence=${decision.confidence.toFixed(2)}`
  );

  // 8. Execute trade if confidence is high enough
  const minConfidence = 0.65;
  if (
    (decision.action === 'buy' || decision.action === 'sell') &&
    decision.confidence >= minConfidence &&
    engine.openPositions.length < config.maxOpenPositions
  ) {
    const targetPairName = decision.targetPair ?? config.pairs[0];
    const pairData = marketData.find((m) => m.pair === targetPairName);
    if (!pairData || pairData.priceUsd === 0) {
      console.warn(`[agent-loop] ${agentId}: No price data for ${targetPairName}`);
      return;
    }

    // Calculate position size: use suggestion from LLM or default to 10% of balance
    const positionSizePct = Math.min(
      decision.suggestedPositionSizePct ?? 10,
      config.maxPositionSizePct
    );
    const amountUsd = (engine.balance * positionSizePct) / 100;

    try {
      const position = engine.openPosition({
        agentId,
        pair: targetPairName,
        dex: config.dexes[0] ?? 'aerodrome',
        side: decision.action as 'buy' | 'sell',
        price: pairData.priceUsd,
        amountUsd,
        maxPositionSizePct: config.maxPositionSizePct,
        balance: engine.balance,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        strategyUsed: config.strategies[0] ?? 'combined',
        slippagePct: config.slippageSimulation,
      });

      await persistTrade(db, position);
      console.log(
        `[agent-loop] ${agentId}: Opened ${decision.action} ${targetPairName} $${amountUsd.toFixed(2)} @ $${pairData.priceUsd}`
      );
    } catch (err) {
      console.warn(`[agent-loop] ${agentId}: Failed to open position:`, err);
    }
  } else if (decision.action === 'close' && engine.openPositions.length > 0) {
    // Close all open positions
    for (const position of engine.openPositions) {
      const pairData = marketData.find((m) => m.pair === position.pair);
      if (!pairData) continue;
      try {
        const closed = engine.closePosition(position.id, {
          price: pairData.priceUsd,
          confidence: decision.confidence,
        });
        await persistTrade(db, closed);
        console.log(
          `[agent-loop] ${agentId}: Closed ${position.pair} PnL=${closed.pnlPct?.toFixed(2)}%`
        );
      } catch (err) {
        console.warn(`[agent-loop] ${agentId}: Failed to close position:`, err);
      }
    }
  }
}

/** Upsert a trade record to D1 */
async function persistTrade(
  db: ReturnType<typeof drizzle>,
  position: Position
): Promise<void> {
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
        closedAt: position.closedAt ?? null,
      },
    });
}
