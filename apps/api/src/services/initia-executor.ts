import { createPublicClient, createWalletClient, defineChain, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Logger } from '../lib/logger.js';
import type { Env } from '../types/env.js';

const AGENT_EXECUTOR_ABI = [
  {
    type: 'function',
    name: 'executeTick',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [],
  },
] as const;

export type InitiaTickExecutionResult = {
  executed: boolean;
  reason?: string;
  txHash?: string;
};

function normalizeAddress(value: unknown): Address | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(trimmed)) return null;
  return trimmed as Address;
}

function normalizePrivateKey(value: unknown): `0x${string}` | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (/^0x[a-f0-9]{64}$/.test(trimmed)) return trimmed as `0x${string}`;
  if (/^[a-f0-9]{64}$/.test(trimmed)) return `0x${trimmed}` as `0x${string}`;
  return null;
}

function parsePositiveBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    const n = typeof value === 'bigint' ? value : BigInt(String(value));
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

export async function tryExecuteInitiaTick(params: {
  env: Env;
  log: Logger;
  agentId: string;
  syncState: Record<string, unknown> | null;
}): Promise<InitiaTickExecutionResult> {
  const { env, log, agentId, syncState } = params;
  if (!syncState) return { executed: false, reason: 'missing_sync_state' };

  if (syncState.chainOk === false) return { executed: false, reason: 'chain_not_healthy' };
  if (syncState.autoSignEnabled !== true) return { executed: false, reason: 'autosign_disabled' };
  if (syncState.executorAuthorized !== true) return { executed: false, reason: 'executor_not_authorized' };

  const onchainAgentId = parsePositiveBigInt(syncState.onchainAgentId);
  if (!onchainAgentId) return { executed: false, reason: 'missing_onchain_agent_id' };

  const contractAddress = normalizeAddress(syncState.contractAddress ?? env.INITIA_AGENT_CONTRACT_ADDRESS);
  if (!contractAddress) return { executed: false, reason: 'missing_contract_address' };

  const rpcUrl = typeof env.INITIA_EVM_RPC === 'string' ? env.INITIA_EVM_RPC.trim() : '';
  if (!rpcUrl) return { executed: false, reason: 'missing_initia_evm_rpc' };

  const privateKey = normalizePrivateKey(env.INITIA_EXECUTOR_PRIVATE_KEY);
  if (!privateKey) return { executed: false, reason: 'missing_executor_private_key' };

  const parsedChainId = Number.parseInt(String(env.INITIA_EVM_CHAIN_ID ?? '2178983797612220'), 10);
  const chainId = Number.isFinite(parsedChainId) && parsedChainId > 0 ? parsedChainId : 2178983797612220;

  try {
    const chain = defineChain({
      id: chainId,
      name: 'Initia Appchain',
      nativeCurrency: { name: 'GAS', symbol: 'GAS', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(privateKey);
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });

    const simulated = await publicClient.simulateContract({
      account,
      address: contractAddress,
      abi: AGENT_EXECUTOR_ABI,
      functionName: 'executeTick',
      args: [onchainAgentId],
    });
    const txHash = await walletClient.writeContract(simulated.request);

    log.info('initia_tick_submitted', {
      agent: agentId,
      onchain_agent_id: onchainAgentId.toString(),
      tx_hash: txHash,
      executor: account.address.toLowerCase(),
    });

    return { executed: true, txHash };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    log.warn('initia_tick_failed', {
      agent: agentId,
      onchain_agent_id: onchainAgentId.toString(),
      error: message,
    });
    return { executed: false, reason: 'tx_failed' };
  }
}

