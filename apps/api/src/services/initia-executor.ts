import { createPublicClient, createWalletClient, defineChain, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Logger } from '../lib/logger.js';
import type { Env } from '../types/env.js';
import type { PerpExecutionPlan } from '../agents/execution-planner.js';

const AGENT_EXECUTOR_ABI = [
  {
    type: 'function',
    name: 'executeTick',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [],
  },
  {
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
  },
  {
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
  },
] as const;

export type InitiaTickExecutionResult = {
  executed: boolean;
  reason?: string;
  txHash?: string;
};

export type PerpExecutionResult = {
  executed: boolean;
  reason?: string;
  txHash?: string;
  perpPositionId?: string;
  pnl?: string;
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

function resolveChainAndClients(env: Env, syncState: Record<string, unknown> | null) {
  const contractAddress = normalizeAddress(syncState?.contractAddress ?? env.INITIA_AGENT_CONTRACT_ADDRESS);
  if (!contractAddress) return null;

  const rpcUrl = typeof env.INITIA_EVM_RPC === 'string' ? env.INITIA_EVM_RPC.trim() : '';
  if (!rpcUrl) return null;

  const privateKey = normalizePrivateKey(env.INITIA_EXECUTOR_PRIVATE_KEY);
  if (!privateKey) return null;

  const parsedChainId = Number.parseInt(String(env.INITIA_EVM_CHAIN_ID ?? '2178983797612220'), 10);
  const chainId = Number.isFinite(parsedChainId) && parsedChainId > 0 ? parsedChainId : 2178983797612220;

  const chain = defineChain({
    id: chainId,
    name: 'Initia Appchain',
    nativeCurrency: { name: 'GAS', symbol: 'GAS', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  return { contractAddress, account, publicClient, walletClient };
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

  const ctx = resolveChainAndClients(env, syncState);
  if (!ctx) return { executed: false, reason: 'missing_chain_config' };

  try {
    const simulated = await ctx.publicClient.simulateContract({
      account: ctx.account,
      address: ctx.contractAddress,
      abi: AGENT_EXECUTOR_ABI,
      functionName: 'executeTick',
      args: [onchainAgentId],
    });
    const txHash = await ctx.walletClient.writeContract(simulated.request);

    log.info('initia_tick_submitted', {
      agent: agentId,
      onchain_agent_id: onchainAgentId.toString(),
      tx_hash: txHash,
      executor: ctx.account.address.toLowerCase(),
    });
    return { executed: true, txHash };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    log.warn('initia_tick_failed', { agent: agentId, error: message });
    return { executed: false, reason: 'tx_failed' };
  }
}

/**
 * Submit a PerpExecutionPlan to the chain via the Agent contract.
 */
export async function submitPerpExecutionPlan(params: {
  plan: PerpExecutionPlan;
  env: Env;
  log: Logger;
  agentId: string;
  syncState: Record<string, unknown> | null;
}): Promise<PerpExecutionResult> {
  const { plan, env, log, agentId, syncState } = params;

  if (!syncState) return { executed: false, reason: 'missing_sync_state' };
  if (syncState.executorAuthorized !== true) return { executed: false, reason: 'executor_not_authorized' };

  const onchainAgentId = parsePositiveBigInt(syncState.onchainAgentId);
  if (!onchainAgentId) return { executed: false, reason: 'missing_onchain_agent_id' };

  const ctx = resolveChainAndClients(env, syncState);
  if (!ctx) return { executed: false, reason: 'missing_chain_config' };

  const isOpen = plan.action === 'OPEN_LONG' || plan.action === 'OPEN_SHORT';

  try {
    if (isOpen) {
      const simulated = await ctx.publicClient.simulateContract({
        account: ctx.account,
        address: ctx.contractAddress,
        abi: AGENT_EXECUTOR_ABI,
        functionName: 'executePerpOpen',
        args: [
          onchainAgentId,
          plan.perpDexAddress,
          plan.marketHash as `0x${string}`,
          plan.isLong,
          plan.collateralAmount,
          plan.leverage,
          plan.acceptablePrice,
          plan.executionDeadline,
        ],
      });
      const txHash = await ctx.walletClient.writeContract(simulated.request);
      const perpPositionId = simulated.result;

      log.info('perp_open_submitted', {
        agent: agentId,
        action: plan.action,
        market: plan.market,
        collateral: plan.collateralAmount.toString(),
        leverage: plan.leverage.toString(),
        perp_position_id: perpPositionId?.toString(),
        tx_hash: txHash,
      });

      return {
        executed: true,
        txHash,
        perpPositionId: perpPositionId?.toString(),
      };
    } else {
      // Close position
      if (!plan.perpPositionId) return { executed: false, reason: 'missing_position_id' };

      const simulated = await ctx.publicClient.simulateContract({
        account: ctx.account,
        address: ctx.contractAddress,
        abi: AGENT_EXECUTOR_ABI,
        functionName: 'executePerpClose',
        args: [
          onchainAgentId,
          plan.perpDexAddress,
          plan.perpPositionId,
          plan.acceptablePrice,
          plan.executionDeadline,
        ],
      });
      const txHash = await ctx.walletClient.writeContract(simulated.request);
      const pnl = simulated.result;

      log.info('perp_close_submitted', {
        agent: agentId,
        action: plan.action,
        perp_position_id: plan.perpPositionId.toString(),
        pnl: pnl?.toString(),
        tx_hash: txHash,
      });

      return {
        executed: true,
        txHash,
        pnl: pnl?.toString(),
      };
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    log.warn('perp_execution_failed', {
      agent: agentId,
      action: plan.action,
      error: message,
    });
    return { executed: false, reason: 'tx_failed' };
  }
}

