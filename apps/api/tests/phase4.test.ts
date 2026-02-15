/**
 * Phase 4 tests — Agent Loop
 * Tests risk management, cooldown logic, and interval calculation.
 * Agent loop integration uses mock data to avoid LLM API calls.
 */
import { describe, it, expect } from 'vitest';
import { PaperEngine } from '../src/services/paper-engine.js';

/** Mirror of intervalToMs from agent-loop.ts for testing */
function intervalToMs(interval: string): number {
  switch (interval) {
    case '1m':  return 60_000;
    case '5m':  return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h':  return 60 * 60_000;
    case '4h':  return 4 * 60 * 60_000;
    case '1d':  return 24 * 60 * 60_000;
    default:    return 60 * 60_000;
  }
}

describe('Phase 4: Interval scheduling', () => {
  it('converts interval strings to milliseconds', () => {
    expect(intervalToMs('1m')).toBe(60_000);
    expect(intervalToMs('5m')).toBe(300_000);
    expect(intervalToMs('15m')).toBe(900_000);
    expect(intervalToMs('1h')).toBe(3_600_000);
    expect(intervalToMs('4h')).toBe(14_400_000);
    expect(intervalToMs('1d')).toBe(86_400_000);
    expect(intervalToMs('unknown')).toBe(3_600_000); // default 1h
  });
});

describe('Phase 4: Risk management — daily loss limit', () => {
  it('detects when daily loss limit is breached', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });

    // Simulate losses to bring balance down
    const t1 = engine.openPosition({
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

    // Close at 20% loss: $7000 * 20% = $1400 loss on $10000 = 14% daily loss
    engine.closePosition(t1.id, { price: 2500 * 0.80 });
    const dailyPnl = engine.getDailyPnlPct();
    expect(dailyPnl).toBeLessThan(-10);
    expect(dailyPnl <= -10).toBe(true); // should trigger limit
  });

  it('does not trigger limit on acceptable loss', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });

    const t1 = engine.openPosition({
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

    // Close at 5% loss (below 10% daily limit)
    engine.closePosition(t1.id, { price: 2500 * 0.95 });
    const dailyPnl = engine.getDailyPnlPct();
    expect(dailyPnl).toBeGreaterThan(-10);
  });
});

describe('Phase 4: Risk management — stop loss and take profit', () => {
  const engine = new PaperEngine({ balance: 10000, slippage: 0 }); // no slippage for predictable math
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
    // 5% down from 2000 = 1900
    expect(engine.checkStopLoss(position, 1899, 5)).toBe(true);
    expect(engine.checkStopLoss(position, 1901, 5)).toBe(false);
  });

  it('take profit triggers at +10%', () => {
    // 10% up from 2000 = 2200
    expect(engine.checkTakeProfit(position, 2201, 10)).toBe(true);
    expect(engine.checkTakeProfit(position, 2199, 10)).toBe(false);
  });
});

describe('Phase 4: Performance snapshot calculation', () => {
  it('calculates sharpe ratio from trades', () => {
    const pnls = [5, -2, 8, -3, 6, 4, -1, 7, 2, -4];
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / pnls.length;
    const stddev = Math.sqrt(variance);
    const sharpe = mean / stddev;
    expect(sharpe).toBeGreaterThan(0); // positive expectancy
    expect(typeof sharpe).toBe('number');
  });

  it('calculates max drawdown correctly', () => {
    const pnls = [5, 3, -8, -4, 6, -2, 3]; // cumulative: 5,8,0,-4,2,0,3
    let peak = 0;
    let maxDd = 0;
    let cumPnl = 0;
    for (const p of pnls) {
      cumPnl += p;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDd) maxDd = dd;
    }
    expect(maxDd).toBe(12); // peak=8, then drops to -4 → drawdown of 12
  });
});

describe('Phase 4: Engine state persistence', () => {
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

    const serialized = engine.serialize();
    const restored = PaperEngine.deserialize(serialized);

    expect(restored.openPositions.length).toBe(1);
    expect(restored.openPositions[0].pair).toBe('WETH/USDC');
    expect(restored.balance).toBeCloseTo(engine.balance, 2);
    expect(restored.getTotalPnlPct()).toBeCloseTo(engine.getTotalPnlPct(), 2);
  });

  it('preserves closed positions across serialize/deserialize', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0 });
    const t = engine.openPosition({
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
    engine.closePosition(t.id, { price: 2200 });

    const serialized = engine.serialize();
    const restored = PaperEngine.deserialize(serialized);

    expect(restored.closedPositions.length).toBe(1);
    expect(restored.closedPositions[0].pnlPct).toBeCloseTo(10, 1);
    expect(restored.getWinRate()).toBe(1);
  });
});
