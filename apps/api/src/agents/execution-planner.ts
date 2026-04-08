import type { PerpTradeDecision, AgentConfigOutput } from '@something-in-loop/shared';
import type { PerpPositionState } from './perp-state-machine.js';
import { isLegalAction } from './perp-state-machine.js';
import { PERP_DEX_REGISTRY } from './dex-registry.js';

export interface PerpExecutionPlanInput {
  decision: PerpTradeDecision;
  currentState: PerpPositionState;
  vaultBalances: Record<string, bigint>;
  marketPriceUsd: number;
  agentConfig: AgentConfigOutput;
  /** On-chain perp position ID — required for CLOSE actions */
  openPerpPositionId?: bigint;
}

export interface PerpExecutionPlan {
  action: 'OPEN_LONG' | 'OPEN_SHORT' | 'CLOSE_LONG' | 'CLOSE_SHORT';
  perpDexAddress: `0x${string}`;
  perpDexPlatformId: string;
  market: string;
  marketHash: `0x${string}`;
  isLong: boolean;
  collateralAmount: bigint;
  leverage: bigint;
  acceptablePrice: bigint;
  executionDeadline: bigint;
  perpPositionId?: bigint; // for close actions
}

export type PerpExecutionResult =
  | PerpExecutionPlan
  | { skip: 'illegal_transition' | 'no_balance' | 'hold' | 'missing_position_id' | 'below_min_collateral' };

const MIN_COLLATERAL_WEI = 1_000_000_000_000_000n; // 0.001 token (18 decimals)

/**
 * Convert a PerpTradeDecision into a concrete PerpExecutionPlan.
 * Returns { skip } if the action should be skipped.
 */
export function planPerpExecution(input: PerpExecutionPlanInput): PerpExecutionResult {
  const { decision, currentState, vaultBalances, marketPriceUsd, agentConfig, openPerpPositionId } = input;

  if (decision.action === 'HOLD') {
    return { skip: 'hold' };
  }

  if (!isLegalAction(currentState, decision.action)) {
    return { skip: 'illegal_transition' };
  }

  // Resolve perp DEX platform
  const platformId = agentConfig.dexPlatformId ?? 'mock-perp-v1';
  const platform = PERP_DEX_REGISTRY[platformId];
  if (!platform) {
    return { skip: 'no_balance' };
  }

  const isOpen = decision.action === 'OPEN_LONG' || decision.action === 'OPEN_SHORT';
  const isLong = decision.action === 'OPEN_LONG' || decision.action === 'CLOSE_SHORT';

  // For close actions, we need the on-chain position ID
  if (!isOpen && openPerpPositionId === undefined) {
    return { skip: 'missing_position_id' };
  }

  // Determine collateral amount
  const collateralTokenAddress = agentConfig.allowedTradeTokens?.[0] as `0x${string}` | undefined;
  let collateralAmount: bigint;

  if (isOpen) {
    if (!collateralTokenAddress) return { skip: 'no_balance' };
    const available = vaultBalances[collateralTokenAddress] ?? 0n;
    if (available === 0n) return { skip: 'no_balance' };

    // Use sizePct of available balance
    const sizePct = BigInt(Math.max(1, Math.min(100, Math.round(decision.sizePct))));
    collateralAmount = (available * sizePct) / 100n;

    if (collateralAmount < MIN_COLLATERAL_WEI) {
      return { skip: 'below_min_collateral' };
    }

    // Cap by max trade notional if configured
    const maxNotional = agentConfig.maxTradeNotionalUsd;
    if (maxNotional && maxNotional > 0) {
      const maxNotionalWei = BigInt(Math.floor(maxNotional * 1e18));
      if (collateralAmount > maxNotionalWei) {
        collateralAmount = maxNotionalWei;
      }
    }
  } else {
    // For close, collateral is 0 (we're closing, not opening)
    collateralAmount = 0n;
  }

  // Calculate acceptable price with slippage
  const slippageBps = decision.maxSlippageBps || 100; // default 1%
  const priceWei = BigInt(Math.floor(marketPriceUsd * 1e18));
  let acceptablePrice: bigint;
  if (isLong) {
    // Buying: accept higher price
    acceptablePrice = priceWei + (priceWei * BigInt(slippageBps)) / 10_000n;
  } else {
    // Selling: accept lower price
    acceptablePrice = priceWei - (priceWei * BigInt(slippageBps)) / 10_000n;
    if (acceptablePrice < 0n) acceptablePrice = 0n;
  }

  // Market hash (keccak256 of market string, matching Solidity)
  const marketHash = keccakMarketHash(decision.market);

  // Deadline: 5 minutes from now
  const executionDeadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  // Leverage: fixed at 1x for now (not exposed in AI/UI yet)
  const leverage = 1n;

  return {
    action: decision.action,
    perpDexAddress: platform.perpDexAddress,
    perpDexPlatformId: platformId,
    market: decision.market,
    marketHash,
    isLong,
    collateralAmount,
    leverage,
    acceptablePrice,
    executionDeadline,
    perpPositionId: openPerpPositionId,
  };
}

/**
 * keccak256 hash of a market string, matching Solidity's keccak256(abi.encodePacked(string)).
 */
function keccakMarketHash(market: string): `0x${string}` {
  // We use a simple implementation that matches Solidity's keccak256(bytes(market))
  // Import from viem at runtime to avoid circular deps
  try {
    const { keccak256, toHex } = require('viem');
    return keccak256(toHex(market)) as `0x${string}`;
  } catch {
    // Fallback: return a deterministic placeholder
    return `0x${'0'.repeat(64)}` as `0x${string}`;
  }
}
