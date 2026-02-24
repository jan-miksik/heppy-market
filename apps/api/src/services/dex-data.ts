import { z } from 'zod';

// ─── DexScreener API types ────────────────────────────────────────────────────

const TokenSchema = z.object({
  address: z.string(),
  name: z.string(),
  symbol: z.string(),
  image: z.string().optional(),
});

const TxnsSchema = z.object({
  m5: z.object({ buys: z.number(), sells: z.number() }).optional(),
  h1: z.object({ buys: z.number(), sells: z.number() }).optional(),
  h6: z.object({ buys: z.number(), sells: z.number() }).optional(),
  h24: z.object({ buys: z.number(), sells: z.number() }).optional(),
});

const VolumeSchema = z.object({
  m5: z.number().optional(),
  h1: z.number().optional(),
  h6: z.number().optional(),
  h24: z.number().optional(),
});

const PriceChangeSchema = z.object({
  m5: z.number().optional(),
  h1: z.number().optional(),
  h6: z.number().optional(),
  h24: z.number().optional(),
});

const LiquiditySchema = z.object({
  usd: z.number().optional(),
  base: z.number().optional(),
  quote: z.number().optional(),
});

export const PairSchema = z.object({
  chainId: z.string(),
  dexId: z.string(),
  url: z.string().optional(),
  pairAddress: z.string(),
  baseToken: TokenSchema,
  quoteToken: TokenSchema,
  priceNative: z.string(),
  priceUsd: z.string().optional(),
  txns: TxnsSchema.optional(),
  volume: VolumeSchema.optional(),
  priceChange: PriceChangeSchema.optional(),
  liquidity: LiquiditySchema.optional(),
  fdv: z.number().optional(),
  marketCap: z.number().optional(),
  pairCreatedAt: z.number().optional(),
  info: z.object({ imageUrl: z.string().optional() }).optional(),
});

export type DexPair = z.infer<typeof PairSchema>;

const SearchResponseSchema = z.object({
  schemaVersion: z.string().optional(),
  pairs: z.array(PairSchema).nullable(),
});

const PairsResponseSchema = z.object({
  schemaVersion: z.string().optional(),
  pairs: z.array(PairSchema).nullable(),
});

// ─── DexScreener client ───────────────────────────────────────────────────────

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const CACHE_TTL_SECONDS = 60; // KV minimum is 60 seconds
const TOP_PAIRS_CACHE_TTL = 300; // 5 minutes for top pairs list

/** Base chain token addresses used to fetch top pairs by volume */
const BASE_TOP_TOKEN_ADDRESSES = [
  '0x4200000000000000000000000000000000000006', // WETH
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
];

export interface DexDataService {
  searchPairs(query: string): Promise<DexPair[]>;
  getPairsByChain(chain: string, pairAddress: string): Promise<DexPair[]>;
  getTokenPairs(tokenAddress: string): Promise<DexPair[]>;
  getTopPairsForChain(chainId: string): Promise<DexPair[]>;
}

export function createDexDataService(cache: KVNamespace): DexDataService {
  /**
   * Fetch with KV caching. Returns cached value if fresh, otherwise fetches
   * and stores the result.
   */
  async function cachedFetch<T>(
    cacheKey: string,
    url: string,
    schema: z.ZodType<T>
  ): Promise<T> {
    // Try cache first
    const cached = await cache.get(cacheKey, 'text');
    if (cached !== null) {
      const parsed = schema.safeParse(JSON.parse(cached));
      if (parsed.success) return parsed.data;
    }

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(tid);
    }

    if (!response.ok) {
      throw new Error(`DexScreener ${response.status} ${response.statusText} — ${url}`);
    }

    const json = await response.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(
        `DexScreener response validation failed: ${parsed.error.message}`
      );
    }

    // Cache the raw JSON string
    await cache.put(cacheKey, JSON.stringify(json), {
      expirationTtl: CACHE_TTL_SECONDS,
    });

    return parsed.data;
  }

  return {
    async searchPairs(query: string): Promise<DexPair[]> {
      const cacheKey = `dex:search:${query.toLowerCase().replace(/\s+/g, '-')}`;
      const url = `${DEXSCREENER_BASE}/search?q=${encodeURIComponent(query)}`;
      const data = await cachedFetch(cacheKey, url, SearchResponseSchema);
      return data.pairs ?? [];
    },

    async getPairsByChain(
      chain: string,
      pairAddress: string
    ): Promise<DexPair[]> {
      const cacheKey = `dex:pair:${chain}:${pairAddress.toLowerCase()}`;
      const url = `${DEXSCREENER_BASE}/pairs/${chain}/${pairAddress}`;
      const data = await cachedFetch(cacheKey, url, PairsResponseSchema);
      return data.pairs ?? [];
    },

    async getTokenPairs(tokenAddress: string): Promise<DexPair[]> {
      const cacheKey = `dex:token:${tokenAddress.toLowerCase()}`;
      const url = `${DEXSCREENER_BASE}/tokens/${tokenAddress}`;
      const data = await cachedFetch(cacheKey, url, PairsResponseSchema);
      return data.pairs ?? [];
    },

    async getTopPairsForChain(chainId: string): Promise<DexPair[]> {
      const cacheKey = `dex:top:${chainId.toLowerCase()}`;
      const cached = await cache.get(cacheKey, 'text');
      if (cached !== null) {
        const parsed = z.array(PairSchema).safeParse(JSON.parse(cached));
        if (parsed.success) return parsed.data;
      }

      const tokenAddresses =
        chainId === 'base' ? BASE_TOP_TOKEN_ADDRESSES : [];
      const allPairs: DexPair[] = [];

      for (const addr of tokenAddresses) {
        const pairs = await this.getTokenPairs(addr);
        for (const p of pairs) {
          if (p.chainId !== chainId) continue;
          allPairs.push(p);
        }
      }

      // One row per pair label (e.g. WETH/USDC): keep the listing with highest 24h volume
      const byLabel = new Map<string, DexPair>();
      for (const p of allPairs) {
        const label = `${p.baseToken.symbol}/${p.quoteToken.symbol}`;
        const existing = byLabel.get(label);
        const vol = p.volume?.h24 ?? 0;
        if (!existing || vol > (existing.volume?.h24 ?? 0)) {
          byLabel.set(label, p);
        }
      }

      const sorted = [...byLabel.values()]
        .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
        .slice(0, 3);

      await cache.put(cacheKey, JSON.stringify(sorted), {
        expirationTtl: TOP_PAIRS_CACHE_TTL,
      });
      return sorted;
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Filter pairs to Base chain and sort by liquidity descending */
export function filterBaseChainPairs(pairs: DexPair[]): DexPair[] {
  return pairs
    .filter((p) => p.chainId === 'base')
    .sort(
      (a, b) =>
        (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    );
}

/** Get the current USD price for a pair */
export function getPriceUsd(pair: DexPair): number {
  return parseFloat(pair.priceUsd ?? '0');
}

/** Build a human-readable pair label */
export function getPairLabel(pair: DexPair): string {
  return `${pair.baseToken.symbol}/${pair.quoteToken.symbol}`;
}
