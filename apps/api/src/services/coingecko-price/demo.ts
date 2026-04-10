import { calcPctChange, resolveCoinGeckoCoinIdForPair, type CoinGeckoMarketContext } from './shared.js';

const DEMO_FALLBACK_USD_BY_COIN_ID: Record<string, number> = {
  initia: 0.08,
};

/**
 * Demo-only safety net for stable-quoted pairs when external providers are unavailable.
 * Returns 0 for unsupported pairs.
 */
export function resolveDemoFallbackSpotUsdForPair(pairName: string): number {
  const coinId = resolveCoinGeckoCoinIdForPair(pairName);
  if (!coinId) return 0;
  const price = DEMO_FALLBACK_USD_BY_COIN_ID[coinId];
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function buildDemoSeries(spot: number, points: number, stepAmplitudePct: number): number[] {
  if (!Number.isFinite(spot) || spot <= 0 || points <= 0) return [];
  return Array.from({ length: points }, (_, index) => {
    const wave = Math.sin(index / 4) * stepAmplitudePct + Math.cos(index / 9) * (stepAmplitudePct * 0.6);
    const drift = ((index - points / 2) / points) * (stepAmplitudePct * 0.25);
    const pct = wave + drift;
    return spot * (1 + pct / 100);
  }).map((value) => (value > 0 ? value : spot));
}

export function resolveDemoMarketContextForPair(pairName: string): CoinGeckoMarketContext | null {
  const spotUsd = resolveDemoFallbackSpotUsdForPair(pairName);
  if (spotUsd <= 0) return null;

  const hourlyPrices = buildDemoSeries(spotUsd, 48, 1.1);
  const dailyPrices = buildDemoSeries(spotUsd, 30, 2.6);
  const current = hourlyPrices.at(-1) ?? spotUsd;
  return {
    spotUsd,
    hourlyPrices,
    dailyPrices,
    priceChange: {
      m5: undefined,
      h1: calcPctChange(current, hourlyPrices.at(-2)),
      h6: calcPctChange(current, hourlyPrices.at(-7)),
      h24: calcPctChange(current, hourlyPrices.at(-25)),
    },
    volume24h: undefined,
  };
}
