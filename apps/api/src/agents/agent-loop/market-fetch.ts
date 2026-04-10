import type { Env } from '../../types/env.js';
import { createDexDataService, getPriceUsd } from '../../services/dex-data.js';
import type { DexPair } from '../../services/dex-data.js';
import { createGeckoTerminalService } from '../../services/gecko-terminal.js';
import {
  resolveCoinGeckoSpotUsdForPair,
  resolveCoinGeckoMarketContextForPair,
  resolveCoinPaprikaSpotUsdForPair,
  resolveCoinPaprikaMarketContextForPair,
  resolveDemoFallbackSpotUsdForPair,
  resolveDemoMarketContextForPair,
} from '../../services/coingecko-price.js';
import { combineSignals, computeIndicators, evaluateSignals } from '../../services/indicators.js';
import { classifyApiError, logStructuredError } from '../../lib/agent-errors.js';
import { createLogger } from '../../lib/logger.js';
import type { MarketDataItem } from './types.js';

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

/** Build a search query from pair name (`WETH/USDC` -> `WETH USDC`) */
function pairToSearchQuery(pairName: string): string {
  return pairName.replace('/', ' ');
}

/** Returns true when pool/pair name contains all symbols from the configured pair. */
function poolMatchesPair(poolName: string, pairName: string): boolean {
  const tokens = pairName.split('/').map((token) => token.trim().toUpperCase());
  const name = poolName.toUpperCase();
  return tokens.every((token) => name.includes(token));
}

/** Build a human-readable indicator summary string from computed indicator set. */
function buildIndicatorText(
  indicators: ReturnType<typeof computeIndicators> | null,
  currentPrice: number,
  noDataMsg: string,
  includeSignalVerdict: boolean,
): string {
  if (!indicators) return noDataMsg;
  const lastRsi = indicators.rsi?.at(-1);
  const lastEma9 = indicators.ema9?.at(-1);
  const lastEma21 = indicators.ema21?.at(-1);
  const lastMacd = indicators.macd?.at(-1);
  const lastBb = indicators.bollingerBands?.at(-1);
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
    const signals = evaluateSignals(indicators, currentPrice);
    const combined = combineSignals(signals);
    parts.push(
      `Signal verdict: ${combined.signal.toUpperCase()} (${(combined.confidence * 100).toFixed(0)}% conf) - ${combined.reason}`,
    );
  }

  return parts.length > 0 ? parts.join('\n') : noDataMsg;
}

