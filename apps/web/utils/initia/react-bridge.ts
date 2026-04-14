import React, { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { injectStyles, useInterwovenKit } from '@initia/interwovenkit-react';
import InterwovenKitStyles from '@initia/interwovenkit-react/styles.js';
import '@initia/interwovenkit-react/styles.css';
import { createPublicClient, decodeEventLog, http as viemHttp } from 'viem';
import type { InitiaBridgeOpenParams, InitiaBridgeState, ProgressStep } from '~/utils/initia/bridge-types';
import { AGENT_ABI } from '~/utils/initia/bridge/abi';
import { dispatchBridgeState, normalizeEvmAddress, normalizeInitiaAddress, normalizeEvmOptionAddress, normalizeBridgeParam } from '~/utils/initia/bridge/helpers';
import { type AgentState, EMPTY_AGENT_STATE } from '~/utils/initia/bridge/state';

// Feature modules
import { BridgeRoot, type InitiaBridgeMountOptions } from '~/features/bridge/provider-bootstrap';
import { useWalletSync } from '~/features/bridge/wallet-sync';
import { useContractActions } from '~/features/bridge/contract-actions';
import { useBridgeEvents } from '~/features/bridge/useBridgeEvents';

injectStyles(InterwovenKitStyles);

function BridgeRuntime(props: { options: InitiaBridgeMountOptions; evmChain: any }) {
  const { options, evmChain } = props;
  const { initiaAddress, address: evmAddress, openConnect, openWallet, openBridge } = useInterwovenKit();

  const normalizedInitiaAddress = useMemo(() => normalizeInitiaAddress(initiaAddress), [initiaAddress]);
  const normalizedEvmAddress = useMemo(() => normalizeEvmAddress(evmAddress), [evmAddress]);
  const initiaAddressRef = useRef(normalizedInitiaAddress);
  initiaAddressRef.current = normalizedInitiaAddress;
  const evmAddressRef = useRef(normalizedEvmAddress);
  evmAddressRef.current = normalizedEvmAddress;

  const publicClient = useMemo(() => createPublicClient({
    chain: evmChain,
    transport: viemHttp(options.evmRpc),
  }), [evmChain, options.evmRpc]);

  const [chainOk, setChainOk] = useState(false);
  const [walletBalanceWei, setWalletBalanceWei] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<AgentState>({ ...EMPTY_AGENT_STATE });
  const agentStateRef = useRef(agentState);
  agentStateRef.current = agentState;

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);

  const fetchLatestAgentId = useCallback(async (owner: `0x${string}`): Promise<bigint | null> => {
    if (!options.contractAddress) return null;
    const ids = await publicClient.readContract({
      address: options.contractAddress as `0x${string}`,
      abi: AGENT_ABI,
      functionName: 'ownerAgentIds',
      args: [owner],
    }) as any;
    return (Array.isArray(ids) && ids.length > 0) ? BigInt(ids[ids.length - 1]) : null;
  }, [options.contractAddress, publicClient]);

  const waitForCreatedAgentId = useCallback(async (txHash: string | null): Promise<bigint | null> => {
    if (!txHash || !options.contractAddress) return null;
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: 45_000 });
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== options.contractAddress.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: AGENT_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === 'AgentCreated') {
            const agentId = (decoded.args as { agentId?: bigint | string }).agentId;
            if (typeof agentId === 'bigint') return agentId;
            if (typeof agentId === 'string') return BigInt(agentId);
          }
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }
    return null;
  }, [options.contractAddress, publicClient]);

  const { refresh: runRefresh } = useWalletSync({
    publicClient,
    normalizedEvmAddress,
    normalizedContractAddress: normalizeEvmOptionAddress(options.contractAddress),
    showcaseTokenAddress: normalizeEvmOptionAddress(options.showcaseTokenAddress),
    executorAddress: normalizeEvmOptionAddress(options.executorAddress),
    fetchLatestAgentId,
  });

  const refresh = useCallback(async () => {
    const res = await runRefresh();
    setAgentState(res.agentState);
    setWalletBalanceWei(res.walletBalanceWei);
    setChainOk(res.chainOk);
  }, [runRefresh]);

  useEffect(() => {
    void refresh();
    const pollId = window.setInterval(refresh, 4000);
    return () => window.clearInterval(pollId);
  }, [refresh]);

  const startSteps = useCallback((labels: string[]) => setProgressSteps(labels.map((label, i) => ({ label, status: i === 0 ? 'active' : 'pending' }))), []);
  const advanceStep = useCallback((completedIndex: number) => setProgressSteps(prev => prev.map((s, i) => i === completedIndex ? { ...s, status: 'done' } : i === completedIndex + 1 ? { ...s, status: 'active' } : s)), []);
  const clearSteps = useCallback(() => setProgressSteps([]), []);

  const { doAgentTx, doContractTx, autoSign } = useContractActions({
    chainId: options.chainId,
    normalizedContractAddress: normalizeEvmOptionAddress(options.contractAddress),
    executorAddress: normalizeEvmOptionAddress(options.executorAddress),
    showcaseTokenAddress: normalizeEvmOptionAddress(options.showcaseTokenAddress),
    showcaseTokenFaucetAddress: normalizeEvmOptionAddress(options.showcaseTokenFaucetAddress),
    showcaseTargetAddress: normalizeEvmOptionAddress(options.showcaseTargetAddress),
    maxTradeValueWei: options.maxTradeValueWei || '0',
    dailyTradeValueWei: options.dailyTradeValueWei || '0',
    initiaAddressRef,
    refresh,
    setBusyAction,
    setError,
    setLastTxHash,
    startSteps,
    advanceStep,
  });

  const safeOpenBridge = useCallback(async (rawParams?: InitiaBridgeOpenParams) => {
    try {
      await (openBridge as any)({
        srcChainId: normalizeBridgeParam(rawParams?.srcChainId, 'initiation-2'),
        srcDenom: normalizeBridgeParam(rawParams?.srcDenom, 'uinit'),
        quantity: normalizeBridgeParam(rawParams?.quantity, '0'),
      });
    } catch {
      if (options.bridgeUrl) window.open(options.bridgeUrl, '_blank');
    }
  }, [openBridge, options.bridgeUrl]);

  useEffect(() => {
    const win = window as Window & {
      __initiaBridgeApi?: {
        openConnect?: () => Promise<void> | void;
        openWallet?: () => Promise<void> | void;
        openBridge?: (params?: InitiaBridgeOpenParams) => Promise<void> | void;
        refresh?: () => Promise<void> | void;
      };
    };

    win.__initiaBridgeApi = {
      openConnect,
      openWallet,
      openBridge: safeOpenBridge,
      refresh,
    };

    return () => {
      if (win.__initiaBridgeApi?.openConnect === openConnect) {
        delete win.__initiaBridgeApi;
      }
    };
  }, [openConnect, openWallet, refresh, safeOpenBridge]);

  useBridgeEvents({
    openConnect, openWallet, safeOpenBridge, refresh, doAgentTx, doContractTx, fetchLatestAgentId, waitForCreatedAgentId,
    initiaAddressRef, evmAddressRef, agentStateRef, setBusyAction, setError, startSteps, advanceStep, clearSteps, autoSign, options
  });

  useEffect(() => {
    const autoSignExpiresAt = autoSign?.expiredAtByChain?.[options.chainId] ?? null;
    const autoSignGrantEnabled = !!autoSign?.isEnabledByChain?.[options.chainId];
    const autoSignConfiguredOnchain = agentState.autoSignEnabled;
    dispatchBridgeState({
      ready: true, chainOk, initiaAddress: normalizedInitiaAddress, evmAddress: normalizedEvmAddress,
      onchainAgentId: agentState.id?.toString() ?? null, walletBalanceWei,
      vaultBalanceWei: agentState.exists ? agentState.balance.toString() : null,
      walletShowcaseTokenBalanceWei: normalizedEvmAddress ? agentState.walletShowcaseTokenBalance.toString() : null,
      showcaseTokenBalanceWei: agentState.exists ? agentState.showcaseTokenBalance.toString() : null,
      agentExists: agentState.exists, executorAuthorized: agentState.exists && agentState.executorAuthorized,
      autoSignEnabled: autoSignConfiguredOnchain && autoSignGrantEnabled, autoSignConfiguredOnchain, autoSignGrantEnabled,
      autoSignExpiresAt: autoSignExpiresAt?.toISOString?.() ?? null, busyAction, lastTxHash, error, progressSteps,
    });
  }, [agentState, autoSign?.expiredAtByChain?.[options.chainId], autoSign?.isEnabledByChain?.[options.chainId], busyAction, chainOk, error, normalizedEvmAddress, normalizedInitiaAddress, lastTxHash, options.chainId, progressSteps, walletBalanceWei]);

  return null;
}

export function mountInitiaBridge(container: HTMLElement, options: InitiaBridgeMountOptions): () => void {
  let root: Root | null = createRoot(container);
  root.render(createElement(BridgeRoot as any, { options, runtime: BridgeRuntime as any }));
  return () => { if (root) { root.unmount(); root = null; } };
}
