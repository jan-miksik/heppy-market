import type { Env } from '../../types/env.js';
import { createGeckoTerminalService } from '../gecko-terminal.js';
import {
  calcPctChange,
  parseStableQuotedPair,
  type CacheOptions,
  type CoinGeckoMarketContext,
} from './shared.js';

const INDEXED_GECKO_NETWORK_BY_SYMBOL: Record<string, string> = {
  INIT: 'initia',
  INITIA: 'initia',
};

const STABLE_POOL_QUOTES = ['USD', 'USDC', 'USDBC', 'USDT', 'DAI'];

export type IndexedGeckoTerminalMarketContext = CoinGeckoMarketContext & {
  liquidityUsd?: number;
};

export function resolveIndexedGeckoTerminalNetworkForPair(pairName: string): string | null {
  const pair = parseStableQuotedPair(pairName);
  if (!pair) return null;
  return INDEXED_GECKO_NETWORK_BY_SYMBOL[pair.baseSymbol] ?? null;
}

function poolMatchesIndexedStablePair(poolName: string, pairName: string): boolean {
  const pair = parseStableQuotedPair(pairName);
  if (!pair) return false;

  const name = poolName.toUpperCase();
  if (!name.includes(pair.baseSymbol)) return false;
  return STABLE_POOL_QUOTES.some((quote) => name.includes(quote));
}

async function findIndexedGeckoPool(env: Env, pairName: string, options?: CacheOptions) {
  const network = resolveIndexedGeckoTerminalNetworkForPair(pairName);
  const pair = parseStableQuotedPair(pairName);
  if (!network || !pair) return null;

  const geckoSvc = createGeckoTerminalService(env.CACHE, {
    bypassCache: options?.bypassCache === true,
    network,
  });
  const pools = await geckoSvc.searchPools(pair.baseSymbol);
  return pools
    .filter((pool) => poolMatchesIndexedStablePair(pool.name, pairName))
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0] ?? null;
}

export async function resolveIndexedGeckoTerminalSpotUsdForPair(
  env: Env,
  pairName: string,
  options?: CacheOptions,
): Promise<number> {
  try {
    const pool = await findIndexedGeckoPool(env, pairName, options);
    return pool?.priceUsd ?? 0;
  } catch {
    return 0;
  }
}

export async function resolveIndexedGeckoTerminalMarketContextForPair(
  env: Env,
  pairName: string,
  options?: CacheOptions,
): Promise<IndexedGeckoTerminalMarketContext | null> {
  try {
    const network = resolveIndexedGeckoTerminalNetworkForPair(pairName);
    const pool = await findIndexedGeckoPool(env, pairName, options);
    if (!network || !pool || pool.priceUsd <= 0) return null;

    const geckoSvc = createGeckoTerminalService(env.CACHE, {
      bypassCache: options?.bypassCache === true,
      network,
    });
    const [hourlyPrices, dailyPrices] = await Promise.all([
      geckoSvc.getPoolPriceSeries(pool.address, 48, 'hour').catch(() => []),
      geckoSvc.getPoolPriceSeries(pool.address, 30, 'day').catch(() => []),
    ]);

    const current = hourlyPrices.at(-1) ?? dailyPrices.at(-1) ?? pool.priceUsd;
    const oneHourAgo = hourlyPrices.length >= 2 ? hourlyPrices.at(-2) : undefined;
    const sixHoursAgo = hourlyPrices.length >= 7 ? hourlyPrices.at(-7) : undefined;
    const twentyFourHoursAgo = hourlyPrices.length >= 25
      ? hourlyPrices.at(-25)
      : dailyPrices.length >= 2
      ? dailyPrices.at(-2)
      : undefined;

    return {
      spotUsd: pool.priceUsd,
      hourlyPrices,
      dailyPrices,
      priceChange: {
        m5: pool.priceChange.m5,
        h1: pool.priceChange.h1 ?? calcPctChange(current, oneHourAgo),
        h6: pool.priceChange.h6 ?? calcPctChange(current, sixHoursAgo),
        h24: pool.priceChange.h24 ?? calcPctChange(current, twentyFourHoursAgo),
      },
      volume24h: pool.volume24h,
      liquidityUsd: pool.liquidityUsd,
    };
  } catch {
    return null;
  }
}
