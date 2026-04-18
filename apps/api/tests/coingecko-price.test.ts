import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasIndexedSpotPriceProvider,
  resolveCoinGeckoCoinIdForPair,
  resolveCoinGeckoSpotUsdForPair,
  resolveIndexedGeckoTerminalMarketContextForPair,
  resolveIndexedGeckoTerminalSpotUsdForPair,
  resolveCoinPaprikaCoinIdForPair,
  resolveCoinPaprikaSpotUsdForPair,
  resolveDemoFallbackSpotUsdForPair,
  resolveDemoMarketContextForPair,
  selectSaneSpotPriceUsd,
} from '../src/services/coingecko-price.js';

function createEnv(cacheValues: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(cacheValues));
  return {
    CACHE: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('coingecko pair helpers', () => {
  it('resolves init stable pairs to initia coin id', () => {
    expect(resolveCoinGeckoCoinIdForPair('INIT/USD')).toBe('initia');
    expect(resolveCoinGeckoCoinIdForPair('INIT/USDT')).toBe('initia');
    expect(resolveCoinGeckoCoinIdForPair('INITIA/USDC')).toBe('initia');
    expect(resolveCoinPaprikaCoinIdForPair('INIT/USD')).toBe('init-initia');
    expect(hasIndexedSpotPriceProvider('INIT/USD')).toBe(true);
    expect(hasIndexedSpotPriceProvider('WETH/USDC')).toBe(false);
  });

  it('returns demo fallback spot for init stable pairs only', () => {
    expect(resolveDemoFallbackSpotUsdForPair('INIT/USD')).toBeGreaterThan(0);
    expect(resolveDemoFallbackSpotUsdForPair('INIT/USDT')).toBeGreaterThan(0);
    expect(resolveDemoFallbackSpotUsdForPair('WETH/USDC')).toBe(0);
  });

  it('builds a non-empty demo market context for init', () => {
    const ctx = resolveDemoMarketContextForPair('INIT/USD');
    expect(ctx).not.toBeNull();
    expect(ctx!.spotUsd).toBeGreaterThan(0);
    expect(ctx!.hourlyPrices).toHaveLength(48);
    expect(ctx!.dailyPrices).toHaveLength(30);
    expect(ctx!.priceChange.h1).not.toBeUndefined();
    expect(ctx!.priceChange.h24).not.toBeUndefined();
  });

  it('resolves INIT/USD from GeckoTerminal on the Initia network', async () => {
    const env = createEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;

        if (url.includes('/search/pools?') && url.includes('network=initia')) {
          return new Response(JSON.stringify({
            data: [
              {
                id: 'initia_pool',
                type: 'pool',
                attributes: {
                  address: '0xpool',
                  name: 'INIT / USDC',
                  base_token_price_usd: '0.092831',
                  quote_token_price_usd: '0.99',
                  price_change_percentage: { h1: '1.111', h6: '3.976', h24: '4.22' },
                  volume_usd: { h24: '93451.07' },
                  reserve_in_usd: '2166560.36',
                },
                relationships: {
                  dex: { data: { id: 'initia-dex' } },
                },
              },
            ],
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.includes('/ohlcv/hour')) {
          return new Response(JSON.stringify({
            data: {
              attributes: {
                ohlcv_list: [
                  [2, 0.09254, 0.092831, 0.092298, 0.092831, 11082.43],
                  [1, 0.091328, 0.09254, 0.091328, 0.09254, 4530.99],
                ],
              },
            },
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.includes('/ohlcv/day')) {
          return new Response(JSON.stringify({
            data: {
              attributes: {
                ohlcv_list: [
                  [2, 0.09026, 0.092831, 0.08846, 0.092831, 34687.81],
                  [1, 0.087553, 0.09197, 0.086346, 0.09026, 86306.06],
                ],
              },
            },
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await expect(
      resolveIndexedGeckoTerminalSpotUsdForPair(env as any, 'INIT/USD', { bypassCache: true }),
    ).resolves.toBeCloseTo(0.092831, 6);

    const ctx = await resolveIndexedGeckoTerminalMarketContextForPair(env as any, 'INIT/USD', { bypassCache: true });
    expect(ctx).not.toBeNull();
    expect(ctx!.spotUsd).toBeCloseTo(0.092831, 6);
    expect(ctx!.hourlyPrices).toEqual([0.09254, 0.092831]);
    expect(ctx!.dailyPrices).toEqual([0.09026, 0.092831]);
    expect(ctx!.priceChange.h1).toBeCloseTo(1.111, 3);
    expect(ctx!.priceChange.h24).toBeCloseTo(4.22, 2);
    expect(ctx!.volume24h).toBeCloseTo(93451.07, 2);
    expect(ctx!.liquidityUsd).toBeCloseTo(2166560.36, 2);
  });

  it('picks secondary over a decimal-scale outlier via log-median consensus', () => {
    // preferred is ~34 000× off; secondary + chart form a tight cluster → secondary wins
    const selected = selectSaneSpotPriceUsd({
      preferredSpotUsd: 0.0000023929,
      secondarySpotUsd: 0.081017,
      hourlyPrices: [0.0798, 0.0804, 0.0812],
      dailyPrices: [0.077, 0.0795, 0.0807],
      demoSpotUsd: 0.08,
    });

    expect(selected).toBeCloseTo(0.081017, 6);
  });

  it('falls back to the latest chart close when the only live spot is a decimal-scale outlier', () => {
    // Only one live spot, and it is far from the chart cluster → chart candle wins
    const selected = selectSaneSpotPriceUsd({
      preferredSpotUsd: 0.0000023929,
      hourlyPrices: [0.0798, 0.0804, 0.0812],
      dailyPrices: [0.077, 0.0795, 0.0807],
      demoSpotUsd: 0.08,
    });

    expect(selected).toBeCloseTo(0.0812, 6);
  });

  it('accepts a legitimate 5× pump when both live spots agree and chart is stale', () => {
    // No hard ratio threshold: log-median places both live spots in the same quality
    // band, so preferred wins by priority
    const selected = selectSaneSpotPriceUsd({
      preferredSpotUsd: 0.50,
      secondarySpotUsd: 0.48,
      hourlyPrices: [0.08, 0.09, 0.10],
      dailyPrices: [0.07, 0.08, 0.09],
      demoSpotUsd: 0.08,
    });

    expect(selected).toBeCloseTo(0.50, 6);
  });

  it('trusts provider priority order when no chart data is available', () => {
    const selected = selectSaneSpotPriceUsd({
      preferredSpotUsd: 0.091,
      secondarySpotUsd: 0.089,
    });

    expect(selected).toBeCloseTo(0.091, 6);
  });

  it('bypasses stale CoinGecko spot cache when requested', async () => {
    const env = createEnv({
      'coingecko:spot:initia:usd': '0.01',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ initia: { usd: 0.0905 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    );

    await expect(resolveCoinGeckoSpotUsdForPair(env as any, 'INIT/USD')).resolves.toBeCloseTo(0.01, 6);
    await expect(resolveCoinGeckoSpotUsdForPair(env as any, 'INIT/USD', { bypassCache: true })).resolves.toBeCloseTo(0.0905, 6);
  });

  it('bypasses stale CoinPaprika spot cache when requested', async () => {
    const env = createEnv({
      'coinpaprika:ticker:init-initia': {
        quotes: {
          USD: {
            price: 0.01,
          },
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        quotes: {
          USD: {
            price: 0.0907,
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    );

    await expect(resolveCoinPaprikaSpotUsdForPair(env as any, 'INIT/USD')).resolves.toBeCloseTo(0.01, 6);
    await expect(resolveCoinPaprikaSpotUsdForPair(env as any, 'INIT/USD', { bypassCache: true })).resolves.toBeCloseTo(0.0907, 6);
  });
});
