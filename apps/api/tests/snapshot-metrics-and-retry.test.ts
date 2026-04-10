/**
 * Snapshot metrics, retry helper, and rate-limit math tests.
 */
import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../src/services/snapshot.js';
import { retry } from '../src/lib/utils.js';

describe('snapshot metrics', () => {
  it('computes metrics for empty trades', () => {
    const metrics = computeMetrics([], 10000, 10000);
    expect(metrics.totalTrades).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.totalPnlPct).toBe(0);
    expect(metrics.sharpeRatio).toBeNull();
    expect(metrics.maxDrawdown).toBeNull();
  });

  it('computes win rate correctly', () => {
    const closed = [
      { pnlPct: 5.2, pnlUsd: 52 },
      { pnlPct: -2.1, pnlUsd: -21 },
      { pnlPct: 8.4, pnlUsd: 84 },
      { pnlPct: -1.5, pnlUsd: -15 },
      { pnlPct: 3.7, pnlUsd: 37 },
    ];
    const metrics = computeMetrics(closed, 10000, 10137);
    expect(metrics.totalTrades).toBe(5);
    expect(metrics.winRate).toBeCloseTo(0.6);
    expect(metrics.totalPnlPct).toBeCloseTo(1.37, 1);
  });

  it('computes Sharpe ratio for at least five trades', () => {
    const closed = [
      { pnlPct: 5.2, pnlUsd: 52 },
      { pnlPct: -2.1, pnlUsd: -21 },
      { pnlPct: 8.4, pnlUsd: 84 },
      { pnlPct: -1.5, pnlUsd: -15 },
      { pnlPct: 3.7, pnlUsd: 37 },
    ];
    const metrics = computeMetrics(closed, 10000, 10137);
    expect(metrics.sharpeRatio).not.toBeNull();
    expect(metrics.sharpeRatio!).toBeGreaterThan(0);
  });

  it('returns null Sharpe for fewer than five trades', () => {
    const metrics = computeMetrics([
      { pnlPct: 5, pnlUsd: 50 },
      { pnlPct: -2, pnlUsd: -20 },
    ], 10000, 10030);
    expect(metrics.sharpeRatio).toBeNull();
  });

  it('computes max drawdown correctly', () => {
    const metrics = computeMetrics([
      { pnlPct: 5, pnlUsd: 50 },
      { pnlPct: 3, pnlUsd: 30 },
      { pnlPct: -8, pnlUsd: -80 },
      { pnlPct: -4, pnlUsd: -40 },
      { pnlPct: 6, pnlUsd: 60 },
      { pnlPct: -2, pnlUsd: -20 },
      { pnlPct: 3, pnlUsd: 30 },
    ], 10000, 10030);
    expect(metrics.maxDrawdown).not.toBeNull();
    expect(metrics.maxDrawdown!).toBeCloseTo(12, 1);
  });

  it('returns null drawdown for fewer than two trades', () => {
    const metrics = computeMetrics([{ pnlPct: 5, pnlUsd: 50 }], 10000, 10050);
    expect(metrics.maxDrawdown).toBeNull();
  });

  it('computes negative total PnL correctly', () => {
    const metrics = computeMetrics([
      { pnlPct: -5, pnlUsd: -500 },
      { pnlPct: -3, pnlUsd: -300 },
    ], 10000, 9200);
    expect(metrics.totalPnlPct).toBeCloseTo(-8, 1);
    expect(metrics.winRate).toBe(0);
  });
});

describe('retry helper', () => {
  it('retries on failure and succeeds', async () => {
    let attempts = 0;
    const result = await retry(async () => {
      attempts++;
      if (attempts < 3) throw new Error('Transient error');
      return 'success';
    }, 3, 10);
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('throws after max attempts', async () => {
    let attempts = 0;
    await expect(retry(async () => {
      attempts++;
      throw new Error('Always fails');
    }, 3, 10)).rejects.toThrow('Always fails');
    expect(attempts).toBe(3);
  });

  it('succeeds on first attempt without retry', async () => {
    expect(await retry(async () => 42, 3, 10)).toBe(42);
  });
});

describe('rate limit math', () => {
  it('computes window key correctly', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSecs = 60;
    const windowKey = `rl:test:${Math.floor(nowSec / windowSecs)}`;
    expect(windowKey.startsWith('rl:test:')).toBe(true);
    expect(Number(windowKey.split(':')[2])).toBeGreaterThan(0);
  });

  it('computes reset time correctly', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowSecs = 60;
    const resetAt = (Math.floor(nowSec / windowSecs) + 1) * windowSecs;
    expect(resetAt).toBeGreaterThan(nowSec);
    expect(resetAt - nowSec).toBeLessThanOrEqual(windowSecs);
  });
});