export async function fetchOnePair(params: {
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

  function mergeMissingPriceChange(source: Record<string, number | undefined>) {
    for (const key of ['m5', 'h1', 'h6', 'h24'] as const) {
      if (priceChange[key] === undefined && source[key] !== undefined) {
        priceChange[key] = source[key];
      }
    }
  }

  try {
    console.log(`[agent-loop] ${agentId}: GeckoTerminal search "${query}"`);
    const pools = await geckoSvc.searchPools(query);
    const pool = pools.find((entry) => poolMatchesPair(entry.name, pairName));
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
        logStructuredError('agent-loop', agentId, classifyApiError(hourlyResult.reason, { pair: pairName, source: 'gecko-ohlcv-hourly' }));
      }
      if (dailyResult.status === 'fulfilled') {
        dailyPrices = dailyResult.value;
        console.log(`[agent-loop] ${agentId}: Got ${dailyPrices.length} daily candles`);
      } else {
        logStructuredError('agent-loop', agentId, classifyApiError(dailyResult.reason, { pair: pairName, source: 'gecko-ohlcv-daily' }));
      }
    }
  } catch (geckoErr) {
    logStructuredError('agent-loop', agentId, classifyApiError(geckoErr, { pair: pairName, source: 'gecko-terminal' }));
  }

  if (priceUsd === 0) {
    try {
      console.log(`[agent-loop] ${agentId}: DexScreener fallback for "${query}"`);
      const results = await dexSvc.searchPairs(query);
      const basePair = results
        .filter((entry) => entry.chainId === 'base')
        .filter((entry) => poolMatchesPair(`${entry.baseToken.symbol}/${entry.quoteToken.symbol}`, pairName))
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
      logStructuredError('agent-loop', agentId, classifyApiError(dexErr, { pair: pairName, source: 'dexscreener' }));
    }
  }

  if (priceUsd === 0) {
    const [baseToken] = pairName.split('/').map((token) => token.trim().toUpperCase());
    const baseAddr = BASE_TOKEN_ADDRESSES[baseToken];
    if (baseAddr) {
      try {
        console.log(`[agent-loop] ${agentId}: Token address fallback for ${baseToken} (${baseAddr})`);
        const results = await dexSvc.getTokenPairs(baseAddr);
        const basePair = results
          .filter((entry) => entry.chainId === 'base')
          .filter((entry) => poolMatchesPair(`${entry.baseToken.symbol}/${entry.quoteToken.symbol}`, pairName))
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
        logStructuredError('agent-loop', agentId, classifyApiError(tokenErr, { pair: pairName, source: 'token-address-fallback' }));
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
    try {
      const coinpaprikaSpot = await resolveCoinPaprikaSpotUsdForPair(env, pairName);
      if (coinpaprikaSpot > 0) {
        priceUsd = coinpaprikaSpot;
        console.log(`[agent-loop] ${agentId}: CoinPaprika spot fallback found @ $${priceUsd}`);
      }
    } catch {
      // non-fatal
    }
  }

  if (prices.length === 0 || dailyPrices.length === 0 || priceChange.h1 === undefined || priceChange.h24 === undefined) {
    try {
      const coingeckoCtx = await resolveCoinGeckoMarketContextForPair(env, pairName);
      if (coingeckoCtx) {
        if (priceUsd === 0 && coingeckoCtx.spotUsd > 0) priceUsd = coingeckoCtx.spotUsd;
        if (prices.length === 0 && coingeckoCtx.hourlyPrices.length > 0) prices = coingeckoCtx.hourlyPrices;
        if (dailyPrices.length === 0 && coingeckoCtx.dailyPrices.length > 0) dailyPrices = coingeckoCtx.dailyPrices;
        if (volume24h === undefined && coingeckoCtx.volume24h !== undefined) volume24h = coingeckoCtx.volume24h;
        mergeMissingPriceChange(coingeckoCtx.priceChange);
      }
    } catch {
      // non-fatal
    }
  }

  if (prices.length === 0 || dailyPrices.length === 0 || priceChange.h1 === undefined || priceChange.h24 === undefined) {
    try {
      const coinpaprikaCtx = await resolveCoinPaprikaMarketContextForPair(env, pairName);
      if (coinpaprikaCtx) {
        if (priceUsd === 0 && coinpaprikaCtx.spotUsd > 0) priceUsd = coinpaprikaCtx.spotUsd;
        if (prices.length === 0 && coinpaprikaCtx.hourlyPrices.length > 0) prices = coinpaprikaCtx.hourlyPrices;
        if (dailyPrices.length === 0 && coinpaprikaCtx.dailyPrices.length > 0) dailyPrices = coinpaprikaCtx.dailyPrices;
        if (volume24h === undefined && coinpaprikaCtx.volume24h !== undefined) volume24h = coinpaprikaCtx.volume24h;
        mergeMissingPriceChange(coinpaprikaCtx.priceChange);
      }
    } catch {
      // non-fatal
    }
  }

  if (priceUsd === 0) {
    const demoSpot = resolveDemoFallbackSpotUsdForPair(pairName);
    if (demoSpot > 0) {
      priceUsd = demoSpot;
      console.warn(`[agent-loop] ${agentId}: Using demo fallback spot for ${pairName} @ $${priceUsd}`);
    }
  }

  if (prices.length === 0 || dailyPrices.length === 0 || priceChange.h1 === undefined || priceChange.h24 === undefined) {
    const demoCtx = resolveDemoMarketContextForPair(pairName);
    if (demoCtx) {
      if (priceUsd === 0) priceUsd = demoCtx.spotUsd;
      if (prices.length === 0) prices = demoCtx.hourlyPrices;
      if (dailyPrices.length === 0) dailyPrices = demoCtx.dailyPrices;
      mergeMissingPriceChange(demoCtx.priceChange);
    }
  }

  if (priceUsd === 0) {
    log.warn('price_resolution_failed', { pair: pairName });
    return null;
  }

  const doneIndicators = log.time('indicator_compute', { pair: pairName, candles: prices.length });
  const indicators = prices.length >= 14 ? computeIndicators(prices) : null;
  doneIndicators();

  const indicatorText = buildIndicatorText(indicators, priceUsd, 'No OHLCV data available - indicators skipped', true);
  const dailyIndicators = dailyPrices.length >= 14 ? computeIndicators(dailyPrices) : null;
  const dailyIndicatorText = buildIndicatorText(dailyIndicators, priceUsd, 'No daily OHLCV data - daily trend skipped', false);

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
