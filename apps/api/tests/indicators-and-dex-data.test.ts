/**
 * Indicator and market-data helper tests.
 */
import { describe, it, expect } from 'vitest';
import {
  computeIndicators,
  evaluateSignals,
  combineSignals,
} from '../src/services/indicators.js';
import { filterBaseChainPairs, getPriceUsd, getPairLabel } from '../src/services/dex-data.js';

describe('technical indicators', () => {
  const prices20 = [
    44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42,
    45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00,
    46.03, 46.41, 46.22, 45.64, 45.80,
  ];

  const prices30 = [
    44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42,
    45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00,
    46.03, 46.41, 46.22, 45.64, 45.20, 44.98, 45.55, 45.80,
    46.10, 46.50, 47.00, 46.80, 47.20, 47.50, 47.80, 48.00,
    47.60, 47.90, 48.20,
  ];

  it('computes RSI from at least 15 prices', () => {
    const result = computeIndicators(prices20);
    expect(result.rsi).toBeDefined();
    expect(result.rsi![result.rsi!.length - 1]).toBeGreaterThan(0);
    expect(result.rsi![result.rsi!.length - 1]).toBeLessThan(100);
  });

  it('computes EMA9 and EMA21', () => {
    const result = computeIndicators(prices20);
    expect(result.ema9?.length).toBeGreaterThan(0);
    expect(result.ema21?.length).toBeGreaterThan(0);
  });

  it('computes Bollinger Bands', () => {
    const result = computeIndicators(prices20);
    const bb = result.bollingerBands![0];
    expect(bb.upper).toBeGreaterThan(bb.middle);
    expect(bb.middle).toBeGreaterThan(bb.lower);
  });

  it('computes MACD from 26+ prices', () => {
    const result = computeIndicators(prices30);
    const lastMacd = result.macd![result.macd!.length - 1];
    expect(lastMacd.MACD).toBeDefined();
    expect(lastMacd.signal).toBeDefined();
  });

  it('returns partial results for short price series', () => {
    const result = computeIndicators([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    expect(result.rsi).toBeUndefined();
    expect(result.ema9).toBeDefined();
    expect(result.ema21).toBeUndefined();
  });

  it('returns empty result for fewer than two prices', () => {
    const result = computeIndicators([100]);
    expect(result.rsi).toBeUndefined();
    expect(result.ema9).toBeUndefined();
  });
});

describe('signal evaluation', () => {
  it('evaluates RSI oversold as buy signal', () => {
    const signals = evaluateSignals({ rsi: [50, 45, 35, 25] }, 100);
    const rsiSignal = signals.find((s) => s.strategy === 'rsi_oversold');
    expect(rsiSignal?.signal).toBe('buy');
    expect(rsiSignal!.confidence).toBeGreaterThan(0.5);
  });

  it('evaluates RSI overbought as sell signal', () => {
    const signals = evaluateSignals({ rsi: [50, 60, 70, 78] }, 100);
    expect(signals.find((s) => s.strategy === 'rsi_oversold')?.signal).toBe('sell');
  });

  it('evaluates neutral RSI as hold', () => {
    const signals = evaluateSignals({ rsi: [50, 52, 55, 53] }, 100);
    expect(signals.find((s) => s.strategy === 'rsi_oversold')?.signal).toBe('hold');
  });

  it('combines multiple buy signals into a combined buy', () => {
    const combined = combineSignals([
      { strategy: 'rsi_oversold', signal: 'buy' as const, confidence: 0.85, reason: 'RSI 22' },
      { strategy: 'ema_crossover', signal: 'buy' as const, confidence: 0.75, reason: 'EMA cross' },
    ]);
    expect(combined.signal).toBe('buy');
    expect(combined.confidence).toBeGreaterThan(0.5);
  });

  it('combines mixed signals into hold', () => {
    const combined = combineSignals([
      { strategy: 'rsi_oversold', signal: 'buy' as const, confidence: 0.65, reason: 'RSI 28' },
      { strategy: 'ema_crossover', signal: 'sell' as const, confidence: 0.65, reason: 'EMA cross down' },
    ]);
    expect(combined.signal).toBe('hold');
  });

  it('returns hold for empty signal array', () => {
    expect(combineSignals([]).signal).toBe('hold');
  });
});

describe('dex data helpers', () => {
  it('filterBaseChainPairs filters to base chain', () => {
    const filtered = filterBaseChainPairs([
      { chainId: 'base', pairAddress: '0x1', liquidity: { usd: 1000000 } },
      { chainId: 'ethereum', pairAddress: '0x2', liquidity: { usd: 500000 } },
      { chainId: 'base', pairAddress: '0x3', liquidity: { usd: 250000 } },
    ] as any[]);
    expect(filtered.length).toBe(2);
    expect(filtered.every((p) => p.chainId === 'base')).toBe(true);
  });

  it('filterBaseChainPairs sorts by liquidity desc', () => {
    const filtered = filterBaseChainPairs([
      { chainId: 'base', pairAddress: '0x3', liquidity: { usd: 250000 } },
      { chainId: 'base', pairAddress: '0x1', liquidity: { usd: 1000000 } },
    ] as any[]);
    expect(filtered[0].pairAddress).toBe('0x1');
  });

  it('getPriceUsd parses price string', () => {
    expect(getPriceUsd({ priceUsd: '2456.78' } as any)).toBeCloseTo(2456.78);
  });

  it('getPriceUsd returns 0 for missing price', () => {
    expect(getPriceUsd({} as any)).toBe(0);
  });

  it('getPairLabel formats label correctly', () => {
    expect(getPairLabel({
      baseToken: { symbol: 'WETH' },
      quoteToken: { symbol: 'USDC' },
    } as any)).toBe('WETH/USDC');
  });
});

describe('DexScreener live API', () => {
  const runLive = process.env.RUN_LIVE_TESTS === '1';

  (runLive ? it : it.skip)('fetches WETH/USDC pair on Base', async () => {
    const response = await fetch(
      'https://api.dexscreener.com/latest/dex/search?q=WETH%20USDC%20base'
    );
    expect(response.ok).toBe(true);
    const data = await response.json() as any;
    expect(Array.isArray(data.pairs)).toBe(true);
    const basePair = data.pairs.find((p: any) => p.chainId === 'base');
    expect(basePair).toBeDefined();
    expect(parseFloat(basePair.priceUsd)).toBeGreaterThan(0);
  });
});
