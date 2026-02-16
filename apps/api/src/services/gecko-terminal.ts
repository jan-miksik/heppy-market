/**
 * GeckoTerminal API client (free, no API key, supports Base chain).
 * Used as primary/fallback alongside DexScreener.
 *
 * Docs: https://api.geckoterminal.com/api/v2
 * Rate limit: ~30 req/min on free tier (KV cache handles this)
 */
import { z } from 'zod';

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const CACHE_TTL = 30; // seconds

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const GeckoPoolAttributesSchema = z.object({
  address: z.string(),
  name: z.string(),
  base_token_price_usd: z.string().optional(),
  quote_token_price_usd: z.string().optional(),
  price_change_percentage: z
    .object({
      m5: z.string().optional(),
      m15: z.string().optional(),
      h1: z.string().optional(),
      h6: z.string().optional(),
      h24: z.string().optional(),
    })
    .optional(),
  volume_usd: z
    .object({
      m5: z.string().optional(),
      h1: z.string().optional(),
      h6: z.string().optional(),
      h24: z.string().optional(),
    })
    .optional(),
  reserve_in_usd: z.string().optional(),
  pool_created_at: z.string().optional(),
  fdv_usd: z.string().optional(),
  market_cap_usd: z.string().optional(),
  transactions: z
    .object({
      m5: z.object({ buys: z.number(), sells: z.number() }).optional(),
      h1: z.object({ buys: z.number(), sells: z.number() }).optional(),
      h6: z.object({ buys: z.number(), sells: z.number() }).optional(),
      h24: z.object({ buys: z.number(), sells: z.number() }).optional(),
    })
    .optional(),
});

const GeckoPoolSchema = z.object({
  id: z.string(),
  type: z.literal('pool'),
  attributes: GeckoPoolAttributesSchema,
  relationships: z
    .object({
      base_token: z.object({ data: z.object({ id: z.string() }) }).optional(),
      quote_token: z.object({ data: z.object({ id: z.string() }) }).optional(),
      dex: z.object({ data: z.object({ id: z.string() }) }).optional(),
    })
    .optional(),
});

const GeckoSearchResponseSchema = z.object({
  data: z.array(GeckoPoolSchema),
});

// OHLCV: each entry is [timestamp_ms, open, high, low, close, volume]
const GeckoOHLCVSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])),
    }),
  }),
});

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

// ─── Client ───────────────────────────────────────────────────────────────────

export function createGeckoTerminalService(cache: KVNamespace) {
  async function cachedFetch<T>(cacheKey: string, url: string, schema: z.ZodType<T>): Promise<T> {
    const hit = await cache.get(cacheKey, 'text');
    if (hit) {
      const parsed = schema.safeParse(JSON.parse(hit));
      if (parsed.success) return parsed.data;
    }
    const resp = await fetch(url, {
      headers: { Accept: 'application/json;version=20230302' },
    });
    if (!resp.ok) throw new Error(`GeckoTerminal ${resp.status}: ${resp.statusText} (${url})`);
    const json = await resp.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`GeckoTerminal schema mismatch: ${parsed.error.message.slice(0, 200)}`);
    }
    await cache.put(cacheKey, JSON.stringify(json), { expirationTtl: CACHE_TTL });
    return parsed.data;
  }

  /**
   * Search Base-chain pools by token symbols.
   * Returns normalised pool objects sorted by liquidity descending.
   */
  async function searchPools(query: string): Promise<GeckoPoolNorm[]> {
    const cacheKey = `gecko:search:${query.toLowerCase().replace(/\s+/g, '-')}`;
    const url = `${GECKO_BASE}/search/pools?query=${encodeURIComponent(query)}&network=base&sort=h24_volume_usd_liquidity_desc`;
    const data = await cachedFetch(cacheKey, url, GeckoSearchResponseSchema);

    return data.data.map((p) => {
      const attr = p.attributes;
      const pc = attr.price_change_percentage;
      return {
        address: attr.address,
        name: attr.name,
        dexId: p.relationships?.dex?.data?.id ?? 'unknown',
        priceUsd: parseFloat(attr.base_token_price_usd ?? '0'),
        priceChange: {
          m5:  pc?.m5  !== undefined ? parseFloat(pc.m5)  : undefined,
          h1:  pc?.h1  !== undefined ? parseFloat(pc.h1)  : undefined,
          h6:  pc?.h6  !== undefined ? parseFloat(pc.h6)  : undefined,
          h24: pc?.h24 !== undefined ? parseFloat(pc.h24) : undefined,
        },
        volume24h: attr.volume_usd?.h24 !== undefined ? parseFloat(attr.volume_usd.h24) : undefined,
        liquidityUsd: attr.reserve_in_usd !== undefined ? parseFloat(attr.reserve_in_usd) : undefined,
      };
    }).filter((p) => p.priceUsd > 0);
  }

  /**
   * Fetch hourly OHLCV close prices for a pool (up to `limit` candles).
   * Returns close prices oldest→newest (ready for technicalindicators).
   */
  async function getPoolPriceSeries(address: string, limit = 48): Promise<number[]> {
    const cacheKey = `gecko:ohlcv:base:${address.toLowerCase()}:${limit}`;
    const url = `${GECKO_BASE}/networks/base/pools/${address}/ohlcv/hour?limit=${limit}&currency=usd`;
    const data = await cachedFetch(cacheKey, url, GeckoOHLCVSchema);
    // ohlcv_list is newest-first; reverse to oldest-first for TA libraries
    const closes = data.data.attributes.ohlcv_list.map(([, , , , close]) => close).reverse();
    return closes;
  }

  return { searchPools, getPoolPriceSeries };
}
