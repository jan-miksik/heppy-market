/**
 * Paper trading engine tests.
 */
import { describe, it, expect } from 'vitest';
import { PaperEngine } from '../src/services/paper-engine.js';

describe('paper trading engine', () => {
  const defaultParams = {
    agentId: 'test-agent',
    pair: 'WETH/USDC',
    dex: 'aerodrome',
    side: 'buy' as const,
    price: 2500,
    amountUsd: 1000,
    maxPositionSizePct: 20,
    balance: 10000,
    confidence: 0.8,
    reasoning: 'RSI oversold + EMA crossover',
    strategyUsed: 'combined',
    slippagePct: 0.3,
  };

  it('opens and closes a position with correct PnL', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    const trade = engine.openPosition(defaultParams);
    expect(trade.status).toBe('open');
    expect(trade.effectiveEntryPrice).toBeCloseTo(2507.5, 1);
    expect(engine.balance).toBeCloseTo(9000, 1);

    const closed = engine.closePosition(trade.id, { price: 2750 });
    expect(closed.effectiveExitPrice).toBeCloseTo(2741.75, 1);
    expect(closed.status).toBe('closed');
    expect(closed.pnlPct).toBeCloseTo(9.34, 1);
    expect(engine.balance).toBeGreaterThan(10000);
  });

  it('respects stop loss check', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    const trade = engine.openPosition(defaultParams);
    expect(engine.checkStopLoss(trade, 2350, 5)).toBe(true);
    expect(engine.checkStopLoss(trade, 2450, 5)).toBe(false);
  });

  it('respects take profit check', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    const trade = engine.openPosition(defaultParams);
    expect(engine.checkTakeProfit(trade, 2800, 10)).toBe(true);
    expect(engine.checkTakeProfit(trade, 2600, 10)).toBe(false);
  });

  it('enforces max position size', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    expect(() => engine.openPosition({ ...defaultParams, amountUsd: 5000 })).toThrow(/exceeds max allowed/);
  });

  it('prevents opening position with insufficient balance', () => {
    const engine = new PaperEngine({ balance: 500, slippage: 0.3 });
    expect(() =>
      engine.openPosition({ ...defaultParams, balance: 500, amountUsd: 600, maxPositionSizePct: 100 })
    ).toThrow(/Insufficient balance/);
  });

  it('rejects zero or negative position amount', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    expect(() => engine.openPosition({ ...defaultParams, amountUsd: 0 })).toThrow();
  });

  it('tracks multiple open positions', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    engine.openPosition({ ...defaultParams, amountUsd: 1000 });
    engine.openPosition({ ...defaultParams, pair: 'cbBTC/WETH', amountUsd: 1000 });
    expect(engine.openPositions.length).toBe(2);
    expect(engine.balance).toBeCloseTo(8000, 1);
  });

  it('calculates win rate correctly', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    const t1 = engine.openPosition({ ...defaultParams, amountUsd: 500 });
    const t2 = engine.openPosition({ ...defaultParams, amountUsd: 500 });
    engine.closePosition(t1.id, { price: 2700 });
    engine.closePosition(t2.id, { price: 2300 });
    expect(engine.getWinRate()).toBeCloseTo(0.5);
  });

  it('stop out marks position as closed with stop_loss reason', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    const trade = engine.openPosition(defaultParams);
    const stopped = engine.stopOutPosition(trade.id, 2350);
    expect(stopped.status).toBe('closed');
    expect(stopped.closeReason).toBe('stop_loss');
  });

  it('calculates total P&L percentage', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    const trade = engine.openPosition(defaultParams);
    engine.closePosition(trade.id, { price: 2750 });
    expect(engine.getTotalPnlPct()).toBeGreaterThan(0);
  });

  it('serializes and deserializes state correctly', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    const trade = engine.openPosition(defaultParams);
    const restored = PaperEngine.deserialize(engine.serialize());
    expect(restored.balance).toBeCloseTo(engine.balance, 2);
    expect(restored.openPositions.length).toBe(1);
    expect(restored.openPositions[0].id).toBe(trade.id);
  });

  it('throws when closing non-existent position', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    expect(() => engine.closePosition('nonexistent', { price: 2500 })).toThrow(/not found/);
  });
});

describe('paper engine short positions', () => {
  it('opens and closes a short position with correct PnL', () => {
    const engine = new PaperEngine({ balance: 10000, slippage: 0.3 });
    const trade = engine.openPosition({
      agentId: 'test',
      pair: 'WETH/USDC',
      dex: 'aerodrome',
      side: 'sell',
      price: 2500,
      amountUsd: 1000,
      maxPositionSizePct: 20,
      balance: 10000,
      confidence: 0.75,
      reasoning: 'Short signal',
      strategyUsed: 'rsi_oversold',
      slippagePct: 0.3,
    });

    expect(trade.side).toBe('sell');
    const closed = engine.closePosition(trade.id, { price: 2300 });
    expect(closed.pnlPct).toBeGreaterThan(0);
  });
});
