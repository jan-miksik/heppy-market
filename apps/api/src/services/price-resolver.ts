import type { Env } from '../types/env.js';
import { createDexDataService, getPriceUsd } from './dex-data.js';
import { createGeckoTerminalService } from './gecko-terminal.js';
import {
  hasIndexedSpotPriceProvider,
  resolveIndexedGeckoTerminalMarketContextForPair,
  resolveCoinGeckoSpotUsdForPair,
  resolveCoinPaprikaSpotUsdForPair,
  resolveDemoFallbackSpotUsdForPair,
  selectSaneSpotPriceUsd,
} from './coingecko-price.js';

/** "WETH/USDC" → "WETH USDC" */
function pairToSearchQuery(pairName: string): string {
  return pairName.replace('/', ' ');
}

/**
 * Well-known Base chain token addresses for reliable pair lookups.
 * Used as a fallback when text search fails.
 */
const BASE_TOKEN_ADDRESSES: Record<string, string> = {
  WETH: '0x4200000000000000000000000000000000000006',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
  cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  AERO: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  DEGEN: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
  BRETT: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
  TOSHI: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
};

/** Require the pool/pair label to contain both token symbols. */
function poolMatchesPair(poolName: string, pairName: string): boolean {
  const tokens = pairName.split('/').map((t) => t.trim().toUpperCase());
  const name = poolName.toUpperCase();
  return tokens.every((t) => name.includes(t));
}

/**
 * Resolve a current USD price for a given pair label (Base chain).
 * Returns 0 when all providers fail.
 *
 * Pass `bypassCache: true` when the caller needs a fresh value (e.g. at the
 * moment of opening a position) and cannot tolerate a KV-cached price that
 * may be up to an hour old.
 */
export async function resolveCurrentPriceUsd(
  env: Env,
  pairName: string,
  options: { bypassCache?: boolean } = {},
): Promise<number> {
  const { bypassCache = false } = options;
  const geckoSvc = createGeckoTerminalService(env.CACHE, { bypassCache });
  const dexSvc = createDexDataService(env.CACHE, { bypassCache });
  const query = pairToSearchQuery(pairName);
  const skipDexDiscovery = hasIndexedSpotPriceProvider(pairName);

  if (skipDexDiscovery) {
    const demoSpot = resolveDemoFallbackSpotUsdForPair(pairName);
    const [indexedGeckoCtx, coinGeckoSpot, coinPaprikaSpot] = await Promise.all([
      resolveIndexedGeckoTerminalMarketContextForPair(env, pairName, { bypassCache }),
      resolveCoinGeckoSpotUsdForPair(env, pairName, { bypassCache }),
      resolveCoinPaprikaSpotUsdForPair(env, pairName, { bypassCache }),
    ]);

    if (indexedGeckoCtx && indexedGeckoCtx.spotUsd > 0) {
      const indexedSpot = selectSaneSpotPriceUsd({
        preferredSpotUsd: indexedGeckoCtx.spotUsd,
        secondarySpotUsd: coinGeckoSpot > 0 ? coinGeckoSpot : coinPaprikaSpot,
        hourlyPrices: indexedGeckoCtx.hourlyPrices,
        dailyPrices: indexedGeckoCtx.dailyPrices,
        demoSpotUsd: demoSpot,
      });
      if (indexedSpot > 0) return indexedSpot;
    }

    const indexedSpot = selectSaneSpotPriceUsd({
      preferredSpotUsd: coinGeckoSpot,
      secondarySpotUsd: coinPaprikaSpot,
      demoSpotUsd: demoSpot,
    });
    if (indexedSpot > 0) return indexedSpot;
    return 0;
  }

  // GeckoTerminal first (network=base)
  try {
    const pools = await geckoSvc.searchPools(query);
    const pool = pools.find((p) => poolMatchesPair(p.name, pairName));
    if (pool && pool.priceUsd > 0) return pool.priceUsd;
  } catch {
    // fallthrough
  }

  // DexScreener search fallback
  try {
    const results = await dexSvc.searchPairs(query);
    const basePair = results
      .filter((p) => p.chainId === 'base')
      .filter((p) => poolMatchesPair(`${p.baseToken.symbol}/${p.quoteToken.symbol}`, pairName))
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (basePair) {
      const price = getPriceUsd(basePair);
      if (price > 0) return price;
    }
  } catch {
    // fallthrough
  }

  // Token address fallback (reliable for known Base tokens)
  const tokens = pairName.split('/').map((t) => t.trim().toUpperCase());
  const baseAddr = BASE_TOKEN_ADDRESSES[tokens[0]];
  if (baseAddr) {
    try {
      const results = await dexSvc.getTokenPairs(baseAddr);
      const basePair = results
        .filter((p) => p.chainId === 'base')
        .filter((p) => poolMatchesPair(`${p.baseToken.symbol}/${p.quoteToken.symbol}`, pairName))
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (basePair) {
        const price = getPriceUsd(basePair);
        if (price > 0) return price;
      }
    } catch {
      // fallthrough
    }
  }

  const demoSpot = resolveDemoFallbackSpotUsdForPair(pairName);
  if (demoSpot > 0) return demoSpot;

  return 0;
}
