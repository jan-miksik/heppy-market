import { COINGECKO_CHART_CACHE_TTL_SECONDS, COINGECKO_SPOT_CACHE_TTL_SECONDS } from '../../cache/ttl.js';

export const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
export const COINPAPRIKA_BASE = 'https://api.coinpaprika.com/v1';
export const CACHE_TTL_SECONDS = COINGECKO_SPOT_CACHE_TTL_SECONDS;
export const CHART_CACHE_TTL_SECONDS = COINGECKO_CHART_CACHE_TTL_SECONDS;
export const FETCH_TIMEOUT_MS = 8_000;

const STABLE_QUOTES = new Set(['USD', 'USDC', 'USDBC', 'USDT', 'DAI']);
const SYMBOL_TO_COIN_ID: Record<string, string> = {
  INIT: 'initia',
  INITIA: 'initia',
};
const SYMBOL_TO_PAPRIKA_COIN_ID: Record<string, string> = {
  INIT: 'init-initia',
  INITIA: 'init-initia',
};

export type CoinGeckoMarketChartResponse = {
  prices?: Array<[number, number]>;
  total_volumes?: Array<[number, number]>;
};

export type CoinGeckoMarketContext = {
  spotUsd: number;
  hourlyPrices: number[];
  dailyPrices: number[];
  priceChange: Record<string, number | undefined>;
  volume24h?: number;
};

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function isStableQuote(symbol: string): boolean {
  return STABLE_QUOTES.has(normalizeSymbol(symbol));
}

export function getCoinIdForSymbol(symbol: string): string | null {
  return SYMBOL_TO_COIN_ID[normalizeSymbol(symbol)] ?? null;
}

export function getCoinPaprikaIdForSymbol(symbol: string): string | null {
  return SYMBOL_TO_PAPRIKA_COIN_ID[normalizeSymbol(symbol)] ?? null;
}

/**
 * For pair-style inputs, resolve a CoinGecko coin id when one side is a stable quote.
 * Example: INIT/USD -> initia
 */
export function resolveCoinGeckoCoinIdForPair(pairName: string): string | null {
  const [leftRaw, rightRaw, ...rest] = pairName.split('/');
  if (rest.length > 0 || !leftRaw || !rightRaw) return null;
  const left = normalizeSymbol(leftRaw);
  const right = normalizeSymbol(rightRaw);

  if (isStableQuote(right)) return getCoinIdForSymbol(left);
  if (isStableQuote(left)) return getCoinIdForSymbol(right);
  return null;
}

/**
 * Resolve CoinPaprika coin id when one side is a stable quote.
 * Example: INIT/USD -> init-initia
 */
export function resolveCoinPaprikaCoinIdForPair(pairName: string): string | null {
  const [leftRaw, rightRaw, ...rest] = pairName.split('/');
  if (rest.length > 0 || !leftRaw || !rightRaw) return null;
  const left = normalizeSymbol(leftRaw);
  const right = normalizeSymbol(rightRaw);

  if (isStableQuote(right)) return getCoinPaprikaIdForSymbol(left);
  if (isStableQuote(left)) return getCoinPaprikaIdForSymbol(right);
  return null;
}

export function calcPctChange(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined || previous <= 0) return undefined;
  return ((current - previous) / previous) * 100;
}

export function sanitizeSeries(values: Array<[number, number]> | undefined, take: number): number[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((row) => (Array.isArray(row) ? Number(row[1]) : NaN))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(-take);
}

export async function fetchJsonWithTimeout<T>(
  url: string,
  mapResponse: (response: Response) => Promise<T>,
): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) return null;
    return await mapResponse(response);
  } catch {
    return null;
  }
}
