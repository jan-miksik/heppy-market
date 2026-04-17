import { describe, expect, it } from 'vitest';
import {
  hasIndexedSpotPriceProvider,
  resolveCoinGeckoCoinIdForPair,
  resolveCoinPaprikaCoinIdForPair,
  resolveDemoFallbackSpotUsdForPair,
  resolveDemoMarketContextForPair,
} from '../src/services/coingecko-price.js';

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
});
