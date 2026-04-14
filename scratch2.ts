import { createPublicClient, http } from 'viem';
import { minievm } from 'viem/chains';
import { AGENT_ABI } from './apps/web/utils/initia/bridge/abi';

const evmChain = {
    id: 11211, // or whatever
    name: 'Minievm',
    nativeCurrency: { name: 'GAS', symbol: 'GAS', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.testnet.initia.xyz'] } },
} as any;

const client = createPublicClient({
  chain: evmChain,
  transport: http()
});
console.log('Return type when using AGENT_ABI getAgent:');
// Just checking type structure in typescript
