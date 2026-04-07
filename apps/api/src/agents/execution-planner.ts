import { encodeFunctionData } from 'viem';
import type { SpotTradeDecision, AgentConfigOutput } from '@something-in-loop/shared';
import { isLegalAction, type SpotPositionState } from './spot-state-machine.js';
import { DEX_REGISTRY } from './dex-registry.js';

/** All amounts are in the token's native smallest unit (analogous to wei for 18-decimal tokens). */
export interface SpotExecutionPlan {
  dexPlatformId: string;
  dexContractAddress: `0x${string}`;
  dexFunctionSelector: `0x${string}`;
  inputTokenAddress: `0x${string}`;
  outputTokenAddress: `0x${string}`;
  maxInputAmount: bigint;
  minOutputAmount: bigint;
  tradeNotionalValueWei: bigint;
  executionDeadline: bigint; // unix seconds
  dexCallData: `0x${string}`;
}

export interface PlanInputs {
  decision: SpotTradeDecision;
  currentState: SpotPositionState;
  /** token address → balance in the token's native units */
  vaultBalances: Record<string, bigint>;
  /** USD price of the base token (e.g. price of INIT in USD) */
  marketPriceUsd: number;
  agentConfig: AgentConfigOutput;
}

const DEADLINE_SECONDS = 60n;
/** Fixed-point scale: 1e18, used for price arithmetic (assumes 18-decimal tokens). */
const WAD = 10n ** 18n;
/** Slippage denominator */
const BPS_DENOM = 10_000n;

/**
 * Pure deterministic planner: converts validated LLM intent into a concrete
 * SpotExecutionPlan ready for submission to the contract's executeTokenTrade.
 *
 * Assumptions (V1 hackathon scope):
 * - Both tokens are 18-decimal (or the caller normalises vaultBalances accordingly).
 * - agentConfig.allowedTradeTokens[0] = base token, [1] = quote token (BASE/QUOTE order).
 * - Quote token is 1:1 USD for notional accounting purposes.
 */
export function planSpotExecution(
  inputs: PlanInputs,
): SpotExecutionPlan | { skip: 'HOLD' | 'illegal_transition' | 'no_balance' } {
  const { decision, currentState, vaultBalances, marketPriceUsd, agentConfig } = inputs;

  if (decision.action === 'HOLD') return { skip: 'HOLD' };

  if (!isLegalAction(currentState, decision.action)) {
    return { skip: 'illegal_transition' };
  }

  const dexPlatformId =
    agentConfig.dexPlatformId ?? agentConfig.dexes?.[0] ?? 'initia-router-v1';
  const platform = DEX_REGISTRY[dexPlatformId];
  if (!platform) throw new Error(`Unknown DEX platform: ${dexPlatformId}`);

  const tokens = agentConfig.allowedTradeTokens ?? [];
  if (tokens.length < 2) {
    throw new Error(
      'agentConfig.allowedTradeTokens must have at least 2 entries ([baseToken, quoteToken])',
    );
  }

  const baseTokenAddress = tokens[0] as `0x${string}`;
  const quoteTokenAddress = tokens[1] as `0x${string}`;

  const quoteBalance = vaultBalances[quoteTokenAddress] ?? 0n;
  const baseBalance = vaultBalances[baseTokenAddress] ?? 0n;

  // Price in 18-decimal fixed-point (WAD units per quote)
  const priceWad = BigInt(Math.floor(marketPriceUsd * 1e18));

  let inputTokenAddress: `0x${string}`;
  let outputTokenAddress: `0x${string}`;
  let maxInputAmount: bigint;
  let idealOutput: bigint;
  let tradeNotionalValueWei: bigint;

  if (decision.action === 'OPEN_LONG') {
    // Spend quote → receive base
    inputTokenAddress = quoteTokenAddress;
    outputTokenAddress = baseTokenAddress;

    maxInputAmount = (quoteBalance * BigInt(Math.floor(decision.sizePct))) / 100n;
    if (maxInputAmount === 0n) return { skip: 'no_balance' };

    // idealBaseOut = quoteIn / price = (quoteIn * WAD) / priceWad
    idealOutput = (maxInputAmount * WAD) / priceWad;

    // Notional = quote amount spent (same units as on-chain limit)
    tradeNotionalValueWei = maxInputAmount;
  } else {
    // CLOSE_LONG: spend all base → receive quote
    inputTokenAddress = baseTokenAddress;
    outputTokenAddress = quoteTokenAddress;

    maxInputAmount = baseBalance;
    if (maxInputAmount === 0n) return { skip: 'no_balance' };

    // idealQuoteOut = baseIn * price = (baseIn * priceWad) / WAD
    idealOutput = (maxInputAmount * priceWad) / WAD;

    // Notional = expected quote proceeds (pre-slippage)
    tradeNotionalValueWei = idealOutput;
  }

  const minOutputAmount =
    (idealOutput * (BPS_DENOM - BigInt(decision.maxSlippageBps))) / BPS_DENOM;

  const executionDeadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_SECONDS;

  const swapArgs = platform.buildSwapArgs({
    inputTokenAddress,
    outputTokenAddress,
    maxInputAmount,
    minOutputAmount,
  });

  const dexCallData = encodeFunctionData({
    abi: [platform.swapFunctionAbi],
    functionName: platform.swapFunctionAbi.name,
    args: swapArgs as unknown[],
  }) as `0x${string}`;

  return {
    dexPlatformId: platform.dexPlatformId,
    dexContractAddress: platform.dexContractAddress,
    dexFunctionSelector: platform.dexFunctionSelector,
    inputTokenAddress,
    outputTokenAddress,
    maxInputAmount,
    minOutputAmount,
    tradeNotionalValueWei,
    executionDeadline,
    dexCallData,
  };
}
