/**
 * GeckoTerminal API client (free, no API key, supports Base chain).
 * Used as primary/fallback alongside DexScreener.
 *
 * Docs: https://api.geckoterminal.com/api/v2
 * Rate limit: ~30 req/min on free tier (KV cache handles this)
 */
import { z } from 'zod';

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const CACHE_TTL = 60; // seconds (KV minimum is 60)

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

// ─── Client ───────────────────────────────────────────────────────────────────

export function createGeckoTerminalService(cache: KVNamespace) {
  async function cachedFetch<T>(cacheKey: string, url: string, schema: z.ZodType<T>): Promise<T> {
    const hit = await cache.get(cacheKey, 'text');
    if (hit) {
      const parsed = schema.safeParse(JSON.parse(hit));
      if (parsed.success) return parsed.data;
    }
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
    console.log(`[gecko-terminal] raw response keys:`, Object.keys(json as object));
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`GeckoTerminal schema mismatch: ${parsed.error.message.slice(0, 300)}`);
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
