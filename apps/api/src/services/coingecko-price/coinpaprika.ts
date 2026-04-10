import type { Env } from '../../types/env.js';
import {
  CACHE_TTL_SECONDS,
  CHART_CACHE_TTL_SECONDS,
  COINPAPRIKA_BASE,
  calcPctChange,
  fetchJsonWithTimeout,
  resolveCoinPaprikaCoinIdForPair,
  type CoinGeckoMarketContext,
} from './shared.js';

async function fetchCoinPaprikaTicker(env: Env, coinId: string): Promise<Record<string, unknown> | null> {
  const cacheKey = `coinpaprika:ticker:${coinId}`;
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (cached && typeof cached === 'object') return cached as Record<string, unknown>;
  } catch {
    // non-fatal
  }

  const json = await fetchJsonWithTimeout(
    `${COINPAPRIKA_BASE}/tickers/${encodeURIComponent(coinId)}`,
    async (response) => response.json() as Promise<Record<string, unknown>>,
  );
  if (!json) return null;

  try {
    await env.CACHE.put(cacheKey, JSON.stringify(json), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    // non-fatal
  }
  return json;
}

function toIsoStart(nowMs: number, durationMs: number): string {
  return new Date(nowMs - durationMs).toISOString();
}

async function fetchCoinPaprikaPriceSeries(
  env: Env,
  coinId: string,
  interval: '1h' | '24h',
  points: number,
): Promise<number[]> {
  const effectivePoints = interval === '1h' ? Math.min(points, 24) : points;
  const cacheKey = `coinpaprika:historical:${coinId}:${interval}:${effectivePoints}`;
  try {
    const cached = await env.CACHE.get(cacheKey, 'json');
    if (Array.isArray(cached)) {
      return cached.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
    }
  } catch {
    // non-fatal
  }

  const now = Date.now();
  const stepMs = interval === '1h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const start = toIsoStart(now, stepMs * Math.max(effectivePoints - 1, 1));
  const url =
    `${COINPAPRIKA_BASE}/tickers/${encodeURIComponent(coinId)}/historical` +
    `?start=${encodeURIComponent(start)}&interval=${interval}&quote=usd`;

  const rows = await fetchJsonWithTimeout(
    url,
    async (response) => response.json() as Promise<Array<Record<string, unknown>>>,
  );
  if (!Array.isArray(rows)) return [];

  const series = rows
    .map((row) => Number(row.price))
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(-effectivePoints);
  if (series.length > 0) {
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(series), { expirationTtl: CHART_CACHE_TTL_SECONDS });
    } catch {
      // non-fatal
    }
  }
  return series;
}

function getCoinPaprikaUsdQuote(ticker: Record<string, unknown> | null): Record<string, unknown> | null {
  const quotesRaw = ticker?.quotes;
  if (!quotesRaw || typeof quotesRaw !== 'object') return null;
  const usdRaw = (quotesRaw as Record<string, unknown>).USD;
  if (!usdRaw || typeof usdRaw !== 'object') return null;
  return usdRaw as Record<string, unknown>;
}

export async function resolveCoinPaprikaSpotUsdForPair(env: Env, pairName: string): Promise<number> {
  const coinId = resolveCoinPaprikaCoinIdForPair(pairName);
  if (!coinId) return 0;
  const ticker = await fetchCoinPaprikaTicker(env, coinId);
  const quote = getCoinPaprikaUsdQuote(ticker);
  const spot = Number(quote?.price);
  return Number.isFinite(spot) && spot > 0 ? spot : 0;
}

export async function resolveCoinPaprikaMarketContextForPair(
  env: Env,
  pairName: string,
): Promise<CoinGeckoMarketContext | null> {
  const coinId = resolveCoinPaprikaCoinIdForPair(pairName);
  if (!coinId) return null;

  const [ticker, hourlyPrices, dailyPrices] = await Promise.all([
    fetchCoinPaprikaTicker(env, coinId),
    fetchCoinPaprikaPriceSeries(env, coinId, '1h', 48),
    fetchCoinPaprikaPriceSeries(env, coinId, '24h', 30),
  ]);

  const quote = getCoinPaprikaUsdQuote(ticker);
  const spotUsd = Number(quote?.price);
  const safeSpot = Number.isFinite(spotUsd) && spotUsd > 0 ? spotUsd : 0;
  const current = hourlyPrices.at(-1) ?? dailyPrices.at(-1) ?? (safeSpot > 0 ? safeSpot : undefined);
  const oneHourAgo = hourlyPrices.length >= 2 ? hourlyPrices.at(-2) : undefined;
  const sixHoursAgo = hourlyPrices.length >= 7 ? hourlyPrices.at(-7) : undefined;
  const twentyFourHoursAgo = hourlyPrices.length >= 25
    ? hourlyPrices.at(-25)
    : dailyPrices.length >= 2
    ? dailyPrices.at(-2)
    : undefined;

  const pct1h = Number(quote?.percent_change_1h);
  const pct24h = Number(quote?.percent_change_24h);
  const volume24hRaw = Number(quote?.volume_24h);
  const volume24h = Number.isFinite(volume24hRaw) && volume24hRaw > 0 ? volume24hRaw : undefined;

  if (safeSpot <= 0 && hourlyPrices.length === 0 && dailyPrices.length === 0) return null;

  return {
    spotUsd: safeSpot,
    hourlyPrices,
    dailyPrices,
    priceChange: {
      m5: undefined,
      h1: Number.isFinite(pct1h) ? pct1h : calcPctChange(current, oneHourAgo),
      h6: calcPctChange(current, sixHoursAgo),
      h24: Number.isFinite(pct24h) ? pct24h : calcPctChange(current, twentyFourHoursAgo),
    },
    volume24h,
  };
}
