import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types/env.js';
import {
  createDexDataService,
  filterBaseChainPairs,
} from '../services/dex-data.js';
import { createGeckoTerminalService } from '../services/gecko-terminal.js';
import {
  resolveCoinGeckoMarketContextForPair,
  resolveCoinPaprikaMarketContextForPair,
  resolveDemoMarketContextForPair,
} from '../services/coingecko-price.js';
import { resolveCurrentPriceUsd } from '../services/price-resolver.js';
import { validateQuery } from '../lib/validation.js';
import { ValidationError } from '../lib/validation.js';
import { normalizePairForDex } from '../lib/pairs.js';
import { badRequestJson, internalServerErrorJson, notFoundJson, upstreamFailureJson } from './_shared/json-response.js';

const pairs = new Hono<{ Bindings: Env }>();
type OhlcvSource = 'coingecko' | 'coinpaprika' | 'geckoterminal' | 'demo' | 'none';

function buildPricesResponse(
  normalizedByInput: Record<string, string>,
  pricesByNormalized: Record<string, number>,
) {
  const prices: Record<string, number> = { ...pricesByNormalized };
  for (const [input, normalized] of Object.entries(normalizedByInput)) {
    prices[input] = pricesByNormalized[normalized] ?? 0;
  }
  return { prices, normalizedByInput };
}

/**
 * GET /api/pairs/gecko-search?q=WETH+USDC
 * Diagnostic: test GeckoTerminal directly and show raw results.
 */
pairs.get('/gecko-search', async (c) => {
  const q = c.req.query('q');
  if (!q) return badRequestJson(c, 'q param required');
  const svc = createGeckoTerminalService(c.env.CACHE);
  try {
    const pools = await svc.searchPools(q);
    return c.json({ query: q, count: pools.length, pools });
  } catch (err) {
    return upstreamFailureJson(c, String(err));
  }
});

/** GET /api/pairs/search?q=WETH+USDC */
pairs.get('/search', async (c) => {
  const query = validateQuery(c, z.object({ q: z.string().min(1) }));
  const svc = createDexDataService(c.env.CACHE);
  const results = await svc.searchPairs(query.q);
  const basePairs = filterBaseChainPairs(results);

  return c.json({
    query: query.q,
    count: basePairs.length,
    pairs: basePairs,
  });
});

/** GET /api/pairs/top?chain=base — top pairs by 24h volume, cached 5min */
pairs.get('/top', async (c) => {
  const query = validateQuery(
    c,
    z.object({ chain: z.enum(['base']).default('base') })
  );
  const svc = createDexDataService(c.env.CACHE);
  const topPairs = await svc.getTopPairsForChain(query.chain);
  return c.json({
    pairs: topPairs,
    updatedAt: new Date().toISOString(),
  });
});

/**
 * POST /api/pairs/prices
 * Body: { pairs: string[] }
 * Returns:
 * - prices: Record<string, number> keyed by both normalized and input pair labels
 * - normalizedByInput: Record<input, normalized>
 */
pairs.post('/prices', async (c) => {
  const body = await c.req.json().catch(() => null) as unknown;
  const parsed = z.object({ pairs: z.array(z.string().min(1)).min(1).max(50) }).safeParse(body);
  if (!parsed.success) {
    return badRequestJson(c, 'pairs must be a non-empty string[] (max 50)');
  }

  const normalizedByInput: Record<string, string> = {};
  for (const input of parsed.data.pairs) {
    normalizedByInput[input] = normalizePairForDex(input);
  }

  const uniqueNormalized = Array.from(new Set(Object.values(normalizedByInput).filter(Boolean)));

  const entries = await Promise.all(
    uniqueNormalized.map(async (pair) => {
      try {
        const priceUsd = await resolveCurrentPriceUsd(c.env, pair);
        return [pair, priceUsd] as const;
      } catch (err) {
        console.warn('[pairs/prices] failed', pair, err);
        return [pair, 0] as const;
      }
    })
  );

  const pricesByNormalized = Object.fromEntries(entries) as Record<string, number>;
  return c.json(buildPricesResponse(normalizedByInput, pricesByNormalized));
});

/**
 * GET /api/pairs/ohlcv?pair=INIT/USD&timeframe=1h
 * Pair-name based fallback OHLCV for pairs without on-chain pairAddress.
 */
pairs.get('/ohlcv', async (c) => {
  const query = validateQuery(
    c,
    z.object({
      pair: z.string().min(1),
      timeframe: z.enum(['1h', '4h', '1d']).default('1h'),
    }),
  );

  const pair = normalizePairForDex(query.pair);
  const [coingecko, coinpaprika] = await Promise.all([
    resolveCoinGeckoMarketContextForPair(c.env, pair),
    resolveCoinPaprikaMarketContextForPair(c.env, pair),
  ]);
  const demo = resolveDemoMarketContextForPair(pair);

  // Prefer real providers; use demo only when both providers miss a series.
  const hourlySource: OhlcvSource =
    (coingecko?.hourlyPrices?.length ?? 0) > 0
      ? 'coingecko'
      : (coinpaprika?.hourlyPrices?.length ?? 0) > 0
      ? 'coinpaprika'
      : (demo?.hourlyPrices?.length ?? 0) > 0
      ? 'demo'
      : 'none';
  const dailySource: OhlcvSource =
    (coingecko?.dailyPrices?.length ?? 0) > 0
      ? 'coingecko'
      : (coinpaprika?.dailyPrices?.length ?? 0) > 0
      ? 'coinpaprika'
      : (demo?.dailyPrices?.length ?? 0) > 0
      ? 'demo'
      : 'none';
  const hourlyPrices =
    (coingecko?.hourlyPrices?.length ?? 0) > 0
      ? coingecko!.hourlyPrices
      : (coinpaprika?.hourlyPrices?.length ?? 0) > 0
      ? coinpaprika!.hourlyPrices
      : (demo?.hourlyPrices ?? []);
  const dailyPrices =
    (coingecko?.dailyPrices?.length ?? 0) > 0
      ? coingecko!.dailyPrices
      : (coinpaprika?.dailyPrices?.length ?? 0) > 0
      ? coinpaprika!.dailyPrices
      : (demo?.dailyPrices ?? []);
  const source: OhlcvSource = query.timeframe === '1d' ? dailySource : hourlySource;

  if (hourlyPrices.length === 0 && dailyPrices.length === 0) {
    return c.json({ candles: [], timeframe: query.timeframe, pair, source: 'none' as OhlcvSource }, 200);
  }

  const candles = toCandlesForTimeframe(hourlyPrices, dailyPrices, query.timeframe);
  return c.json({ candles, timeframe: query.timeframe, pair, source }, 200);
});

