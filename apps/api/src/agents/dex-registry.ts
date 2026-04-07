import { toFunctionSelector, type AbiFunction } from 'viem';

export interface DexPlatform {
  dexPlatformId: string;
  dexContractAddress: `0x${string}`;
  swapFunctionAbi: AbiFunction;
  dexFunctionSelector: `0x${string}`;
  buildSwapArgs(plan: {
    inputTokenAddress: `0x${string}`;
    outputTokenAddress: `0x${string}`;
    maxInputAmount: bigint;
    minOutputAmount: bigint;
  }): readonly unknown[];
}

/**
 * Initia EVM testnet router — swapExactTokensForTokens(address,address,uint256,uint256)
 *
 * Replace INITIA_ROUTER_V1_ADDRESS with the deployed address once known.
 */
const INITIA_ROUTER_V1_ADDRESS: `0x${string}` =
  (process.env.INITIA_DEX_ROUTER_ADDRESS as `0x${string}`) ??
  '0x0000000000000000000000000000000000000000';

const swapExactInAbi: AbiFunction = {
  type: 'function',
  name: 'swapExactTokensForTokens',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'amountOutMin', type: 'uint256' },
  ],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
};

const initiaRouterV1: DexPlatform = {
  dexPlatformId: 'initia-router-v1',
  dexContractAddress: INITIA_ROUTER_V1_ADDRESS,
  swapFunctionAbi: swapExactInAbi,
  dexFunctionSelector: toFunctionSelector(swapExactInAbi) as `0x${string}`,
  buildSwapArgs({ inputTokenAddress, outputTokenAddress, maxInputAmount, minOutputAmount }) {
    return [inputTokenAddress, outputTokenAddress, maxInputAmount, minOutputAmount] as const;
  },
};

export const DEX_REGISTRY: Record<string, DexPlatform> = {
  [initiaRouterV1.dexPlatformId]: initiaRouterV1,
};

/**
 * Returns the list of (dexContractAddress, dexFunctionSelector) tuples that
 * need to be allowlisted on-chain via setAllowedDexCall for a given platform.
 */
export function getAllowedDexCallsForPlatform(
  platformId: string
): { dexContractAddress: `0x${string}`; dexFunctionSelector: `0x${string}` }[] {
  const platform = DEX_REGISTRY[platformId];
  if (!platform) return [];
  return [
    {
      dexContractAddress: platform.dexContractAddress,
      dexFunctionSelector: platform.dexFunctionSelector,
    },
  ];
}
