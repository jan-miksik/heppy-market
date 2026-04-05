/**
 * Agent analysis loop.
 * Called by TradingAgentDO.alarm() on each scheduled tick.
 * Flow: fetch market data → compute indicators → LLM analysis → validate →
 *       execute paper trade → log decision → check risk limits → reschedule
 */
import { drizzle } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import { agents, agentDecisions, users } from '../db/schema.js';
import { PaperEngine } from '../services/paper-engine.js';
import { resolveCurrentPriceUsd } from '../services/price-resolver.js';
import { getTradeDecision } from '../services/llm-router.js';
import type { LlmJobMessage } from '../types/queue-types.js';
import { generateId, nowIso } from '../lib/utils.js';
import { decryptKey } from '../lib/crypto.js';
import { normalizePairForDex } from '../lib/pairs.js';
import { logStructuredError } from '../lib/agent-errors.js';
import { createLogger } from '../lib/logger.js';
import { checkLlmRateLimit } from '../lib/global-rate-limiter.js';
import { migrateAgentConfig } from '../lib/agent-config-migration.js';
import { AgentBehaviorConfigSchema, AgentConfigSchema, DEFAULT_FREE_AGENT_MODEL } from '@something-in-loop/shared';
import { resolveAgentPersonaMd } from './resolve-agent-persona.js';
import type { CachedAgentRow } from './trading-agent.js';
import { fetchAgentMarketContext } from './agent-loop/market.js';
import { executeTradeDecision, persistTrade } from './agent-loop/execution.js';
import type { ExecuteDecisionParams } from './agent-loop/execution.js';
import type { MarketDataItem, PendingLlmContext, RecentDecision } from './agent-loop/types.js';

export { executeTradeDecision };
export type { ExecuteDecisionParams };
export type { MarketDataItem, PendingLlmContext, RecentDecision };

