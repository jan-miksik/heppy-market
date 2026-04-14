export const AGENT_ABI = [
  {
    type: 'event',
    name: 'AgentCreated',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'metadata', type: 'bytes', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'createAgent',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'metadata', type: 'bytes' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'createAgentWithDelegatedExecution',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'metadata', type: 'bytes' },
      { name: 'delegatedExecutionEnabled', type: 'bool' },
    ],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerAgentIds',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'agentIds', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'getAgent',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      { name: 'owner', type: 'address' },
      { name: 'metadata', type: 'bytes' },
      { name: 'nativeBalance', type: 'uint256' },
      { name: 'exists', type: 'bool' },
      { name: 'delegatedExecutionEnabled', type: 'bool' },
      { name: 'paused', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'depositNative',
    stateMutability: 'payable',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdrawNative',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'depositToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdrawToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'tokenBalance',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setDelegatedExecutionEnabled',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'enabled', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setMaxLeverage',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'maxLev', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'executeTick',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setAllowedPerpDex',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'perpDexAddress', type: 'address' },
      { name: 'allowed', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isPerpDexAllowed',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'perpDexAddress', type: 'address' },
    ],
    outputs: [{ name: 'allowed', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'setDelegatedExecutorApproval',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'executor', type: 'address' },
      { name: 'canTick', type: 'bool' },
      { name: 'canTrade', type: 'bool' },
      { name: 'maxTradeNotionalValueWei', type: 'uint128' },
      { name: 'dailyTradeNotionalLimitWei', type: 'uint128' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getDelegatedExecutorApproval',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'executor', type: 'address' },
    ],
    outputs: [
      { name: 'canTick', type: 'bool' },
      { name: 'canTrade', type: 'bool' },
      { name: 'maxTradeNotionalValueWei', type: 'uint128' },
      { name: 'dailyTradeNotionalLimitWei', type: 'uint128' },
      { name: 'dayIndex', type: 'uint64' },
      { name: 'notionalSpentTodayWei', type: 'uint128' },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'ok', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const;

export const IUSD_FAUCET_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [{ name: 'mintedAmount', type: 'uint256' }],
  },
] as const;
