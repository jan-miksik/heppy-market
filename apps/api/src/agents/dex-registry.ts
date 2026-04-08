import type { AbiFunction } from 'viem';

export interface PerpPlatform {
  perpDexPlatformId: string;
  perpDexAddress: `0x${string}`;
  openPositionAbi: AbiFunction;
  closePositionAbi: AbiFunction;
}

/**
 * Mock Perp DEX V1 — uses the MockPerpDEX contract deployed alongside Agent.sol.
 * Replace the address with the deployed MockPerpDEX address from env.
 */
const MOCK_PERP_DEX_ADDRESS: `0x${string}` =
  (process.env.MOCK_PERP_DEX_ADDRESS as `0x${string}`) ??
  '0x0000000000000000000000000000000000000000';

const openPositionAbi: AbiFunction = {
  type: 'function',
  name: 'executePerpOpen',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'agentId', type: 'uint256' },
    { name: 'perpDexAddress', type: 'address' },
    { name: 'market', type: 'bytes32' },
    { name: 'isLong', type: 'bool' },
    { name: 'collateralAmount', type: 'uint256' },
    { name: 'leverage', type: 'uint256' },
    { name: 'acceptablePrice', type: 'uint256' },
    { name: 'executionDeadline', type: 'uint256' },
  ],
  outputs: [{ name: 'perpPositionId', type: 'uint256' }],
};

const closePositionAbi: AbiFunction = {
  type: 'function',
  name: 'executePerpClose',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'agentId', type: 'uint256' },
    { name: 'perpDexAddress', type: 'address' },
    { name: 'perpPositionId', type: 'uint256' },
    { name: 'acceptablePrice', type: 'uint256' },
    { name: 'executionDeadline', type: 'uint256' },
  ],
  outputs: [{ name: 'pnl', type: 'int256' }],
};

const mockPerpV1: PerpPlatform = {
  perpDexPlatformId: 'mock-perp-v1',
  perpDexAddress: MOCK_PERP_DEX_ADDRESS,
  openPositionAbi,
  closePositionAbi,
};

export const PERP_DEX_REGISTRY: Record<string, PerpPlatform> = {
  [mockPerpV1.perpDexPlatformId]: mockPerpV1,
};

/**
 * Returns the perp DEX address for allowlisting on-chain via setAllowedPerpDex.
 */
export function getPerpDexAddressForPlatform(platformId: string): `0x${string}` | null {
  const platform = PERP_DEX_REGISTRY[platformId];
  return platform?.perpDexAddress ?? null;
}
