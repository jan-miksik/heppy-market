/**
 * Agent analysis loop.
 * Called by TradingAgentDO.alarm() on each scheduled tick.
 * Flow: fetch market data → compute indicators → LLM analysis → validate →
 *       execute paper trade → log decision → check risk limits → reschedule
 */
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, sql } from 'drizzle-orm';
import type { Env } from '../types/env.js';
import { agents, trades, agentDecisions, users } from '../db/schema.js';
import { createDexDataService, getPriceUsd } from '../services/dex-data.js';
import type { DexPair } from '../services/dex-data.js';
import { createGeckoTerminalService } from '../services/gecko-terminal.js';
import { computeIndicators, evaluateSignals, combineSignals } from '../services/indicators.js';
import { PaperEngine, type Position } from '../services/paper-engine.js';
import { resolveCurrentPriceUsd } from '../services/price-resolver.js';
import { getTradeDecision } from '../services/llm-router.js';
import { generateId, nowIso } from '../lib/utils.js';
import { decryptKey } from '../lib/crypto.js';
import { normalizePairForDex } from '../lib/pairs.js';
import type { AgentBehaviorConfig } from '@dex-agents/shared';
import { AgentBehaviorConfigSchema, AgentConfigSchema } from '@dex-agents/shared';
import { resolveAgentPersonaMd } from './resolve-agent-persona.js';

/** Build a search query from a pair name.
 *  "WETH/USDC" → "WETH USDC"
 *  Note: Do NOT append "base" — DexScreener returns worse results with it.
 *  Chain filtering is done on the response by checking chainId.
 */
function pairToSearchQuery(pairName: string): string {
  return pairName.replace('/', ' ');
}

/**
 * Well-known Base chain token addresses for reliable pair lookups.
 * Used as a fallback when text search fails.
 */
const BASE_TOKEN_ADDRESSES: Record<string, string> = {
  WETH:  '0x4200000000000000000000000000000000000006',
  USDC:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
  cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  AERO:  '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  DEGEN: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
  BRETT: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
  TOSHI: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
};

/**
 * Returns true when a pool/pair name contains ALL token symbols from the
 * configured pair name (case-insensitive).  Prevents CBBTC/WETH results
 * from being used as WETH/USDC data just because both contain "WETH".
 *
 * "WETH / USDC 0.05%" → matches ["WETH","USDC"] ✓
 * "CBBTC / WETH 0.3%" → does NOT match ["WETH","USDC"] ✗
 */
function poolMatchesPair(poolName: string, pairName: string): boolean {
  const tokens = pairName.split('/').map((t) => t.trim().toUpperCase());
  const name = poolName.toUpperCase();
  return tokens.every((t) => name.includes(t));
}

