import { drizzle } from 'drizzle-orm/d1';
import { desc, eq } from 'drizzle-orm';
import type { Env } from '../../types/env.js';
import { agentDecisions } from '../../db/schema.js';
import { createDexDataService, getPriceUsd } from '../../services/dex-data.js';
import type { DexPair } from '../../services/dex-data.js';
import { createGeckoTerminalService } from '../../services/gecko-terminal.js';
import { resolveCoinGeckoSpotUsdForPair } from '../../services/coingecko-price.js';
import { combineSignals, computeIndicators, evaluateSignals } from '../../services/indicators.js';
import { classifyApiError, logStructuredError } from '../../lib/agent-errors.js';
import { createLogger } from '../../lib/logger.js';
import type { MarketDataItem, RecentDecision } from './types.js';

/** Build a search query from pair name (`WETH/USDC` -> `WETH USDC`) */
function pairToSearchQuery(pairName: string): string {
  return pairName.replace('/', ' ');
}

/** Well-known Base chain token addresses for reliable pair lookups fallback. */
const BASE_TOKEN_ADDRESSES: Record<string, string> = {
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
  cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  AERO: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  DEGEN: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
  BRETT: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
  TOSHI: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
};

/** Returns true when pool/pair name contains all symbols from the configured pair. */
function poolMatchesPair(poolName: string, pairName: string): boolean {
  const tokens = pairName.split('/').map((t) => t.trim().toUpperCase());
  const name = poolName.toUpperCase();
  return tokens.every((t) => name.includes(t));
}

/** Build a human-readable indicator summary string from computed indicator set. */
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
    parts.push(
      `Signal verdict: ${combined.signal.toUpperCase()} (${(combined.confidence * 100).toFixed(0)}% conf) — ${combined.reason}`,
    );
  }
  return parts.length > 0 ? parts.join('\n') : noDataMsg;
}

async function fetchOnePair(params: {
  env: Env;
  pairName: string;
  agentId: string;
  geckoSvc: ReturnType<typeof createGeckoTerminalService>;
  dexSvc: ReturnType<typeof createDexDataService>;
  log: ReturnType<typeof createLogger>;
}): Promise<MarketDataItem | null> {
  const { env, pairName, agentId, geckoSvc, dexSvc, log } = params;
  const query = pairToSearchQuery(pairName);
  let priceUsd = 0;
  let pairAddress = '';
  let priceChange: Record<string, number | undefined> = {};
  let volume24h: number | undefined;
  let liquidity: number | undefined;
  let prices: number[] = [];
  let dailyPrices: number[] = [];

  try {
    console.log(`[agent-loop] ${agentId}: GeckoTerminal search "${query}"`);
    const pools = await geckoSvc.searchPools(query);
    const pool = pools.find((p) => poolMatchesPair(p.name, pairName));
    if (pool && pool.priceUsd > 0) {
      priceUsd = pool.priceUsd;
      pairAddress = pool.address;
      priceChange = pool.priceChange;
      volume24h = pool.volume24h;
      liquidity = pool.liquidityUsd;
      console.log(
        `[agent-loop] ${agentId}: GeckoTerminal found ${pool.name} @ $${priceUsd} liq=$${(liquidity ?? 0).toLocaleString()}`,
      );

      const [hourlyResult, dailyResult] = await Promise.allSettled([
        geckoSvc.getPoolPriceSeries(pool.address, 48, 'hour'),
        geckoSvc.getPoolPriceSeries(pool.address, 30, 'day'),
      ]);
      if (hourlyResult.status === 'fulfilled') {
        prices = hourlyResult.value;
        console.log(`[agent-loop] ${agentId}: Got ${prices.length} hourly candles`);
      } else {
        const classified = classifyApiError(hourlyResult.reason, { pair: pairName, source: 'gecko-ohlcv-hourly' });
        logStructuredError('agent-loop', agentId, classified);
      }
      if (dailyResult.status === 'fulfilled') {
        dailyPrices = dailyResult.value;
        console.log(`[agent-loop] ${agentId}: Got ${dailyPrices.length} daily candles`);
      } else {
        const classified = classifyApiError(dailyResult.reason, { pair: pairName, source: 'gecko-ohlcv-daily' });
        logStructuredError('agent-loop', agentId, classified);
      }
    }
  } catch (geckoErr) {
    const classified = classifyApiError(geckoErr, { pair: pairName, source: 'gecko-terminal' });
    logStructuredError('agent-loop', agentId, classified);
  }

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
      const classified = classifyApiError(dexErr, { pair: pairName, source: 'dexscreener' });
      logStructuredError('agent-loop', agentId, classified);
    }
  }

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
        const classified = classifyApiError(tokenErr, { pair: pairName, source: 'token-address-fallback' });
        logStructuredError('agent-loop', agentId, classified);
      }
    }
  }

  if (priceUsd === 0) {
    try {
      const coingeckoSpot = await resolveCoinGeckoSpotUsdForPair(env, pairName);
      if (coingeckoSpot > 0) {
        priceUsd = coingeckoSpot;
        console.log(`[agent-loop] ${agentId}: CoinGecko spot fallback found @ $${priceUsd}`);
      }
    } catch {
      // non-fatal
    }
  }

  if (priceUsd === 0) {
    log.warn('price_resolution_failed', { pair: pairName });
    return null;
  }

  const doneIndicators = log.time('indicator_compute', { pair: pairName, candles: prices.length });
  const indicators = prices.length >= 14 ? computeIndicators(prices) : null;
  doneIndicators();

  const indicatorText = buildIndicatorText(indicators, priceUsd, 'No OHLCV data available — indicators skipped', true);

  const dailyIndicators = dailyPrices.length >= 14 ? computeIndicators(dailyPrices) : null;
  const dailyIndicatorText = buildIndicatorText(dailyIndicators, priceUsd, 'No daily OHLCV data — daily trend skipped', false);

  return {
    pair: pairName,
    pairAddress,
    dexScreenerUrl: pairAddress ? `https://dexscreener.com/base/${pairAddress}` : '',
    priceUsd,
    priceChange,
    volume24h,
    liquidity,
    indicatorText,
    dailyIndicatorText,
  };
}

