/**
 * GeckoTerminal API client (free, no API key, supports Base chain).
 * Used as primary/fallback alongside DexScreener.
 *
 * Docs: https://api.geckoterminal.com/api/v2
 * Rate limit: ~30 req/min on free tier (KV cache handles this)
 */
import { z } from 'zod';
import { geckoOhlcvKey, geckoSearchKey } from '../cache/keys.js';
import { HOT_CACHE_TTL_MS, MARKET_DATA_CACHE_TTL_SECONDS } from '../cache/ttl.js';

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const HOT_CACHE_MAX_ENTRIES = 2_000;

type HotCacheEntry = {
  value: unknown;
  expiresAt: number;
};

const hotCache = new Map<string, HotCacheEntry>();
let hotCacheLastCleanupMs = 0;

function cleanupHotCache(nowMs: number): void {
  if (nowMs - hotCacheLastCleanupMs < 10_000) return;
  hotCacheLastCleanupMs = nowMs;

  for (const [key, entry] of hotCache) {
    if (entry.expiresAt <= nowMs) hotCache.delete(key);
  }

  if (hotCache.size > HOT_CACHE_MAX_ENTRIES) {
    let toDelete = hotCache.size - HOT_CACHE_MAX_ENTRIES;
    for (const key of hotCache.keys()) {
      hotCache.delete(key);
      toDelete--;
      if (toDelete <= 0) break;
    }
  }
}

function getHotCached<T>(key: string): T | null {
  const now = Date.now();
  cleanupHotCache(now);
  const cached = hotCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    hotCache.delete(key);
    return null;
  }
  return cached.value as T;
}

