import { describe, it, expect } from 'vitest';
import { planSpotExecution, type PlanInputs } from '../src/agents/execution-planner';
import type { SpotTradeDecision } from '@something-in-loop/shared';
import { AgentConfigSchema } from '@something-in-loop/shared';
import { DEX_REGISTRY } from '../src/agents/dex-registry';
import { toFunctionSelector } from 'viem';

const BASE_TOKEN = '0x1111111111111111111111111111111111111111' as const;
const QUOTE_TOKEN = '0x2222222222222222222222222222222222222222' as const;

const baseConfig = AgentConfigSchema.parse({
  name: 'test',
  pairs: ['INIT/USDC'],
  chain: 'initia',
  dexPlatformId: 'initia-router-v1',
  allowedTradeTokens: [BASE_TOKEN, QUOTE_TOKEN],
});

const MARKET_PRICE = 2.5; // 1 base token = $2.50
const WAD = 10n ** 18n;

function holdDecision(): SpotTradeDecision {
  return { action: 'HOLD', market: 'INIT/USDC', confidence: 0.5, sizePct: 0, maxSlippageBps: 50, rationale: 'hold' };
}

function openLongDecision(sizePct = 50, maxSlippageBps = 100): SpotTradeDecision {
  return { action: 'OPEN_LONG', market: 'INIT/USDC', confidence: 0.8, sizePct, maxSlippageBps, rationale: 'buy' };
}

function closeLongDecision(maxSlippageBps = 100): SpotTradeDecision {
  return { action: 'CLOSE_LONG', market: 'INIT/USDC', confidence: 0.8, sizePct: 0, maxSlippageBps, rationale: 'sell' };
}

describe('planSpotExecution — skip cases', () => {
  it('returns skip:HOLD when action is HOLD', () => {
    const result = planSpotExecution({
      decision: holdDecision(),
      currentState: 'FLAT',
      vaultBalances: { [QUOTE_TOKEN]: 1000n * WAD },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
    });
    expect(result).toEqual({ skip: 'HOLD' });
  });

  it('returns skip:illegal_transition for OPEN_LONG when already LONG', () => {
    const result = planSpotExecution({
      decision: openLongDecision(),
      currentState: 'LONG',
      vaultBalances: { [QUOTE_TOKEN]: 1000n * WAD },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
    });
    expect(result).toEqual({ skip: 'illegal_transition' });
  });

  it('returns skip:illegal_transition for CLOSE_LONG when FLAT', () => {
    const result = planSpotExecution({
      decision: closeLongDecision(),
      currentState: 'FLAT',
      vaultBalances: { [BASE_TOKEN]: 100n * WAD },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
    });
    expect(result).toEqual({ skip: 'illegal_transition' });
  });

  it('returns skip:no_balance for OPEN_LONG with zero quote balance', () => {
    const result = planSpotExecution({
      decision: openLongDecision(),
      currentState: 'FLAT',
      vaultBalances: { [QUOTE_TOKEN]: 0n },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
    });
    expect(result).toEqual({ skip: 'no_balance' });
  });

  it('returns skip:no_balance for CLOSE_LONG with zero base balance', () => {
    const result = planSpotExecution({
      decision: closeLongDecision(),
      currentState: 'LONG',
      vaultBalances: { [BASE_TOKEN]: 0n },
      marketPriceUsd: MARKET_PRICE,
      agentConfig: baseConfig,
    });
    expect(result).toEqual({ skip: 'no_balance' });
  });
});

