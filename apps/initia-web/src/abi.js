export const AGENT_ABI = [
  {
    type: 'function', name: 'createAgent',
    inputs: [{ name: 'metadata', type: 'bytes' }],
    outputs: [], stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'deposit',
    inputs: [], outputs: [], stateMutability: 'payable',
  },
  {
    type: 'function', name: 'withdraw',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [], stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'executeTick',
    inputs: [], outputs: [], stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'enableAutoSign',
    inputs: [], outputs: [], stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'disableAutoSign',
    inputs: [], outputs: [], stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'getAgent',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [
      { name: 'metadata', type: 'bytes' },
      { name: 'balance', type: 'uint256' },
      { name: 'exists', type: 'bool' },
      { name: 'autoSignEnabled', type: 'bool' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function', name: 'hasAgent',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  { type: 'event', name: 'AgentCreated', inputs: [{ name: 'owner', type: 'address', indexed: true }, { name: 'metadata', type: 'bytes', indexed: false }, { name: 'timestamp', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Deposited', inputs: [{ name: 'owner', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'newBalance', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Withdrawn', inputs: [{ name: 'owner', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'newBalance', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'TickExecuted', inputs: [{ name: 'owner', type: 'address', indexed: true }, { name: 'timestamp', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'AutoSignEnabled', inputs: [{ name: 'owner', type: 'address', indexed: true }] },
  { type: 'event', name: 'AutoSignDisabled', inputs: [{ name: 'owner', type: 'address', indexed: true }] },
]
