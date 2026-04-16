/**
 * Agent analysis loop.
 * Called by TradingAgentDO.alarm() on each scheduled tick.
 * Flow: fetch market data → compute indicators → LLM analysis → validate →
 *       execute paper trade → log decision → check risk limits → reschedule
 */
import { drizzle } from 'drizzle-orm/d1';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import { agents, agentDecisions } from '../db/schema.js';
import { PaperEngine } from '../services/paper-engine.js';
import { generateId, nowIso } from '../lib/utils.js';
import { normalizePairForDex } from '../lib/pairs.js';
import { createLogger } from '../lib/logger.js';
import { migrateAgentConfig } from '../lib/agent-config-migration.js';
import { AgentConfigSchema, DEFAULT_FREE_AGENT_MODEL } from '@something-in-loop/shared';
import type { CachedAgentRow } from './trading-agent.js';
import { fetchAgentMarketContext } from './agent-loop/market.js';
import { executeTradeDecision, persistTrade } from './agent-loop/execution.js';
import { resolveLlmCredentials } from './agent-loop/llm-config.js';
import { runInitiaPerpPath } from './agent-loop/initia-perp.js';
import { runRiskControls } from './agent-loop/risk-controls.js';
import { enqueueLlmJob } from './agent-loop/queue.js';
import { buildBaseTradeRequest, checkBaseRateLimitOrHold, runBaseSyncDecision } from './agent-loop/base-flow.js';
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

  const canContinueAfterRisk = await runRiskControls({
    agentId,
    engine,
    env,
    db,
    ctx,
    config,
  });
  if (!canContinueAfterRisk) return;

  const MAX_PAIRS = 5;
  if (config.pairs.length > MAX_PAIRS) {
    log.warn('pairs_truncated', { configured: config.pairs.length, using: MAX_PAIRS });
  }
  const pairsToFetch = config.pairs.slice(0, MAX_PAIRS).map(normalizePairForDex);
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

  const llmCredentials = await resolveLlmCredentials({
    env,
    db,
    agentId,
    agentRow,
    effectiveLlmModel,
    marketData,
  });
  if (!llmCredentials) return;
  const { llmApiKey, llmProvider } = llmCredentials;

  // For Initia agents: use perp decision + execution planner instead of Base buy/sell flow.
  if (config.chain === 'initia') {
    await runInitiaPerpPath({
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
    });
    return;
  }
  const { tradeRequest, minConfidence } = buildBaseTradeRequest({
    engine,
    pairsToFetch,
    marketData,
    recentDecisions,
    config,
    agentRow,
  });

  const canContinueAfterRateLimit = await checkBaseRateLimitOrHold({
    env,
    db,
    log,
    agentId,
    ownerAddress: agentRow.ownerAddress,
    effectiveLlmModel,
    marketData,
  });
  if (!canContinueAfterRateLimit) return;

  const jobHandled = await enqueueLlmJob({
    agentId,
    ownerAddress: agentRow.ownerAddress ?? null,
    env,
    ctx,
    log,
    marketData,
    pairsToFetch,
    effectiveLlmModel,
    effectiveLlmFallback,
    allowFallback,
    llmProvider,
    minConfidence,
    tradeRequest,
    config,
  });
  if (jobHandled) return;

  const decision = await runBaseSyncDecision({
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
    temperature: config.temperature,
  });
  if (!decision) return;

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
