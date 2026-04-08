import { describe, it, expect } from 'vitest';
import { planPerpExecution, type PerpExecutionPlanInput } from '../src/agents/execution-planner';
import type { PerpTradeDecision } from '@something-in-loop/shared';
import { AgentConfigSchema } from '@something-in-loop/shared';
import { PERP_DEX_REGISTRY } from '../src/agents/dex-registry';

const COLLATERAL_TOKEN = '0x1111111111111111111111111111111111111111' as const;

const baseConfig = AgentConfigSchema.parse({
  name: 'test',
  pairs: ['BTC/USD'],
  chain: 'initia',
  dexPlatformId: 'mock-perp-v1',
  allowedTradeTokens: [COLLATERAL_TOKEN],
});

const MARKET_PRICE = 60000;
const WAD = 10n ** 18n;

function holdDecision(): PerpTradeDecision {
  return { action: 'HOLD', market: 'BTC/USD', confidence: 0.5, sizePct: 0, maxSlippageBps: 50, rationale: 'hold' };
}

function openLongDecision(sizePct = 50, maxSlippageBps = 100): PerpTradeDecision {
  return { action: 'OPEN_LONG', market: 'BTC/USD', confidence: 0.8, sizePct, maxSlippageBps, rationale: 'buy long' };
}

function openShortDecision(sizePct = 50, maxSlippageBps = 100): PerpTradeDecision {
  return { action: 'OPEN_SHORT', market: 'BTC/USD', confidence: 0.8, sizePct, maxSlippageBps, rationale: 'sell short' };
}

function closeLongDecision(maxSlippageBps = 100): PerpTradeDecision {
  return { action: 'CLOSE_LONG', market: 'BTC/USD', confidence: 0.8, sizePct: 0, maxSlippageBps, rationale: 'close long' };
}

function closeShortDecision(maxSlippageBps = 100): PerpTradeDecision {
  return { action: 'CLOSE_SHORT', market: 'BTC/USD', confidence: 0.8, sizePct: 0, maxSlippageBps, rationale: 'close short' };
}

describe('planPerpExecution — skip cases', () => {
  it('returns skip:hold when action is HOLD', () => {
    const result = planPerpExecution({
      decision: holdDecision(),
      currentState: 'FLAT',
      vaultBalances: { [COLLATERAL_TOKEN]: 1000n * WAD },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
    });
    expect(result).toEqual({ skip: 'hold' });
  });

  it('returns skip:illegal_transition for OPEN_LONG when already LONG', () => {
    const result = planPerpExecution({
      decision: openLongDecision(),
      currentState: 'LONG',
      vaultBalances: { [COLLATERAL_TOKEN]: 1000n * WAD },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
    });
    expect(result).toEqual({ skip: 'illegal_transition' });
  });

  it('returns skip:illegal_transition for CLOSE_LONG when FLAT', () => {
    const result = planPerpExecution({
      decision: closeLongDecision(),
      currentState: 'FLAT',
      vaultBalances: { [COLLATERAL_TOKEN]: 1000n * WAD },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
    });
    expect(result).toEqual({ skip: 'illegal_transition' });
  });

  it('returns skip:no_balance for OPEN_LONG with zero collateral balance', () => {
    const result = planPerpExecution({
      decision: openLongDecision(),
      currentState: 'FLAT',
      vaultBalances: { [COLLATERAL_TOKEN]: 0n },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
    });
    expect(result).toEqual({ skip: 'no_balance' });
  });

  it('returns skip:missing_position_id for CLOSE actions without ID', () => {
    const result = planPerpExecution({
      decision: closeLongDecision(),
      currentState: 'LONG',
      vaultBalances: { [COLLATERAL_TOKEN]: 1000n * WAD },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
    });
    expect(result).toEqual({ skip: 'missing_position_id' });
  });
});

describe('planPerpExecution — OPEN actions', () => {
  const collateralBalance = 1000n * WAD;
  const inputs: PerpExecutionPlanInput = {
    decision: openLongDecision(50, 100), // 50% of balance, 100 bps slippage
    currentState: 'FLAT',
    vaultBalances: { [COLLATERAL_TOKEN]: collateralBalance },
    marketPriceUsd: MARKET_PRICE,
    agentConfig: baseConfig,
  };

  it('handles OPEN_LONG correctly', () => {
    const result = planPerpExecution(inputs);
    if ('skip' in result) throw new Error('unexpected skip');
    expect(result.action).toBe('OPEN_LONG');
    expect(result.isLong).toBe(true);
    expect(result.collateralAmount).toBe(500n * WAD); // 50% of 1000
    expect(result.leverage).toBe(1n);
  });

  it('handles OPEN_SHORT correctly', () => {
    const result = planPerpExecution({
      ...inputs,
      decision: openShortDecision(20, 50),
    });
    if ('skip' in result) throw new Error('unexpected skip');
    expect(result.action).toBe('OPEN_SHORT');
    expect(result.isLong).toBe(false);
    expect(result.collateralAmount).toBe(200n * WAD); // 20% of 1000
    expect(result.leverage).toBe(1n);
  });
});

describe('planPerpExecution — CLOSE actions', () => {
  const collateralBalance = 1000n * WAD;
  
  it('handles CLOSE_LONG correctly', () => {
    const result = planPerpExecution({
      decision: closeLongDecision(100),
      currentState: 'LONG',
      vaultBalances: { [COLLATERAL_TOKEN]: collateralBalance },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
      openPerpPositionId: 42n,
    });
    if ('skip' in result) throw new Error('unexpected skip');
    expect(result.action).toBe('CLOSE_LONG');
    expect(result.perpPositionId).toBe(42n);
  });

  it('handles CLOSE_SHORT correctly', () => {
    const result = planPerpExecution({
      decision: closeShortDecision(50),
      currentState: 'SHORT',
      vaultBalances: { [COLLATERAL_TOKEN]: collateralBalance },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
      openPerpPositionId: 43n,
    });
    if ('skip' in result) throw new Error('unexpected skip');
    expect(result.action).toBe('CLOSE_SHORT');
    expect(result.perpPositionId).toBe(43n);
  });
});
