import { COINGECKO_CHART_CACHE_TTL_SECONDS, COINGECKO_SPOT_CACHE_TTL_SECONDS } from '../../cache/ttl.js';

export const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
export const COINPAPRIKA_BASE = 'https://api.coinpaprika.com/v1';
export const CACHE_TTL_SECONDS = COINGECKO_SPOT_CACHE_TTL_SECONDS;
export const CHART_CACHE_TTL_SECONDS = COINGECKO_CHART_CACHE_TTL_SECONDS;
export const FETCH_TIMEOUT_MS = 8_000;
// When two candidates are within ln(2) of the consensus median in log-space,
// treat them as equal quality and break the tie by provider priority instead.
const LOG_PRIORITY_MARGIN = Math.log(2);

export type CacheOptions = { bypassCache?: boolean };

const STABLE_QUOTES = new Set(['USD', 'USDC', 'USDBC', 'USDT', 'DAI']);
const SYMBOL_TO_COIN_ID: Record<string, string> = {
  INIT: 'initia',
  INITIA: 'initia',
};
const SYMBOL_TO_PAPRIKA_COIN_ID: Record<string, string> = {
  INIT: 'init-initia',
  INITIA: 'init-initia',
};

export type StableQuotedPair = {
  baseSymbol: string;
  quoteSymbol: string;
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

export function parseStableQuotedPair(pairName: string): StableQuotedPair | null {
  const [leftRaw, rightRaw, ...rest] = pairName.split('/');
  if (rest.length > 0 || !leftRaw || !rightRaw) return null;

  const left = normalizeSymbol(leftRaw);
  const right = normalizeSymbol(rightRaw);

  if (isStableQuote(right)) return { baseSymbol: left, quoteSymbol: right };
  if (isStableQuote(left)) return { baseSymbol: right, quoteSymbol: left };
  return null;
}

/**
 * For pair-style inputs, resolve a CoinGecko coin id when one side is a stable quote.
 * Example: INIT/USD -> initia
 */
export function resolveCoinGeckoCoinIdForPair(pairName: string): string | null {
  const pair = parseStableQuotedPair(pairName);
  return pair ? getCoinIdForSymbol(pair.baseSymbol) : null;
}

/**
 * Resolve CoinPaprika coin id when one side is a stable quote.
 * Example: INIT/USD -> init-initia
 */
export function resolveCoinPaprikaCoinIdForPair(pairName: string): string | null {
  const pair = parseStableQuotedPair(pairName);
  return pair ? getCoinPaprikaIdForSymbol(pair.baseSymbol) : null;
}

/**
 * Returns true for pairs that have a direct indexed spot provider mapping
 * and therefore should not fall back to arbitrary DEX pool discovery.
 */
export function hasIndexedSpotPriceProvider(pairName: string): boolean {
  return resolveCoinGeckoCoinIdForPair(pairName) !== null
    || resolveCoinPaprikaCoinIdForPair(pairName) !== null;
}

export function calcPctChange(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined || previous <= 0) return undefined;
  return ((current - previous) / previous) * 100;
}

function toPositivePrice(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function lastPositivePrice(values: number[] | undefined): number | null {
  if (!Array.isArray(values)) return null;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = toPositivePrice(values[i]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Pick the most credible USD spot price when providers disagree.
 *
 * Uses log-space median consensus: a single provider returning a wrong-decimal
 * value (e.g. 0.000002 instead of 0.08) lands far from the cluster formed by
 * the other sources and loses — no hard ratio threshold needed.
 *
 * All available values (live spots, chart candles, demo fallback) are ranked by
 * their distance from the log-space median. When two sources are within ln(2)
 * of each other in that distance (i.e. within 2× quality), provider priority
 * breaks the tie so that fresh live data beats stale chart candles.
 */
export function selectSaneSpotPriceUsd(params: {
  preferredSpotUsd?: number | null;
  secondarySpotUsd?: number | null;
  hourlyPrices?: number[];
  dailyPrices?: number[];
  demoSpotUsd?: number | null;
}): number {
  const preferred = toPositivePrice(params.preferredSpotUsd);
  const secondary = toPositivePrice(params.secondarySpotUsd);
  const latestHourly = lastPositivePrice(params.hourlyPrices);
  const latestDaily = lastPositivePrice(params.dailyPrices);
  const demoSpot = toPositivePrice(params.demoSpotUsd);

  // If both live spots agree with each other, trust them directly.
  // Two independent live sources that are within 2× of each other beat any
  // number of potentially stale chart candles — no threshold required.
  if (preferred !== null && secondary !== null) {
    if (Math.abs(Math.log(preferred) - Math.log(secondary)) <= LOG_PRIORITY_MARGIN) {
      return preferred;
    }
  }

  // One or both live spots are absent or strongly disagree with each other.
  // Use log-space median across all sources: a decimal-scale encoding error
  // (e.g. 0.000002 among three ~0.08 values) lands nowhere near the median
  // and loses — no hard ratio threshold needed.
  const candidates = [
    { value: preferred, priority: 4 },
    { value: secondary, priority: 3 },
    { value: latestHourly, priority: 2 },
    { value: latestDaily, priority: 1 },
    { value: demoSpot, priority: 0 },
  ].filter((c): c is { value: number; priority: number } => c.value !== null);

  if (candidates.length === 0) return 0;
  if (candidates.length === 1) return candidates[0].value;

  const logValues = candidates.map((c) => Math.log(c.value)).sort((a, b) => a - b);
  const mid = Math.floor(logValues.length / 2);
  const logMedian = logValues.length % 2 === 0
    ? (logValues[mid - 1] + logValues[mid]) / 2
    : logValues[mid];

  return candidates
    .map((c) => ({ ...c, logDist: Math.abs(Math.log(c.value) - logMedian) }))
    .sort((a, b) => {
      const distDiff = a.logDist - b.logDist;
      // If one source is clearly closer to consensus (>2× better), use distance.
      if (Math.abs(distDiff) > LOG_PRIORITY_MARGIN) return distDiff;
      // Within the same quality band, prefer the higher-priority (fresher) source.
      return b.priority - a.priority;
    })[0].value;
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
  let host = url;
  try { host = new URL(url).hostname; } catch { /* keep full url */ }
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

    if (!response.ok) {
      console.warn(`[price-fetch] HTTP ${response.status} from ${host}`);
      return null;
    }
    return await mapResponse(response);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn(`[price-fetch] timeout fetching ${host}`);
    }
    return null;
  }
}