describe('planSpotExecution — OPEN_LONG', () => {
  const quoteBalance = 1000n * WAD; // 1000 tokens
  const inputs: PlanInputs = {
    decision: openLongDecision(50, 100), // 50% of balance, 100 bps slippage
    currentState: 'FLAT',
    vaultBalances: { [QUOTE_TOKEN]: quoteBalance },
    marketPriceUsd: MARKET_PRICE,
    agentConfig: baseConfig,
  };

  it('sets correct token directions', () => {
    const result = planSpotExecution(inputs);
    if ('skip' in result) throw new Error('unexpected skip');
    expect(result.inputTokenAddress).toBe(QUOTE_TOKEN);
    expect(result.outputTokenAddress).toBe(BASE_TOKEN);
  });

  it('maxInputAmount is sizePct of quote balance', () => {
    const result = planSpotExecution(inputs);
    if ('skip' in result) throw new Error('unexpected skip');
    // 50% of 1000 * WAD = 500 * WAD
    expect(result.maxInputAmount).toBe(500n * WAD);
  });

  it('minOutputAmount accounts for slippage', () => {
    const result = planSpotExecution(inputs);
    if ('skip' in result) throw new Error('unexpected skip');
    // idealBaseOut = (500 * WAD * WAD) / (2.5 * WAD) = 200 * WAD
    // minOut = 200 * WAD * (10000 - 100) / 10000 = 198 * WAD
    const idealOut = (500n * WAD * WAD) / BigInt(Math.floor(MARKET_PRICE * 1e18));
    const expectedMin = (idealOut * 9900n) / 10_000n;
    expect(result.minOutputAmount).toBe(expectedMin);
  });

  it('tradeNotionalValueWei equals maxInputAmount for OPEN_LONG', () => {
    const result = planSpotExecution(inputs);
    if ('skip' in result) throw new Error('unexpected skip');
    expect(result.tradeNotionalValueWei).toBe(result.maxInputAmount);
  });

  it('executionDeadline is approximately now + 60s', () => {
    const before = BigInt(Math.floor(Date.now() / 1000));
    const result = planSpotExecution(inputs);
    const after = BigInt(Math.floor(Date.now() / 1000));
    if ('skip' in result) throw new Error('unexpected skip');
    expect(result.executionDeadline).toBeGreaterThanOrEqual(before + 60n);
    expect(result.executionDeadline).toBeLessThanOrEqual(after + 60n);
  });

  it('dexCallData starts with the correct 4-byte selector', () => {
    const result = planSpotExecution(inputs);
    if ('skip' in result) throw new Error('unexpected skip');
    const platform = DEX_REGISTRY['initia-router-v1'];
    expect(result.dexCallData.slice(0, 10)).toBe(platform.dexFunctionSelector);
  });

  it('returns the correct dexPlatformId and addresses from registry', () => {
    const result = planSpotExecution(inputs);
    if ('skip' in result) throw new Error('unexpected skip');
    const platform = DEX_REGISTRY['initia-router-v1'];
    expect(result.dexPlatformId).toBe('initia-router-v1');
    expect(result.dexContractAddress).toBe(platform.dexContractAddress);
    expect(result.dexFunctionSelector).toBe(platform.dexFunctionSelector);
  });
});

describe('planSpotExecution — CLOSE_LONG', () => {
  const baseBalance = 200n * WAD; // 200 base tokens
  const inputs: PlanInputs = {
    decision: closeLongDecision(200), // 200 bps slippage
    currentState: 'LONG',
    vaultBalances: { [BASE_TOKEN]: baseBalance },
    marketPriceUsd: MARKET_PRICE,
    agentConfig: baseConfig,
  };

  it('sets correct token directions', () => {
    const result = planSpotExecution(inputs);
    if ('skip' in result) throw new Error('unexpected skip');
    expect(result.inputTokenAddress).toBe(BASE_TOKEN);
    expect(result.outputTokenAddress).toBe(QUOTE_TOKEN);
  });

  it('maxInputAmount equals full base balance', () => {
    const result = planSpotExecution(inputs);
    if ('skip' in result) throw new Error('unexpected skip');
    expect(result.maxInputAmount).toBe(baseBalance);
  });

  it('tradeNotionalValueWei equals ideal quote output (pre-slippage)', () => {
    const result = planSpotExecution(inputs);
    if ('skip' in result) throw new Error('unexpected skip');
    // idealQuoteOut = (200 * WAD * priceWad) / WAD = 200 * MARKET_PRICE * WAD
    const priceWad = BigInt(Math.floor(MARKET_PRICE * 1e18));
    const expectedNotional = (baseBalance * priceWad) / WAD;
    expect(result.tradeNotionalValueWei).toBe(expectedNotional);
  });

  it('minOutputAmount applies slippage to ideal quote output', () => {
    const result = planSpotExecution(inputs);
    if ('skip' in result) throw new Error('unexpected skip');
    const priceWad = BigInt(Math.floor(MARKET_PRICE * 1e18));
    const idealOut = (baseBalance * priceWad) / WAD;
    const expectedMin = (idealOut * 9800n) / 10_000n; // 200 bps
    expect(result.minOutputAmount).toBe(expectedMin);
  });
});
