/**
 * Phase 2 tests — Data Layer
 * Tests DexScreener API (live fetch) and technical indicators computation.
 */
import { describe, it, expect } from 'vitest';
import {
  computeIndicators,
  evaluateSignals,
  combineSignals,
} from '../src/services/indicators.js';
import { filterBaseChainPairs, getPriceUsd, getPairLabel } from '../src/services/dex-data.js';

// ─── Technical Indicators ─────────────────────────────────────────────────────

describe('Phase 2: Technical Indicators', () => {
  // Standard 21-price series (sufficient for RSI, EMA9, EMA21, SMA, Bollinger)
  const prices20 = [
    44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42,
    45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00,
    46.03, 46.41, 46.22, 45.64, 45.80,
  ];

  // 35-price series (sufficient for MACD with signal line: slow 26 + signal 9 = 34 min)
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
    expect(result.rsi!.length).toBeGreaterThan(0);
    const lastRsi = result.rsi![result.rsi!.length - 1];
    expect(lastRsi).toBeGreaterThan(0);
    expect(lastRsi).toBeLessThan(100);
  });

  it('computes EMA9 and EMA21', () => {
    const result = computeIndicators(prices20);
    expect(result.ema9).toBeDefined();
    expect(result.ema21).toBeDefined();
    expect(result.ema9!.length).toBeGreaterThan(0);
    expect(result.ema21!.length).toBeGreaterThan(0);
  });

  it('computes Bollinger Bands', () => {
    const result = computeIndicators(prices20);
    expect(result.bollingerBands).toBeDefined();
    expect(result.bollingerBands!.length).toBeGreaterThan(0);
    const bb = result.bollingerBands![0];
    expect(bb.upper).toBeGreaterThan(bb.middle);
    expect(bb.middle).toBeGreaterThan(bb.lower);
  });

  it('computes MACD from 26+ prices', () => {
    const result = computeIndicators(prices30);
    expect(result.macd).toBeDefined();
    expect(result.macd!.length).toBeGreaterThan(0);
    const lastMacd = result.macd![result.macd!.length - 1];
    expect(lastMacd.MACD).toBeDefined();
    expect(lastMacd.signal).toBeDefined();
  });

  it('returns partial results for < 21 prices', () => {
    const shortPrices = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
    const result = computeIndicators(shortPrices);
    expect(result.rsi).toBeUndefined(); // needs 15+
    expect(result.ema9).toBeDefined();  // needs 9+
    expect(result.ema21).toBeUndefined(); // needs 21+
  });

  it('returns empty result for < 2 prices', () => {
    const result = computeIndicators([100]);
    expect(result.rsi).toBeUndefined();
    expect(result.ema9).toBeUndefined();
  });
});

describe('Phase 2: Signal Evaluation', () => {
  it('evaluates RSI oversold as buy signal', () => {
    // Create indicators with RSI = 25 (oversold)
    const mockIndicators = { rsi: [50, 45, 35, 25] };
    const signals = evaluateSignals(mockIndicators, 100);
    const rsiSignal = signals.find((s) => s.strategy === 'rsi_oversold');
    expect(rsiSignal).toBeDefined();
    expect(rsiSignal!.signal).toBe('buy');
    expect(rsiSignal!.confidence).toBeGreaterThan(0.5);
  });

  it('evaluates RSI overbought as sell signal', () => {
    const mockIndicators = { rsi: [50, 60, 70, 78] };
    const signals = evaluateSignals(mockIndicators, 100);
    const rsiSignal = signals.find((s) => s.strategy === 'rsi_oversold');
    expect(rsiSignal!.signal).toBe('sell');
  });

  it('evaluates neutral RSI as hold', () => {
    const mockIndicators = { rsi: [50, 52, 55, 53] };
    const signals = evaluateSignals(mockIndicators, 100);
    const rsiSignal = signals.find((s) => s.strategy === 'rsi_oversold');
    expect(rsiSignal!.signal).toBe('hold');
  });

  it('combines multiple buy signals into a combined buy', () => {
    const buySignals = [
      { strategy: 'rsi_oversold', signal: 'buy' as const, confidence: 0.85, reason: 'RSI 22' },
      { strategy: 'ema_crossover', signal: 'buy' as const, confidence: 0.75, reason: 'EMA cross' },
    ];
    const combined = combineSignals(buySignals);
    expect(combined.signal).toBe('buy');
    expect(combined.confidence).toBeGreaterThan(0.5);
  });

  it('combines mixed signals into hold', () => {
    const mixedSignals = [
      { strategy: 'rsi_oversold', signal: 'buy' as const, confidence: 0.65, reason: 'RSI 28' },
      { strategy: 'ema_crossover', signal: 'sell' as const, confidence: 0.65, reason: 'EMA cross down' },
    ];
    const combined = combineSignals(mixedSignals);
    expect(combined.signal).toBe('hold');
  });

  it('returns hold for empty signal array', () => {
    const combined = combineSignals([]);
    expect(combined.signal).toBe('hold');
  });
});

describe('Phase 2: DexScreener helpers', () => {
  it('filterBaseChainPairs filters to base chain', () => {
    const mockPairs = [
      { chainId: 'base', pairAddress: '0x1', liquidity: { usd: 1000000 } },
      { chainId: 'ethereum', pairAddress: '0x2', liquidity: { usd: 500000 } },
      { chainId: 'base', pairAddress: '0x3', liquidity: { usd: 250000 } },
    ] as any[];
    const filtered = filterBaseChainPairs(mockPairs);
    expect(filtered.length).toBe(2);
    expect(filtered.every((p) => p.chainId === 'base')).toBe(true);
  });

  it('filterBaseChainPairs sorts by liquidity desc', () => {
    const mockPairs = [
      { chainId: 'base', pairAddress: '0x3', liquidity: { usd: 250000 } },
      { chainId: 'base', pairAddress: '0x1', liquidity: { usd: 1000000 } },
    ] as any[];
    const filtered = filterBaseChainPairs(mockPairs);
    expect(filtered[0].pairAddress).toBe('0x1');
  });

  it('getPriceUsd parses price string', () => {
    const mockPair = { priceUsd: '2456.78' } as any;
    expect(getPriceUsd(mockPair)).toBeCloseTo(2456.78);
  });

  it('getPriceUsd returns 0 for missing price', () => {
    const mockPair = {} as any;
    expect(getPriceUsd(mockPair)).toBe(0);
  });

  it('getPairLabel formats label correctly', () => {
    const mockPair = {
      baseToken: { symbol: 'WETH' },
      quoteToken: { symbol: 'USDC' },
    } as any;
    expect(getPairLabel(mockPair)).toBe('WETH/USDC');
  });
});

// ─── Live DexScreener API test (requires network) ─────────────────────────────
describe('Phase 2: DexScreener Live API', () => {
  it('fetches WETH/USDC pair on Base', async () => {
    const response = await fetch(
      'https://api.dexscreener.com/latest/dex/search?q=WETH%20USDC%20base'
    );
    expect(response.ok).toBe(true);
    const data = await response.json() as any;
    expect(data.pairs).toBeDefined();
    expect(Array.isArray(data.pairs)).toBe(true);
    const basePair = data.pairs.find((p: any) => p.chainId === 'base');
    expect(basePair).toBeDefined();
    expect(parseFloat(basePair.priceUsd)).toBeGreaterThan(0);
  });
});
