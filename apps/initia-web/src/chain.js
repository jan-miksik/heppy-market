import { TESTNET } from '@initia/interwovenkit-react'
import { defineChain } from 'viem'

export const CHAIN_ID = 'pillow-rollup'
export const EVM_CHAIN_ID = 2178983797612220
export const NATIVE_DENOM = import.meta.env.VITE_NATIVE_DENOM ?? 'GAS'
export const BRIDGE_SRC_CHAIN_ID = import.meta.env.VITE_BRIDGE_SRC_CHAIN_ID ?? 'initiation-2'
export const BRIDGE_SRC_DENOM = import.meta.env.VITE_BRIDGE_SRC_DENOM ?? 'uinit'
// Allow env-var overrides for production deployment (e.g. public ngrok/cloudflare tunnel URL)
export const EVM_RPC = import.meta.env.VITE_EVM_RPC ?? 'http://localhost:8545'
export const REST_URL = import.meta.env.VITE_REST_URL ?? 'http://localhost:1317'
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? 'http://localhost:26657'
export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS ?? '0x286D7241779329DB8c34995d3e8D3796e0d685D7'

// InterwovenKit customChain — must include all mandatory fields
export const customChain = {
  chain_id: CHAIN_ID,
  chain_name: 'Pillow Rollup',
  network_type: 'testnet',
  bech32_prefix: 'init',
  apis: {
    rpc: [{ address: RPC_URL }],
    rest: [{ address: REST_URL }],
    indexer: [{ address: import.meta.env.VITE_INDEXER_URL ?? 'http://localhost:8080' }],
    'json-rpc': [{ address: EVM_RPC }],
  },
  fees: {
    fee_tokens: [
      { denom: NATIVE_DENOM, fixed_min_gas_price: 0, low_gas_price: 0, average_gas_price: 0, high_gas_price: 0 },
    ],
  },
  staking: { staking_tokens: [{ denom: NATIVE_DENOM }] },
  native_assets: [{ denom: NATIVE_DENOM, name: NATIVE_DENOM, symbol: NATIVE_DENOM, decimals: 18 }],
  metadata: { is_l1: false, minitia: { type: 'minievm' } },
}

// Viem chain definition for eth_call reads
export const pillowRollupViem = defineChain({
  id: EVM_CHAIN_ID,
  name: 'Pillow Rollup',
  nativeCurrency: { name: NATIVE_DENOM, symbol: NATIVE_DENOM, decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
})

export { TESTNET }
