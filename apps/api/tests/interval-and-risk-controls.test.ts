/**
 * Interval scheduling and risk-control tests.
 */
import { describe, it, expect } from 'vitest';
import { PaperEngine } from '../src/services/paper-engine.js';

function intervalToMs(interval: string): number {
  switch (interval) {
    case '1m':
    case '5m':
    case '15m':
    case '1h': return 60 * 60_000;
    case '4h': return 4 * 60 * 60_000;
    case '1d': return 24 * 60 * 60_000;
    default: return 60 * 60_000;
  }
}

describe('interval scheduling', () => {
  it('converts interval strings to milliseconds', () => {
    expect(intervalToMs('1m')).toBe(3_600_000);
    expect(intervalToMs('5m')).toBe(3_600_000);
    expect(intervalToMs('15m')).toBe(3_600_000);
    expect(intervalToMs('1h')).toBe(3_600_000);
    expect(intervalToMs('4h')).toBe(14_400_000);
    expect(intervalToMs('1d')).toBe(86_400_000);
    expect(intervalToMs('unknown')).toBe(3_600_000);
  });
});

describe('daily loss limit checks', () => {
  it('detects when daily loss limit is breached', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    const trade = engine.openPosition({
      agentId: 'test',
      pair: 'WETH/USDC',
      dex: 'aerodrome',
      side: 'buy',
      price: 2500,
      amountUsd: 7000,
      maxPositionSizePct: 80,
      balance: 10000,
      confidence: 0.8,
      reasoning: 'test',
      strategyUsed: 'combined',
      slippagePct: 0,
    });
    engine.closePosition(trade.id, { price: 2500 * 0.80 });
    const dailyPnl = engine.getDailyPnlPct();
    expect(dailyPnl).toBeLessThan(-10);
    expect(dailyPnl <= -10).toBe(true);
  });

  it('does not trigger limit on acceptable loss', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    const trade = engine.openPosition({
      agentId: 'test',
      pair: 'WETH/USDC',
      dex: 'aerodrome',
      side: 'buy',
      price: 2500,
      amountUsd: 1000,
      maxPositionSizePct: 20,
      balance: 10000,
      confidence: 0.8,
      reasoning: 'test',
      strategyUsed: 'combined',
      slippagePct: 0,
    });
    engine.closePosition(trade.id, { price: 2500 * 0.95 });
    expect(engine.getDailyPnlPct()).toBeGreaterThan(-10);
  });
});

describe('stop loss and take profit checks', () => {
  const engine = new PaperEngine({ balance: 10000, slippage: 0 });
  const position = engine.openPosition({
    agentId: 'test',
    pair: 'WETH/USDC',
    dex: 'aerodrome',
    side: 'buy',
    price: 2000,
    amountUsd: 2000,
    maxPositionSizePct: 25,
    balance: 10000,
    confidence: 0.8,
    reasoning: 'test',
    strategyUsed: 'combined',
    slippagePct: 0,
  });

  it('stop loss triggers at -5%', () => {
    expect(engine.checkStopLoss(position, 1899, 5)).toBe(true);
    expect(engine.checkStopLoss(position, 1901, 5)).toBe(false);
  });

  it('take profit triggers at +10%', () => {
    expect(engine.checkTakeProfit(position, 2201, 10)).toBe(true);
    expect(engine.checkTakeProfit(position, 2199, 10)).toBe(false);
  });
});

describe('performance snapshots', () => {
  it('calculates sharpe ratio from trades', () => {
    const pnls = [5, -2, 8, -3, 6, 4, -1, 7, 2, -4];
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / pnls.length;
    const sharpe = mean / Math.sqrt(variance);
    expect(sharpe).toBeGreaterThan(0);
    expect(typeof sharpe).toBe('number');
  });

  it('calculates max drawdown correctly', () => {
    const pnls = [5, 3, -8, -4, 6, -2, 3];
    let peak = 0;
    let maxDd = 0;
    let cumPnl = 0;
    for (const pnl of pnls) {
      cumPnl += pnl;
      if (cumPnl > peak) peak = cumPnl;
      maxDd = Math.max(maxDd, peak - cumPnl);
    }
    expect(maxDd).toBe(12);
  });
});

describe('engine state persistence', () => {
  it('preserves open positions across serialize/deserialize', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    engine.openPosition({
      agentId: 'agent1',
      pair: 'WETH/USDC',
      dex: 'aerodrome',
      side: 'buy',
      price: 2500,
      amountUsd: 1000,
      maxPositionSizePct: 20,
      balance: 10000,
      confidence: 0.8,
      reasoning: 'Test',
      strategyUsed: 'combined',
      slippagePct: 0.3,
    });

    const restored = PaperEngine.deserialize(engine.serialize());
    expect(restored.openPositions.length).toBe(1);
    expect(restored.openPositions[0].pair).toBe('WETH/USDC');
    expect(restored.balance).toBeCloseTo(engine.balance, 2);
    expect(restored.getTotalPnlPct()).toBeCloseTo(engine.getTotalPnlPct(), 2);
  });

  it('preserves closed positions across serialize/deserialize', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0 });
    const trade = engine.openPosition({
      agentId: 'agent1',
      pair: 'WETH/USDC',
      dex: 'aerodrome',
      side: 'buy',
      price: 2000,
      amountUsd: 2000,
      maxPositionSizePct: 25,
      balance: 10000,
      confidence: 0.8,
      reasoning: 'Test',
      strategyUsed: 'combined',
      slippagePct: 0,
    });
    engine.closePosition(trade.id, { price: 2200 });

    const restored = PaperEngine.deserialize(engine.serialize());
    expect(restored.closedPositions.length).toBe(1);
    expect(restored.closedPositions[0].pnlPct).toBeCloseTo(10, 1);
    expect(restored.getWinRate()).toBe(1);
  });
});