function setHotCached(key: string, value: unknown): void {
  const now = Date.now();
  cleanupHotCache(now);
  hotCache.set(key, { value, expiresAt: now + HOT_CACHE_TTL_MS });
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────
// Use .nullable().optional() everywhere — GeckoTerminal returns null for missing
// values (not absent keys), and .passthrough() on objects to tolerate new fields.

const optStr = z.string().nullable().optional();

/** Parse a nullable/optional string to number, or return undefined */
function pf(v: string | null | undefined): number | undefined {
  return v != null ? parseFloat(v) : undefined;
}

const TxnBucket = z.object({ buys: z.number(), sells: z.number() }).passthrough().nullable().optional();

const GeckoPoolAttributesSchema = z.object({
  address: z.string(),
  name: z.string(),
  base_token_price_usd: optStr,
  quote_token_price_usd: optStr,
  price_change_percentage: z
    .object({ m5: optStr, m15: optStr, m30: optStr, h1: optStr, h6: optStr, h24: optStr })
    .passthrough()
    .nullable()
    .optional(),
  volume_usd: z
    .object({ m5: optStr, m15: optStr, m30: optStr, h1: optStr, h6: optStr, h24: optStr })
    .passthrough()
    .nullable()
    .optional(),
  reserve_in_usd: optStr,
  pool_created_at: optStr,
  fdv_usd: optStr,
  market_cap_usd: optStr,
  transactions: z
    .object({ m5: TxnBucket, m15: TxnBucket, m30: TxnBucket, h1: TxnBucket, h6: TxnBucket, h24: TxnBucket })
    .passthrough()
    .nullable()
    .optional(),
}).passthrough();

const GeckoPoolSchema = z.object({
  id: z.string(),
  type: z.string(), // was z.literal('pool') — some results may differ
  attributes: GeckoPoolAttributesSchema,
  relationships: z.record(z.unknown()).nullable().optional(),
}).passthrough();

const GeckoSearchResponseSchema = z.object({
  data: z.array(GeckoPoolSchema),
}).passthrough();

// OHLCV: each entry is [timestamp_ms, open, high, low, close, volume]
const GeckoOHLCVSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

// ─── Normalised type (mirrors what agent-loop expects) ────────────────────────

export interface GeckoPoolNorm {
  /** Pool address on-chain */
  address: string;
  /** Human label e.g. "WETH / USDC 0.3%" */
  name: string;
  /** DEX id e.g. "uniswap-v3-base" */
  dexId: string;
  priceUsd: number;
  priceChange: { m5?: number; h1?: number; h6?: number; h24?: number };
  volume24h?: number;
  liquidityUsd?: number;
  /** Close prices newest→oldest (for indicators) */
  recentPrices?: number[];
}

/** Candle shape returned by getPoolOHLCV */
export interface OHLCVCandle {
  t: number; // unix ms
  o: number;
  h: number;
  l: number;
  c: number;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export function createGeckoTerminalService(cache: KVNamespace, { bypassCache = false } = {}) {
  async function cachedFetch<T>(cacheKey: string, url: string, schema: z.ZodType<T>): Promise<T> {
    if (!bypassCache) {
      const hot = getHotCached<T>(cacheKey);
      if (hot !== null) {
        console.log(`cache_hit service=gecko-terminal layer=memory key=${cacheKey}`);
        return hot;
      }

      try {
        const hit = await cache.get(cacheKey, 'text');
        if (hit) {
          const parsed = schema.safeParse(JSON.parse(hit));
          if (parsed.success) {
            setHotCached(cacheKey, parsed.data);
            console.log(`cache_hit service=gecko-terminal layer=kv key=${cacheKey}`);
            return parsed.data;
          }
        }
      } catch (err) {
        console.warn(`cache_error service=gecko-terminal op=get key=${cacheKey}`, err);
      }
    }
    console.log(`cache_miss service=gecko-terminal key=${cacheKey} bypass=${bypassCache}`);
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8_000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(tid);
    }
    if (!resp.ok) throw new Error(`GeckoTerminal ${resp.status} ${resp.statusText} — ${url}`);
    const json = await resp.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`GeckoTerminal schema mismatch: ${parsed.error.message.slice(0, 300)}`);
    }
    setHotCached(cacheKey, parsed.data);
    try {
      await cache.put(cacheKey, JSON.stringify(json), { expirationTtl: MARKET_DATA_CACHE_TTL_SECONDS });
    } catch (err) {
      console.warn(`cache_error service=gecko-terminal op=put key=${cacheKey}`, err);
    }
    return parsed.data;
  }

  /**
   * Search Base-chain pools by token symbols.
   * Returns normalised pool objects sorted by liquidity descending.
   */
  async function searchPools(query: string): Promise<GeckoPoolNorm[]> {
    const cacheKey = geckoSearchKey(query);
    const url = `${GECKO_BASE}/search/pools?query=${encodeURIComponent(query)}&network=base&sort=h24_volume_usd_liquidity_desc`;
    const data = await cachedFetch(cacheKey, url, GeckoSearchResponseSchema);

    return data.data.map((p) => {
      const attr = p.attributes;
      const pc = attr.price_change_percentage;
      // relationships is now z.record — drill into it safely
      const rels = p.relationships as Record<string, { data?: { id?: string } }> | null | undefined;
      return {
        address: attr.address,
        name: attr.name,
        dexId: rels?.dex?.data?.id ?? 'unknown',
        priceUsd: pf(attr.base_token_price_usd) ?? 0,
        priceChange: {
          m5:  pf(pc?.m5),
          h1:  pf(pc?.h1),
          h6:  pf(pc?.h6),
          h24: pf(pc?.h24),
        },
        volume24h: pf(attr.volume_usd?.h24),
        liquidityUsd: pf(attr.reserve_in_usd),
      };
    }).filter((p) => p.priceUsd > 0);
  }

  /**
   * Fetch OHLCV close prices for a pool.
   * @param timeframe 'hour' (default) or 'day'
   * Returns close prices oldest→newest (ready for technicalindicators).
   */
  async function getPoolPriceSeries(address: string, limit = 48, timeframe: 'hour' | 'day' = 'hour'): Promise<number[]> {
    const cacheKey = geckoOhlcvKey(address, timeframe, limit);
    const url = `${GECKO_BASE}/networks/base/pools/${address}/ohlcv/${timeframe}?limit=${limit}&currency=usd`;
    const data = await cachedFetch(cacheKey, url, GeckoOHLCVSchema);
    // ohlcv_list is newest-first; reverse to oldest-first for TA libraries
    const closes = data.data.attributes.ohlcv_list.map(([, , , , close]) => close).reverse();
    return closes;
  }

  /**
   * Fetch full OHLCV candles for a pool (oldest→newest).
   * @param timeframe 'hour' | 'day' | 'minute'
   */
  async function getPoolOHLCV(
    address: string,
    limit = 48,
    timeframe: 'hour' | 'day' | 'minute' = 'hour',
  ): Promise<OHLCVCandle[]> {
    const cacheKey = `gecko:ohlcv-full:base:${address.toLowerCase()}:${timeframe}:${limit}`;
    const url = `${GECKO_BASE}/networks/base/pools/${address}/ohlcv/${timeframe}?limit=${limit}&currency=usd`;
    const data = await cachedFetch(cacheKey, url, GeckoOHLCVSchema);
    return data.data.attributes.ohlcv_list
      .map(([t, o, h, l, c]) => ({ t: t * 1000, o, h, l, c }))
      .reverse(); // oldest first
  }

  return { searchPools, getPoolPriceSeries, getPoolOHLCV };
}