/** Execute the full agent analysis loop for one tick */
export async function runAgentLoop(
  agentId: string,
  engine: PaperEngine,
  env: Env,
  ctx: DurableObjectState,
  options?: { forceRun?: boolean; bypassCache?: boolean }
): Promise<void> {
  const db = drizzle(env.DB);
  // Enable FK enforcement (session-level in SQLite, must be set per connection)
  try { await db.run(sql`PRAGMA foreign_keys = ON`); } catch { /* non-fatal */ }
  const bypassCache = options?.bypassCache ?? false;
  const geckoSvc = createGeckoTerminalService(env.CACHE, { bypassCache });
  const dexSvc = createDexDataService(env.CACHE, { bypassCache });

  // 1. Load agent config
  const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agentRow) {
    console.log(`[agent-loop] Agent ${agentId} not found`);
    return;
  }
  // forceRun bypasses the status check (used for manual "Run Analysis" on stopped agents)
  if (!options?.forceRun && agentRow.status !== 'running') {
    console.log(`[agent-loop] Agent ${agentId} not running (status=${agentRow.status}), skipping tick`);
    return;
  }

  // --- Drain any pending trade from a previous failed D1 write ---
  const pendingTrade = await ctx.storage.get<Parameters<typeof persistTrade>[1]>('pendingTrade');
  if (pendingTrade) {
    try {
      await persistTrade(db, pendingTrade);
      await ctx.storage.delete('pendingTrade');
      console.log(`[agent-loop] ${agentId}: Drained pending trade ${pendingTrade.id} to D1`);
    } catch (drainErr) {
      console.warn(`[agent-loop] ${agentId}: Failed to drain pending trade ${pendingTrade.id}:`, drainErr);
      // Leave pendingTrade in storage — will retry next tick
    }
  }
  // --- End drain ---

  let config: ReturnType<typeof AgentConfigSchema.parse>;
  try {
    // Backfill `name` from the DB column — older configs may not have it in the JSON blob
    const rawConfig = { name: agentRow.name, ...JSON.parse(agentRow.config) };

    // Migrate legacy analysisInterval stored as seconds string (e.g. "300" → "5m")
    const intervalMap: Record<string, string> = {
      '60': '1m', '300': '5m', '900': '15m', '3600': '1h', '14400': '4h', '86400': '1d',
    };
    if (typeof rawConfig.analysisInterval === 'string' && intervalMap[rawConfig.analysisInterval]) {
      rawConfig.analysisInterval = intervalMap[rawConfig.analysisInterval];
    }
    // Migrate removed short intervals to minimum supported interval
    if (rawConfig.analysisInterval === '1m' || rawConfig.analysisInterval === '5m') {
      console.warn(`[agent-loop] ${agentId}: analysisInterval "${rawConfig.analysisInterval}" is no longer supported → upgrading to "15m"`);
      rawConfig.analysisInterval = '15m';
    }
    // Clamp analysisInterval to valid enum — any unrecognized value (e.g. "30m" from manager LLM) → "1h" (global default)
    const validIntervals = new Set(['15m', '1h', '4h', '1d']);
    if (typeof rawConfig.analysisInterval === 'string' && !validIntervals.has(rawConfig.analysisInterval)) {
      console.warn(`[agent-loop] ${agentId}: Unknown analysisInterval "${rawConfig.analysisInterval}" → defaulting to "1h"`);
      rawConfig.analysisInterval = '1h';
    }

    // Migrate legacy strategy values not in the current enum → "combined"
    const validStrategies = new Set(['ema_crossover', 'rsi_oversold', 'macd_signal', 'bollinger_bounce', 'volume_breakout', 'llm_sentiment', 'combined']);
    if (Array.isArray(rawConfig.strategies)) {
      rawConfig.strategies = rawConfig.strategies.map((s: string) => validStrategies.has(s) ? s : 'combined');
      if (rawConfig.strategies.length === 0) rawConfig.strategies = ['combined'];
    }

    // Clamp numeric fields to schema bounds to tolerate LLM-generated out-of-range values
    if (typeof rawConfig.stopLossPct === 'number')        rawConfig.stopLossPct        = Math.min(50,  Math.max(0.5, rawConfig.stopLossPct));
    if (typeof rawConfig.takeProfitPct === 'number')      rawConfig.takeProfitPct      = Math.min(100, Math.max(0.5, rawConfig.takeProfitPct));
    if (typeof rawConfig.maxPositionSizePct === 'number') rawConfig.maxPositionSizePct = Math.min(100, Math.max(1,   rawConfig.maxPositionSizePct));
    if (typeof rawConfig.maxOpenPositions === 'number')   rawConfig.maxOpenPositions   = Math.min(10,  Math.max(1,   Math.round(rawConfig.maxOpenPositions)));
    if (typeof rawConfig.maxDailyLossPct === 'number')    rawConfig.maxDailyLossPct    = Math.min(50,  Math.max(1,   rawConfig.maxDailyLossPct));
    if (typeof rawConfig.paperBalance === 'number')       rawConfig.paperBalance       = Math.min(1_000_000, Math.max(100, rawConfig.paperBalance));
    if (typeof rawConfig.temperature === 'number')        rawConfig.temperature        = Math.min(2,   Math.max(0,   rawConfig.temperature));

    config = AgentConfigSchema.parse(rawConfig);
  } catch (configErr) {
    console.error(`[agent-loop] ${agentId}: Invalid agent config in DB:`, configErr);
    throw configErr; // Bubble up so the DO handler returns a 500 visible to the user
  }

  // Keep the Durable Object's interval in sync with the DB config so edits actually take effect.
  // (The DO uses its stored interval for alarm rescheduling.)
  try {
    await ctx.storage.put('analysisInterval', config.analysisInterval);
  } catch (err) {
    console.warn(`[agent-loop] ${agentId}: failed to persist analysisInterval to DO storage:`, err);
  }

  // Use DB column as source of truth for model (avoids stale/missing config.llmModel)
  const effectiveLlmModel = agentRow.llmModel?.trim() || config.llmModel || 'nvidia/nemotron-3-super-120b-a12b:free';
  const effectiveLlmFallback = config.llmFallback?.trim() || 'nvidia/nemotron-3-super-120b-a12b:free';
  const allowFallback = config.allowFallback === true;

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
    const currentPrice = await resolveCurrentPriceUsd(env, position.pair);
    if (currentPrice === 0) {
      const missKey = `priceMiss:${position.id}`;
      const misses = ((await ctx.storage.get<number>(missKey)) ?? 0) + 1;
      await ctx.storage.put(missKey, misses);
      if (misses >= 3) {
        console.error(
          `[agent-loop] ${agentId}: CRITICAL — price resolution failed ${misses} consecutive times for open position ${position.id} (${position.pair}). SL/TP checks skipped. Investigate GeckoTerminal/DexScreener availability.`
        );
      } else {
        console.warn(
          `[agent-loop] ${agentId}: Price resolution returned 0 for ${position.pair} (miss #${misses}). Skipping SL/TP check this tick.`
        );
      }
      continue;
    }
    // Reset miss counter on successful price resolution
    await ctx.storage.delete(`priceMiss:${position.id}`);

    if (engine.checkStopLoss(position, currentPrice, config.stopLossPct)) {
      try {
        const closed = engine.stopOutPosition(position.id, currentPrice);
        await ctx.storage.put('pendingTrade', closed);
        await persistTrade(db, closed);
        await ctx.storage.delete('pendingTrade');
        await ctx.storage.delete(`priceMiss:${position.id}`);
        await ctx.storage.put('lastStopOutAt', Date.now());
        console.log(
          `[agent-loop] ${agentId}: Stop loss triggered for ${position.pair} at $${currentPrice}`
        );
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
        });
        await ctx.storage.put('pendingTrade', closed);
        await persistTrade(db, closed);
        await ctx.storage.delete('pendingTrade');
        await ctx.storage.delete(`priceMiss:${position.id}`);
        console.log(
          `[agent-loop] ${agentId}: Take profit triggered for ${position.pair} at $${currentPrice}`
        );
      } catch (err) {
        console.warn(`[agent-loop] ${agentId}: Failed to persist take-profit for ${position.pair}:`, err);
      }
    }
  }

  // Normalize pair names (e.g. ETH-USD → WETH/USDC) so GeckoTerminal/DexScreener can resolve them
  const pairsToFetch = config.pairs.slice(0, 5).map(normalizePairForDex);
  console.log(`[agent-loop] ${agentId}: Starting analysis (${pairsToFetch.length} pairs, model=${effectiveLlmModel})`);

  // 4. Fetch market data — GeckoTerminal primary (network-scoped + real OHLCV),
  //    DexScreener fallback (global search, filter to Base).
  const marketData: Array<{
    pair: string;
    pairAddress: string;
    dexScreenerUrl: string;
    priceUsd: number;
    priceChange: Record<string, number | undefined>;
    volume24h?: number;
    liquidity?: number;
    indicatorText: string;
    dailyIndicatorText: string;
  }> = [];

  for (const pairName of pairsToFetch) {
    const query = pairToSearchQuery(pairName);
    let priceUsd = 0;
    let pairAddress = '';

    let priceChange: Record<string, number | undefined> = {};
    let volume24h: number | undefined;
    let liquidity: number | undefined;
    let prices: number[] = [];
    let dailyPrices: number[] = [];

    // ── Try GeckoTerminal first ──────────────────────────────────────────────
    try {
      console.log(`[agent-loop] ${agentId}: GeckoTerminal search "${query}"`);
      const pools = await geckoSvc.searchPools(query);
      // Filter to pools whose name actually contains both token symbols —
      // prevents CBBTC/WETH sneaking in as the top result for "WETH USDC".
      const pool = pools.find((p) => poolMatchesPair(p.name, pairName));
      if (pool && pool.priceUsd > 0) {
        priceUsd = pool.priceUsd;
        pairAddress = pool.address;
        priceChange = pool.priceChange;
        volume24h = pool.volume24h;
        liquidity = pool.liquidityUsd;
        console.log(`[agent-loop] ${agentId}: GeckoTerminal found ${pool.name} @ $${priceUsd} liq=$${(liquidity ?? 0).toLocaleString()}`);

        // Fetch hourly (48 candles) and daily (30 candles) OHLCV in parallel
        const [hourlyResult, dailyResult] = await Promise.allSettled([
          geckoSvc.getPoolPriceSeries(pool.address, 48, 'hour'),
          geckoSvc.getPoolPriceSeries(pool.address, 30, 'day'),
        ]);
        if (hourlyResult.status === 'fulfilled') {
          prices = hourlyResult.value;
          console.log(`[agent-loop] ${agentId}: Got ${prices.length} hourly candles`);
        } else {
          console.warn(`[agent-loop] ${agentId}: Hourly OHLCV unavailable:`, hourlyResult.reason);
        }
        if (dailyResult.status === 'fulfilled') {
          dailyPrices = dailyResult.value;
          console.log(`[agent-loop] ${agentId}: Got ${dailyPrices.length} daily candles`);
        } else {
          console.warn(`[agent-loop] ${agentId}: Daily OHLCV unavailable:`, dailyResult.reason);
        }
      }
    } catch (geckoErr) {
      console.warn(`[agent-loop] ${agentId}: GeckoTerminal failed for "${query}":`, geckoErr);
    }

    // ── Fallback: DexScreener ────────────────────────────────────────────────
    if (priceUsd === 0) {
      try {
        const dexQuery = pairToSearchQuery(pairName);
        console.log(`[agent-loop] ${agentId}: DexScreener fallback for "${dexQuery}"`);
        const results = await dexSvc.searchPairs(dexQuery);
        const basePair = results
          .filter((p) => p.chainId === 'base')
          .filter((p) => poolMatchesPair(`${p.baseToken.symbol}/${p.quoteToken.symbol}`, pairName))
          .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] as DexPair | undefined;
        if (basePair) {
          priceUsd = getPriceUsd(basePair);
          pairAddress = basePair.pairAddress;
          priceChange = {
            m5: basePair.priceChange?.m5,
            h1: basePair.priceChange?.h1,
            h6: basePair.priceChange?.h6,
            h24: basePair.priceChange?.h24,
          };
          volume24h = basePair.volume?.h24;
          liquidity = basePair.liquidity?.usd;
          console.log(`[agent-loop] ${agentId}: DexScreener found @ $${priceUsd}`);
        } else {
          console.warn(`[agent-loop] ${agentId}: DexScreener also found no Base pair for "${query}"`);
        }
      } catch (dexErr) {
        console.warn(`[agent-loop] ${agentId}: DexScreener failed for "${query}":`, dexErr);
      }
    }

    // ── Last resort: look up by well-known token address ──────────────────
    if (priceUsd === 0) {
      const tokens = pairName.split('/').map((t) => t.trim().toUpperCase());
      const baseAddr = BASE_TOKEN_ADDRESSES[tokens[0]];
      if (baseAddr) {
        try {
          console.log(`[agent-loop] ${agentId}: Token address fallback for ${tokens[0]} (${baseAddr})`);
          const results = await dexSvc.getTokenPairs(baseAddr);
          const basePair = results
            .filter((p) => p.chainId === 'base')
            .filter((p) => poolMatchesPair(`${p.baseToken.symbol}/${p.quoteToken.symbol}`, pairName))
            .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] as DexPair | undefined;
          if (basePair) {
            priceUsd = getPriceUsd(basePair);
            pairAddress = basePair.pairAddress;
            priceChange = {
              m5: basePair.priceChange?.m5,
              h1: basePair.priceChange?.h1,
              h6: basePair.priceChange?.h6,
              h24: basePair.priceChange?.h24,
            };
            volume24h = basePair.volume?.h24;
            liquidity = basePair.liquidity?.usd;
            console.log(`[agent-loop] ${agentId}: Token address fallback found @ $${priceUsd}`);
          }
        } catch (tokenErr) {
          console.warn(`[agent-loop] ${agentId}: Token address fallback failed:`, tokenErr);
        }
      }
    }

    if (priceUsd === 0) continue; // all providers failed for this pair

    // ── Compute indicators (only when we have enough real OHLCV candles) ──────
    // RSI needs 14 + 1 points, MACD needs 26 + 9 + 1 = 36 points minimum.
    // If we don't have real data we skip indicators entirely rather than use fabricated prices.
    const indicators = prices.length >= 14 ? computeIndicators(prices) : null;

    /** Build a human-readable indicator summary string from a computed indicator set */
    function buildIndicatorText(
      indics: ReturnType<typeof computeIndicators> | null,
      currentPrice: number,
      noDataMsg: string,
      includeSignalVerdict: boolean,
    ): string {
      if (!indics) return noDataMsg;
      const lastRsi = indics.rsi?.at(-1);
      const lastEma9 = indics.ema9?.at(-1);
      const lastEma21 = indics.ema21?.at(-1);
      const lastMacd = indics.macd?.at(-1);
      const lastBb = indics.bollingerBands?.at(-1);
      const parts: string[] = [];
      if (lastRsi !== undefined) {
        const rsiLabel = lastRsi < 30 ? 'oversold' : lastRsi > 70 ? 'overbought' : 'neutral';
        parts.push(`RSI: ${lastRsi.toFixed(1)} (${rsiLabel})`);
      }
      if (lastEma9 !== undefined && lastEma21 !== undefined) {
        const trend = lastEma9 > lastEma21 ? 'bullish' : 'bearish';
        parts.push(`EMA9/21: ${trend} (${lastEma9.toFixed(2)} / ${lastEma21.toFixed(2)})`);
      }
      if (lastMacd?.MACD !== undefined && lastMacd?.signal !== undefined) {
        const hist = lastMacd.MACD - lastMacd.signal;
        parts.push(`MACD: ${hist > 0 ? 'bullish' : 'bearish'} (histogram ${hist >= 0 ? '+' : ''}${hist.toFixed(4)})`);
      }
      if (lastBb !== undefined) {
        const bandWidth = lastBb.upper - lastBb.lower;
        if (bandWidth > 0) {
          const pb = (currentPrice - lastBb.lower) / bandWidth;
          const bbLabel = pb < 0.2 ? 'near lower band' : pb > 0.8 ? 'near upper band' : 'mid-range';
          parts.push(`Bollinger %B: ${pb.toFixed(2)} (${bbLabel})`);
        }
      }
      if (includeSignalVerdict) {
        const signals = evaluateSignals(indics, currentPrice);
        const combined = combineSignals(signals);
        parts.push(`Signal verdict: ${combined.signal.toUpperCase()} (${(combined.confidence * 100).toFixed(0)}% conf) — ${combined.reason}`);
      }
      return parts.length > 0 ? parts.join('\n') : noDataMsg;
    }

    const indicatorText = buildIndicatorText(
      indicators,
      priceUsd,
      'No OHLCV data available — indicators skipped',
      true,
    );

    // Daily indicators: RSI/EMA/Bollinger only (MACD needs 36+ points; 30 daily candles is borderline)
    const dailyIndicators = dailyPrices.length >= 14 ? computeIndicators(dailyPrices) : null;
    const dailyIndicatorText = buildIndicatorText(
      dailyIndicators,
      priceUsd,
      'No daily OHLCV data — daily trend skipped',
      false,
    );

    marketData.push({
      pair: pairName,
      pairAddress,
      dexScreenerUrl: `https://dexscreener.com/base/${pairAddress}`,
      priceUsd,
      priceChange,
      volume24h,
      liquidity,
      indicatorText,
      dailyIndicatorText,
    });
  }

  if (marketData.length === 0) {
    console.warn(`[agent-loop] ${agentId}: No market data available — DexScreener returned no Base chain pairs for configured pairs: ${pairsToFetch.join(', ')}`);
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
  const isAnthropicModel = effectiveLlmModel.startsWith('claude-');
  console.log(`[agent-loop] ${agentId}: LLM routing — model=${effectiveLlmModel} isAnthropic=${isAnthropicModel} hasAnthropicKey=${!!env.ANTHROPIC_API_KEY}`);

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
    // Only tester-role users may use Anthropic models
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
      console.error(`[agent-loop] ${agentId}: OPENROUTER_API_KEY is not set. Cannot call LLM. Add it to .dev.vars (local) or Cloudflare secrets (production).`);
      await db.insert(agentDecisions).values({
        id: generateId('dec'),
        agentId,
        decision: 'hold',
        confidence: 0,
        reasoning: 'OPENROUTER_API_KEY is not configured. Please set it in .dev.vars (local) or Cloudflare secrets (production) — get a free key at openrouter.ai',
        llmModel: effectiveLlmModel,
        llmLatencyMs: 0,
        marketDataSnapshot: JSON.stringify(marketData),
        createdAt: nowIso(),
      });
      return;
    }
    // Prefer owner's personal OR key; fall back to server key
    let resolvedKey = env.OPENROUTER_API_KEY;
    const ownerAddr = agentRow.ownerAddress?.toLowerCase();
    if (ownerAddr) {
      const [ownerUser] = await db
        .select({ openRouterKey: users.openRouterKey })
        .from(users)
        .where(eq(users.walletAddress, ownerAddr));
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

  // Build open position summaries for the LLM — includes unrealized P&L and SL/TP context
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

  let decision: Awaited<ReturnType<typeof getTradeDecision>>;
  try {
    decision = await getTradeDecision(
      {
        apiKey: llmApiKey,
        model: effectiveLlmModel,
        fallbackModel: effectiveLlmFallback,
        allowFallback,
        temperature: config.temperature,
        timeoutMs: 90_000,
        provider: llmProvider,
      },
      {
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
      llmModel: effectiveLlmModel,
      llmLatencyMs: 0,
      marketDataSnapshot: JSON.stringify(marketData),
      createdAt: nowIso(),
    });
    return;
  }

  // Execution threshold is defined by the agent itself (its behavior profile).
  // Even when config.behavior is missing, the schema supplies defaults.
  // confidenceThreshold is 0–100, convert to 0–1.
  const effectiveBehavior = AgentBehaviorConfigSchema.parse(config.behavior ?? {});
  const minConfidence = effectiveBehavior.confidenceThreshold / 100;

  // Determine upfront whether we intend to execute a trade for this decision.
  // (We still log the LLM decision either way, but we want the UI to clearly show
  // why a BUY/SELL did not result in a trade.)
  const wantsTrade = decision.action === 'buy' || decision.action === 'sell';
  const hasCapacity = engine.openPositions.length < config.maxOpenPositions;
  const meetsConfidence = decision.confidence >= minConfidence;

  let executionNote: string | null = null;
  if (wantsTrade && !meetsConfidence) {
    executionNote = `Execution: skipped (confidence ${(decision.confidence * 100).toFixed(0)}% < threshold ${(minConfidence * 100).toFixed(0)}%).`;
  } else if (wantsTrade && !hasCapacity) {
    executionNote = `Execution: skipped (already at max open positions: ${engine.openPositions.length}/${config.maxOpenPositions}).`;
  }

  // 7. Log the decision
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
    marketDataSnapshot: JSON.stringify(marketData),
    llmPromptText: decision.llmPromptText ?? null,
    llmRawResponse: decision.llmRawResponse ?? null,
    createdAt: nowIso(),
  });

  console.log(
    `[agent-loop] ${agentId}: Decision=${decision.action} confidence=${decision.confidence.toFixed(2)}`
  );

  // 8. Execute trade if confidence is high enough
  if (
    (decision.action === 'buy' || decision.action === 'sell') &&
    decision.confidence >= minConfidence &&
    engine.openPositions.length < config.maxOpenPositions
  ) {
    const targetPairName = normalizePairForDex(decision.targetPair ?? pairsToFetch[0]);
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
      await ctx.storage.put('pendingTrade', position);

      await persistTrade(db, position);
      await ctx.storage.delete('pendingTrade');
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
        await ctx.storage.put('pendingTrade', closed);
        await persistTrade(db, closed);
        await ctx.storage.delete('pendingTrade');
        await ctx.storage.delete(`priceMiss:${position.id}`);
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