/**
 * GET /api/pairs/:chain/:address/ohlcv?timeframe=1h&limit=48
 * Returns OHLCV candles for charting. Timeframes: 15m, 1h, 4h, 1d.
 * NOTE: Must be registered BEFORE /:chain/:address to avoid param capture.
 */
pairs.get('/:chain/:address/ohlcv', async (c) => {
  const address = c.req.param('address');
  const tf = (c.req.query('timeframe') ?? '1h') as string;

  const tfMap: Record<string, { api: 'minute' | 'hour' | 'day'; limit: number }> = {
    '15m': { api: 'minute', limit: 96 },   // ~24h of 15m candles
    '1h':  { api: 'hour',   limit: 48 },   // 48h
    '4h':  { api: 'hour',   limit: 96 },   // ~16 days (4h = every 4th hourly candle)
    '1d':  { api: 'day',    limit: 30 },   // 30 days
  };

  const config = tfMap[tf];
  if (!config) return badRequestJson(c, `Invalid timeframe: ${tf}. Use 15m, 1h, 4h, 1d`);

  const gecko = createGeckoTerminalService(c.env.CACHE);
  const candles = await gecko.getPoolOHLCV(address, config.limit, config.api);

  // For 4h: downsample hourly candles to 4h buckets
  const result = tf === '4h' ? downsample(candles, 4) : candles;

  return c.json({ candles: result, timeframe: tf, source: 'geckoterminal' as OhlcvSource });
});

/** GET /api/pairs/:chain/:address */
pairs.get('/:chain/:address', async (c) => {
  const chain = c.req.param('chain');
  const address = c.req.param('address');

  const svc = createDexDataService(c.env.CACHE);
  const results = await svc.getPairsByChain(chain, address);

  if (results.length === 0) {
    return notFoundJson(c, 'Pair');
  }

  return c.json({ pair: results[0], allResults: results });
});

/** Downsample hourly candles into N-hour buckets */
function downsample(candles: Array<{ t: number; o: number; h: number; l: number; c: number }>, hours: number) {
  const buckets: typeof candles = [];
  for (let i = 0; i < candles.length; i += hours) {
    const slice = candles.slice(i, i + hours);
    if (slice.length === 0) continue;
    buckets.push({
      t: slice[0].t,
      o: slice[0].o,
      h: Math.max(...slice.map(c => c.h)),
      l: Math.min(...slice.map(c => c.l)),
      c: slice[slice.length - 1].c,
    });
  }
  return buckets;
}

function toCandlesForTimeframe(
  hourlyPrices: number[],
  dailyPrices: number[],
  timeframe: '1h' | '4h' | '1d',
): Array<{ t: number; o: number; h: number; l: number; c: number }> {
  if (timeframe === '1d') {
    return toSyntheticCandles(dailyPrices, 24 * 60 * 60 * 1000);
  }

  const baseHourly = toSyntheticCandles(hourlyPrices, 60 * 60 * 1000);
  if (timeframe === '1h') return baseHourly;
  return downsample(baseHourly, 4);
}

function toSyntheticCandles(
  closes: number[],
  stepMs: number,
): Array<{ t: number; o: number; h: number; l: number; c: number }> {
  const clean = closes.filter((v) => Number.isFinite(v) && v > 0);
  if (clean.length === 0) return [];

  const end = Date.now();
  const start = end - stepMs * (clean.length - 1);
  return clean.map((close, i) => {
    const previousClose = i > 0 ? clean[i - 1] : close;
    const open = previousClose;
    const high = Math.max(open, close);
    const low = Math.min(open, close);
    return {
      t: start + i * stepMs,
      o: open,
      h: high,
      l: low,
      c: close,
    };
  });
}

/** GET /api/pairs/token/:address */
pairs.get('/token/:address', async (c) => {
  const address = c.req.param('address');
  const svc = createDexDataService(c.env.CACHE);
  const results = await svc.getTokenPairs(address);
  const basePairs = filterBaseChainPairs(results);

  return c.json({ count: basePairs.length, pairs: basePairs });
});

// Error handler for this router
pairs.onError((err, c) => {
  if (err instanceof ValidationError) {
    return badRequestJson(c, err.message, { fieldErrors: err.fieldErrors });
  }
  console.error('[pairs route]', err);
  return internalServerErrorJson(c, 'Failed to fetch pair data');
});

export default pairs;