export async function fetchAgentMarketContext(params: {
  agentId: string;
  env: Env;
  ctx: DurableObjectState;
  db: ReturnType<typeof drizzle>;
  pairsToFetch: string[];
  log: ReturnType<typeof createLogger>;
  bypassCache?: boolean;
}): Promise<{ marketData: MarketDataItem[]; recentDecisions: RecentDecision[] }> {
  const { agentId, env, ctx, db, pairsToFetch, log, bypassCache = false } = params;
  const geckoSvc = createGeckoTerminalService(env.CACHE, { bypassCache });
  const dexSvc = createDexDataService(env.CACHE, { bypassCache });

  const cachedRecentDecisions = await ctx.storage.get<RecentDecision[]>('recentDecisions');

  let pairResults: PromiseSettledResult<PromiseSettledResult<Awaited<ReturnType<typeof fetchOnePair>>>[]>;
  let recentDecisions: RecentDecision[];

  if (cachedRecentDecisions !== undefined) {
    recentDecisions = cachedRecentDecisions;
    pairResults = await Promise.allSettled(
      pairsToFetch.map((pairName) => fetchOnePair({ env, pairName, agentId, geckoSvc, dexSvc, log })),
    )
      .then((r) => ({ status: 'fulfilled' as const, value: r }))
      .catch((e) => ({ status: 'rejected' as const, reason: e }));
  } else {
    log.info('recent_decisions_cache_miss', { agentId });
    const [pairResultsRaw, dbDecisions] = await Promise.allSettled([
      Promise.allSettled(pairsToFetch.map((pairName) => fetchOnePair({ env, pairName, agentId, geckoSvc, dexSvc, log }))),
      db
        .select({
          decision: agentDecisions.decision,
          confidence: agentDecisions.confidence,
          createdAt: agentDecisions.createdAt,
        })
        .from(agentDecisions)
        .where(eq(agentDecisions.agentId, agentId))
        .orderBy(desc(agentDecisions.createdAt))
        .limit(10),
    ]);
    pairResults = pairResultsRaw;
    recentDecisions = dbDecisions.status === 'fulfilled' ? dbDecisions.value : [];
    if (dbDecisions.status === 'fulfilled') {
      try {
        await ctx.storage.put('recentDecisions', dbDecisions.value);
      } catch {
        // non-fatal
      }
    }
  }

  const marketData =
    pairResults.status === 'fulfilled'
      ? pairResults.value
          .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchOnePair>>> => r.status === 'fulfilled')
          .map((r) => r.value)
          .filter((v): v is NonNullable<typeof v> => v !== null)
      : [];

  return { marketData, recentDecisions };
}