/** Execute the full agent analysis loop for one tick */
export async function runAgentLoop(
  agentId: string,
  engine: PaperEngine,
  env: Env,
  ctx: DurableObjectState,
  options?: { forceRun?: boolean; bypassCache?: boolean },
): Promise<void> {
  const log = createLogger('agent-loop', agentId);
  const tickStart = Date.now();
  log.info('tick_start', { forceRun: options?.forceRun ?? false, bypassCache: options?.bypassCache ?? false });
  const db = drizzle(env.DB);
  try {
    await db.run(sql`PRAGMA foreign_keys = ON`);
  } catch {
    // non-fatal
  }
  const bypassCache = options?.bypassCache ?? false;

  // 1. Load agent config from DO storage cache first; warm from D1 on miss.
  let agentRow: CachedAgentRow | (typeof agents.$inferSelect) | null = null;

  const cachedRow = await ctx.storage.get<CachedAgentRow>('cachedAgentRow');
  if (cachedRow && cachedRow.id === agentId) {
    agentRow = cachedRow;
    log.info('agent_config_cache_hit', { agentId });
  } else {
    log.info('agent_config_cache_miss', { agentId });
    const [dbRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!dbRow) {
      console.log(`[agent-loop] Agent ${agentId} not found`);
      return;
    }
    agentRow = dbRow;
    try {
      const toCache: CachedAgentRow = {
        id: dbRow.id,
        name: dbRow.name,
        status: dbRow.status,
        config: dbRow.config,
        ownerAddress: dbRow.ownerAddress ?? null,
        llmModel: dbRow.llmModel ?? null,
        profileId: dbRow.profileId ?? null,
        personaMd: dbRow.personaMd ?? null,
      };
      await ctx.storage.put('cachedAgentRow', toCache);
    } catch (cacheErr) {
      console.warn(`[agent-loop] ${agentId}: failed to warm agent row cache:`, cacheErr);
    }
  }

  if (!options?.forceRun && agentRow.status !== 'running') {
    console.log(`[agent-loop] Agent ${agentId} not running (status=${agentRow.status}), skipping tick`);
    return;
  }

  // Drain any pending trade from a previous failed D1 write.
  const pendingTrade = await ctx.storage.get<Parameters<typeof persistTrade>[1]>('pendingTrade');
  if (pendingTrade) {
    try {
      await persistTrade(db, pendingTrade);
      await ctx.storage.delete('pendingTrade');
      console.log(`[agent-loop] ${agentId}: Drained pending trade ${pendingTrade.id} to D1`);
    } catch (drainErr) {
      console.warn(`[agent-loop] ${agentId}: Failed to drain pending trade ${pendingTrade.id}:`, drainErr);
    }
  }

  let config: ReturnType<typeof AgentConfigSchema.parse>;
  try {
    const rawConfig = { name: agentRow.name, ...JSON.parse(agentRow.config) };
    const migratedConfig = migrateAgentConfig(rawConfig);
    config = AgentConfigSchema.parse(migratedConfig);
  } catch (configErr) {
    console.error(`[agent-loop] ${agentId}: Invalid agent config in DB:`, configErr);
    throw configErr;
  }

  try {
    await ctx.storage.put('analysisInterval', config.analysisInterval);
  } catch (err) {
    console.warn(`[agent-loop] ${agentId}: failed to persist analysisInterval to DO storage:`, err);
  }

  const effectiveLlmModel = agentRow.llmModel?.trim() || config.llmModel || DEFAULT_FREE_AGENT_MODEL;
  const effectiveLlmFallback = config.llmFallback?.trim() || DEFAULT_FREE_AGENT_MODEL;
  const allowFallback = config.allowFallback === true;

  // 2. Risk limits and cooldown checks.
  const dailyPnl = engine.getDailyPnlPct();
  if (dailyPnl <= -config.maxDailyLossPct) {
    console.log(`[agent-loop] ${agentId}: Daily loss limit reached (${dailyPnl.toFixed(2)}%), pausing`);
    await db.update(agents).set({ status: 'paused', updatedAt: nowIso() }).where(eq(agents.id, agentId));
    try {
      await ctx.storage.put('status', 'paused');
      const cached = await ctx.storage.get<CachedAgentRow>('cachedAgentRow');
      if (cached) await ctx.storage.put('cachedAgentRow', { ...cached, status: 'paused' });
    } catch {
      // non-fatal
    }
    return;
  }

  if (config.cooldownAfterLossMinutes > 0) {
    const cooldownMs = config.cooldownAfterLossMinutes * 60_000;
    const lastStopOut = await ctx.storage.get<number>('lastStopOutAt');
    if (lastStopOut && Date.now() - lastStopOut < cooldownMs) {
      console.log(`[agent-loop] ${agentId}: In cooldown, skipping tick`);
      return;
    }
  }

  // 3. Check open positions for stop loss / take profit.
  for (const position of engine.openPositions) {
    const currentPrice = await resolveCurrentPriceUsd(env, position.pair);
    if (currentPrice === 0) {
      const missKey = `priceMiss:${position.id}`;
      const misses = ((await ctx.storage.get<number>(missKey)) ?? 0) + 1;
      await ctx.storage.put(missKey, misses);
      if (misses >= 3) {
        console.error(
          `[agent-loop] ${agentId}: CRITICAL — price resolution failed ${misses} consecutive times for open position ${position.id} (${position.pair}). SL/TP checks skipped. Investigate GeckoTerminal/DexScreener availability.`,
        );
      } else {
        console.warn(
          `[agent-loop] ${agentId}: Price resolution returned 0 for ${position.pair} (miss #${misses}). Skipping SL/TP check this tick.`,
        );
      }
      continue;
    }
    await ctx.storage.delete(`priceMiss:${position.id}`);

    if (engine.checkStopLoss(position, currentPrice, config.stopLossPct)) {
      try {
        const closed = engine.stopOutPosition(position.id, currentPrice);
        await ctx.storage.put('pendingTrade', closed);
        await persistTrade(db, closed);
        await ctx.storage.delete('pendingTrade');
        await ctx.storage.delete(`priceMiss:${position.id}`);
        await ctx.storage.put('lastStopOutAt', Date.now());
        console.log(`[agent-loop] ${agentId}: Stop loss triggered for ${position.pair} at $${currentPrice}`);
      } catch (err) {
        console.warn(`[agent-loop] ${agentId}: Failed to persist stop-loss for ${position.pair}:`, err);
      }
      continue;
    }

    if (engine.checkTakeProfit(position, currentPrice, config.takeProfitPct)) {
      try {
        const closed = engine.closePosition(position.id, {
          price: currentPrice,
          reason: 'Take profit triggered',
          closeReason: 'take_profit',
        });
        await ctx.storage.put('pendingTrade', closed);
        await persistTrade(db, closed);
        await ctx.storage.delete('pendingTrade');
        await ctx.storage.delete(`priceMiss:${position.id}`);
        console.log(`[agent-loop] ${agentId}: Take profit triggered for ${position.pair} at $${currentPrice}`);
      } catch (err) {
        console.warn(`[agent-loop] ${agentId}: Failed to persist take-profit for ${position.pair}:`, err);
      }
    }
  }

  const pairsToFetch = config.pairs.slice(0, 5).map(normalizePairForDex);
  log.info('analysis_start', { pairs: pairsToFetch.length, model: effectiveLlmModel });
  console.log(`[agent-loop] ${agentId}: Starting analysis (${pairsToFetch.length} pairs, model=${effectiveLlmModel})`);

  const doneMarketFetch = log.time('market_data_fetch', { pairs: pairsToFetch.length });
  const { marketData, recentDecisions } = await fetchAgentMarketContext({
    agentId,
    env,
    ctx,
    db,
    pairsToFetch,
    log,
    bypassCache,
  });
  doneMarketFetch();

  if (marketData.length === 0) {
    console.warn(
      `[agent-loop] ${agentId}: No market data available — DexScreener returned no Base chain pairs for configured pairs: ${pairsToFetch.join(', ')}`,
    );
    await db.insert(agentDecisions).values({
      id: generateId('dec'),
      agentId,
      decision: 'hold',
      confidence: 0,
      reasoning: `No market data available from GeckoTerminal or DexScreener for pairs: ${pairsToFetch.join(', ')}. Check that the pair names are correct (e.g. "WETH/USDC", "AERO/USDC") and that the internet is reachable from the Worker.`,
      llmModel: effectiveLlmModel,
      llmLatencyMs: 0,
      marketDataSnapshot: '[]',
      createdAt: nowIso(),
    });
    return;
  }

  console.log(`[agent-loop] ${agentId}: Got market data for ${marketData.map((m) => m.pair).join(', ')}`);

  // 6. Resolve LLM provider/key.
  const isAnthropicModel = effectiveLlmModel.startsWith('claude-');
  console.log(
    `[agent-loop] ${agentId}: LLM routing — model=${effectiveLlmModel} isAnthropic=${isAnthropicModel} hasAnthropicKey=${!!env.ANTHROPIC_API_KEY}`,
  );

  let llmApiKey: string | undefined;
  let llmProvider: 'openrouter' | 'anthropic' = 'openrouter';

  if (isAnthropicModel) {
    if (!env.ANTHROPIC_API_KEY) {
      console.error(`[agent-loop] ${agentId}: ANTHROPIC_API_KEY is not set. Cannot use Claude model.`);
      await db.insert(agentDecisions).values({
        id: generateId('dec'),
        agentId,
        decision: 'hold',
        confidence: 0,
        reasoning: 'ANTHROPIC_API_KEY is not configured. Add it to .dev.vars (local) or Cloudflare secrets (production).',
        llmModel: effectiveLlmModel,
        llmLatencyMs: 0,
        marketDataSnapshot: JSON.stringify(marketData),
        createdAt: nowIso(),
      });
      return;
    }
    const ownerAddress = agentRow.ownerAddress?.toLowerCase();
    if (ownerAddress) {
      const [ownerUser] = await db.select({ role: users.role }).from(users).where(eq(users.walletAddress, ownerAddress));
      if (ownerUser?.role !== 'tester') {
        console.warn(`[agent-loop] ${agentId}: owner ${ownerAddress} is not a tester. Anthropic models restricted.`);
        await db.insert(agentDecisions).values({
          id: generateId('dec'),
          agentId,
          decision: 'hold',
          confidence: 0,
          reasoning: 'Claude models are restricted to tester accounts. Contact the admin to enable access.',
          llmModel: effectiveLlmModel,
          llmLatencyMs: 0,
          marketDataSnapshot: JSON.stringify(marketData),
          createdAt: nowIso(),
        });
        return;
      }
    }
    llmApiKey = env.ANTHROPIC_API_KEY;
    llmProvider = 'anthropic';
  } else {
    if (!env.OPENROUTER_API_KEY) {
      console.error(
        `[agent-loop] ${agentId}: OPENROUTER_API_KEY is not set. Cannot call LLM. Add it to .dev.vars (local) or Cloudflare secrets (production).`,
      );
      await db.insert(agentDecisions).values({
        id: generateId('dec'),
        agentId,
        decision: 'hold',
        confidence: 0,
        reasoning:
          'OPENROUTER_API_KEY is not configured. Please set it in .dev.vars (local) or Cloudflare secrets (production) — get a free key at openrouter.ai',
        llmModel: effectiveLlmModel,
        llmLatencyMs: 0,
        marketDataSnapshot: JSON.stringify(marketData),
        createdAt: nowIso(),
      });
      return;
    }
    let resolvedKey = env.OPENROUTER_API_KEY;
    const ownerAddr = agentRow.ownerAddress?.toLowerCase();
    if (ownerAddr) {
      const [ownerUser] = await db.select({ openRouterKey: users.openRouterKey }).from(users).where(eq(users.walletAddress, ownerAddr));
      if (ownerUser?.openRouterKey) {
        try {
          resolvedKey = await decryptKey(ownerUser.openRouterKey, env.KEY_ENCRYPTION_SECRET);
        } catch {
          console.warn(`[agent-loop] ${agentId}: failed to decrypt user OR key, using server fallback`);
        }
      }
    }
    llmApiKey = resolvedKey;
  }

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

  const rateLimitKey = agentRow.ownerAddress?.toLowerCase();
  if (rateLimitKey && env.RATE_LIMITER) {
    const rl = await checkLlmRateLimit(env, rateLimitKey);
    if (!rl.allowed) {
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
      return;
    }
  }

  const tradeRequest = {
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
    behaviorMd: (config as any).behaviorMd ?? null,
    roleMd: (config as any).roleMd ?? null,
  };

  // Queue path: enqueue LLM job for async processing.
  if (env.LLM_QUEUE) {
    const existingJobId = await ctx.storage.get<string>('pendingLlmJobId');
    if (existingJobId) {
      const jobAt = (await ctx.storage.get<number>('pendingLlmJobAt')) ?? 0;
      if (Date.now() - jobAt < 5 * 60_000) {
        log.info('llm_job_pending_skip', { jobId: existingJobId });
        return;
      }
      log.warn('llm_job_stale_cleared', { jobId: existingJobId, ageMs: Date.now() - jobAt });
      await ctx.storage.delete('pendingLlmJobId');
      await ctx.storage.delete('pendingLlmJobAt');
      await ctx.storage.delete('pendingLlmContext');
    }

    const jobId = generateId('job');
    const pendingCtx: PendingLlmContext = {
      jobId,
      enqueuedAt: Date.now(),
      marketData,
      pairsToFetch,
      effectiveLlmModel,
      maxOpenPositions: config.maxOpenPositions,
      maxPositionSizePct: config.maxPositionSizePct,
      stopLossPct: config.stopLossPct,
      takeProfitPct: config.takeProfitPct,
      minConfidence,
      dexes: config.dexes,
      strategies: config.strategies,
      slippageSimulation: config.slippageSimulation,
    };
    await ctx.storage.put('pendingLlmContext', pendingCtx);
    await ctx.storage.put('pendingLlmJobId', jobId);
    await ctx.storage.put('pendingLlmJobAt', Date.now());

    const message: LlmJobMessage = {
      agentId,
      jobId,
      llmConfig: {
        apiKey: llmApiKey!,
        model: effectiveLlmModel,
        fallbackModel: effectiveLlmFallback,
        allowFallback,
        temperature: config.temperature,
        timeoutMs: 90_000,
        provider: llmProvider,
        debugLogging: env.LOG_LLM_DEBUG === 'true',
      },
      tradeRequest,
    };
    await env.LLM_QUEUE.send(message);
    log.info('llm_job_enqueued', { jobId, model: effectiveLlmModel });
    return;
  }

  // Sync path: call LLM inline.
  let decision: Awaited<ReturnType<typeof getTradeDecision>>;
  const doneLlm = log.time('llm_call', { model: effectiveLlmModel });
  try {
    decision = await getTradeDecision(
      {
        apiKey: llmApiKey!,
        model: effectiveLlmModel,
        fallbackModel: effectiveLlmFallback,
        allowFallback,
        temperature: config.temperature,
        timeoutMs: 90_000,
        provider: llmProvider,
        debugLogging: env.LOG_LLM_DEBUG === 'true',
      },
      tradeRequest,
    );
  } catch (err) {
    doneLlm();
    const { classifyLlmError } = await import('../lib/agent-errors.js');
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
    return;
  }
  doneLlm();

  await executeTradeDecision(decision, {
    agentId,
    engine,
    marketData,
    pairsToFetch,
    recentDecisions,
    effectiveLlmModel,
    minConfidence,
    maxOpenPositions: config.maxOpenPositions,
    maxPositionSizePct: config.maxPositionSizePct,
    dexes: config.dexes,
    strategies: config.strategies,
    slippageSimulation: config.slippageSimulation,
    env,
    db,
    ctx,
    tickStart,
    log,
  } satisfies ExecuteDecisionParams);
}
