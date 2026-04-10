import type { Env } from '../../types/env.js';
import {
  CACHE_TTL_SECONDS,
  CHART_CACHE_TTL_SECONDS,
  COINGECKO_BASE,
  calcPctChange,
  fetchJsonWithTimeout,
  resolveCoinGeckoCoinIdForPair,
  sanitizeSeries,
  type CoinGeckoMarketChartResponse,
  type CoinGeckoMarketContext,
} from './shared.js';

/** Fetch spot USD price for a CoinGecko coin id. Returns 0 on failure. */
export async function fetchCoinGeckoSpotUsd(env: Env, coinId: string): Promise<number> {
  const cacheKey = `coingecko:spot:${coinId}:usd`;
  try {
    const cached = await env.CACHE.get(cacheKey, 'text');
    if (cached) {
      const parsed = Number.parseFloat(cached);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // non-fatal
  }

  const json = await fetchJsonWithTimeout(
    `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`,
    async (response) => response.json() as Promise<Record<string, { usd?: unknown }>>,
  );
  const usdRaw = json?.[coinId]?.usd;
  const usd = typeof usdRaw === 'number' ? usdRaw : Number(usdRaw);
  if (!Number.isFinite(usd) || usd <= 0) return 0;

  try {
    await env.CACHE.put(cacheKey, String(usd), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    // non-fatal
  }
  return usd;
}

async function fetchCoinGeckoMarketChart(
  env: Env,
  coinId: string,
  days: 2 | 30,
  interval: 'hourly' | 'daily',
): Promise<CoinGeckoMarketChartResponse | null> {
  const cacheKey = `coingecko:chart:${coinId}:usd:${days}d:${interval}`;
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached && typeof cached === 'object') return cached as CoinGeckoMarketChartResponse;
  } catch {
    // non-fatal
  }

  let json = await fetchJsonWithTimeout(
    `${COINGECKO_BASE}/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}&interval=${interval}`,
    async (response) => response.json() as Promise<CoinGeckoMarketChartResponse>,
  );
  if (!json) return null;

  if ((json.prices?.length ?? 0) === 0) {
    const fallbackJson = await fetchJsonWithTimeout(
      `${COINGECKO_BASE}/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}`,
      async (response) => response.json() as Promise<CoinGeckoMarketChartResponse>,
    );
    if ((fallbackJson?.prices?.length ?? 0) > 0) {
      json = fallbackJson;
    }
  }

  try {
    await env.CACHE.put(cacheKey, JSON.stringify(json), { expirationTtl: CHART_CACHE_TTL_SECONDS });
  } catch {
    // non-fatal
  }
  return json;
}

export async function resolveCoinGeckoSpotUsdForPair(env: Env, pairName: string): Promise<number> {
  const coinId = resolveCoinGeckoCoinIdForPair(pairName);
  if (!coinId) return 0;
  return fetchCoinGeckoSpotUsd(env, coinId);
}

export async function resolveCoinGeckoMarketContextForPair(
  env: Env,
  pairName: string,
): Promise<CoinGeckoMarketContext | null> {
  const coinId = resolveCoinGeckoCoinIdForPair(pairName);
  if (!coinId) return null;

  const [spotUsd, hourlyChart, dailyChart] = await Promise.all([
    fetchCoinGeckoSpotUsd(env, coinId),
    fetchCoinGeckoMarketChart(env, coinId, 2, 'hourly'),
    fetchCoinGeckoMarketChart(env, coinId, 30, 'daily'),
  ]);

  const hourlyPrices = sanitizeSeries(hourlyChart?.prices, 48);
  const dailyPrices = sanitizeSeries(dailyChart?.prices, 30);
  const current = hourlyPrices.at(-1) ?? dailyPrices.at(-1) ?? (spotUsd > 0 ? spotUsd : undefined);
  const oneHourAgo = hourlyPrices.length >= 2 ? hourlyPrices.at(-2) : undefined;
  const sixHoursAgo = hourlyPrices.length >= 7 ? hourlyPrices.at(-7) : undefined;
  const twentyFourHoursAgo = hourlyPrices.length >= 25
    ? hourlyPrices.at(-25)
    : dailyPrices.length >= 2
    ? dailyPrices.at(-2)
    : undefined;
  const volume24hRaw = hourlyChart?.total_volumes?.at(-1)?.[1] ?? dailyChart?.total_volumes?.at(-1)?.[1];
  const volume24h = typeof volume24hRaw === 'number' && Number.isFinite(volume24hRaw) && volume24hRaw > 0
    ? volume24hRaw
    : undefined;

  return {
    spotUsd,
    hourlyPrices,
    dailyPrices,
    priceChange: {
      m5: undefined,
      h1: calcPctChange(current, oneHourAgo),
      h6: calcPctChange(current, sixHoursAgo),
      h24: calcPctChange(current, twentyFourHoursAgo),
    },
    volume24h,
  };
}
