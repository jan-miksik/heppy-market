import React, { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InterwovenKitProvider, TESTNET, injectStyles, useInterwovenKit } from '@initia/interwovenkit-react';
import InterwovenKitStyles from '@initia/interwovenkit-react/styles.js';
import '@initia/interwovenkit-react/styles.css';
import { createPublicClient, defineChain, encodeFunctionData, parseEther, toHex, http as viemHttp } from 'viem';
import type {
  InitiaBridgeActionEventDetail,
  InitiaBridgeOpenParams,
  InitiaBridgeState,
  ProgressStep,
} from '~/utils/initia/bridge-types';
import { INITIA_BRIDGE_ACTION_EVENT } from '~/utils/initia/bridge-types';
import { AGENT_ABI, ERC20_ABI, IUSD_FAUCET_ABI } from '~/utils/initia/bridge/abi';
import {
  bech32ToEvmHex,
  buildMsgCall,
  dispatchBridgeResponse,
  dispatchBridgeState,
  extractTxHash,
  normalizeBridgeParam,
  normalizeEvmAddress,
  normalizeEvmOptionAddress,
  normalizeInitiaAddress,
  parseU128,
} from '~/utils/initia/bridge/helpers';
import { type AgentState, EMPTY_AGENT_STATE } from '~/utils/initia/bridge/state';

injectStyles(InterwovenKitStyles);

declare global {
  interface Window {
    __initiaBridgeApi?: {
      openConnect: () => Promise<void> | void;
      openWallet: () => Promise<void> | void;
      openBridge: (params?: InitiaBridgeOpenParams) => Promise<void> | void;
      refresh: () => Promise<void> | void;
    };
  }
}

export interface InitiaBridgeMountOptions {
  chainId: string;
  defaultChainId: string;
  chainName: string;
  evmChainId: number;
  evmRpc: string;
  restUrl: string;
  rpcUrl: string;
  indexerUrl: string;
  contractAddress: string;
  showcaseTokenAddress?: string;
  showcaseTokenFaucetAddress?: string;
  executorAddress?: string;
  showcaseTargetAddress?: string;
  maxTradeValueWei?: string;
  dailyTradeValueWei?: string;
  bridgeUrl?: string;
}

function BridgeRuntime(props: { options: InitiaBridgeMountOptions; evmChain: ReturnType<typeof defineChain> }) {
  const { options, evmChain } = props;
  const {
    initiaAddress,
    address: evmAddress,
    openConnect,
    openWallet,
    openBridge,
    requestTxBlock,
    requestTxSync,
    autoSign,
  } = useInterwovenKit();
  const normalizedInitiaAddress = useMemo(() => normalizeInitiaAddress(initiaAddress), [initiaAddress]);
  const normalizedEvmAddress = useMemo(() => normalizeEvmAddress(evmAddress), [evmAddress]);
  const normalizedContractAddress = useMemo(
    () => normalizeEvmOptionAddress(options.contractAddress),
    [options.contractAddress],
  );
  const showcaseTokenAddress = useMemo(
    () => normalizeEvmOptionAddress(options.showcaseTokenAddress),
    [options.showcaseTokenAddress],
  );
  const showcaseTokenFaucetAddress = useMemo(
    () => normalizeEvmOptionAddress(options.showcaseTokenFaucetAddress),
    [options.showcaseTokenFaucetAddress],
  );
  const executorAddress = useMemo(
    () => normalizeEvmOptionAddress(options.executorAddress),
    [options.executorAddress],
  );
  const showcaseTargetAddress = useMemo(
    () => normalizeEvmOptionAddress(options.showcaseTargetAddress),
    [options.showcaseTargetAddress],
  );
  const maxTradeValueWei = useMemo(() => parseU128(options.maxTradeValueWei), [options.maxTradeValueWei]);
  const dailyTradeValueWei = useMemo(() => parseU128(options.dailyTradeValueWei), [options.dailyTradeValueWei]);

  const publicClient = useMemo(() => createPublicClient({
    chain: evmChain,
    transport: viemHttp(options.evmRpc),
  }), [evmChain, options.evmRpc]);

  // Refs that are always current — updated synchronously on every render so
  // callbacks in useEffect never see stale closures (avoids "Connect wallet first"
  // errors when React state updates haven't committed before an action fires).
  const initiaAddressRef = useRef(normalizedInitiaAddress);
  initiaAddressRef.current = normalizedInitiaAddress;
  const evmAddressRef = useRef(normalizedEvmAddress);
  evmAddressRef.current = normalizedEvmAddress;

  const [chainOk, setChainOk] = useState(false);
  const [walletBalanceWei, setWalletBalanceWei] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<AgentState>({
    ...EMPTY_AGENT_STATE,
  });

  const agentStateRef = useRef(agentState);
  agentStateRef.current = agentState;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);

  const fetchLatestAgentId = useCallback(async (owner: `0x${string}`): Promise<bigint | null> => {
    if (!normalizedContractAddress) return null;
    const ids = await publicClient.readContract({
      address: normalizedContractAddress,
      abi: AGENT_ABI,
      functionName: 'ownerAgentIds',
      args: [owner],
    });
    if (!Array.isArray(ids) || ids.length === 0) return null;
    const last = ids[ids.length - 1];
    return typeof last === 'bigint' ? last : null;
  }, [normalizedContractAddress, publicClient]);

  const refresh = useCallback(async () => {
    try {
      await publicClient.getBlockNumber();
      setChainOk(true);
    } catch {
      setChainOk(false);
    }

    let walletShowcaseTokenBalance = 0n;
    if (normalizedEvmAddress && showcaseTokenAddress) {
      try {
        walletShowcaseTokenBalance = await publicClient.readContract({
          address: showcaseTokenAddress,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [normalizedEvmAddress],
        });
      } catch {
        walletShowcaseTokenBalance = 0n;
      }
    }

    if (normalizedEvmAddress) {
      try {
        const activeAgentId = await fetchLatestAgentId(normalizedEvmAddress);

        if (activeAgentId === null || !normalizedContractAddress) {
          setAgentState({
            ...EMPTY_AGENT_STATE,
            walletShowcaseTokenBalance,
          });
        } else {
          const [owner, metadata, nativeBalance, exists, autoSignEnabled, paused] = await publicClient.readContract({
            address: normalizedContractAddress,
            abi: AGENT_ABI,
            functionName: 'getAgent',
            args: [activeAgentId],
          });
          void owner;
          void metadata;
          void paused;
          let showcaseTokenBalance = 0n;
          if (showcaseTokenAddress && exists) {
            try {
              showcaseTokenBalance = await publicClient.readContract({
                address: normalizedContractAddress,
                abi: AGENT_ABI,
                functionName: 'tokenBalance',
                args: [activeAgentId, showcaseTokenAddress],
              });
            } catch {
              showcaseTokenBalance = 0n;
            }
          }

          let executorAuthorized = false;
          if (executorAddress && exists) {
            try {
              const [canTick, canTrade] = await publicClient.readContract({
                address: normalizedContractAddress,
                abi: AGENT_ABI,
                functionName: 'getExecutorApproval',
                args: [activeAgentId, executorAddress],
              });
              executorAuthorized = Boolean(canTick) && Boolean(canTrade);
            } catch {
              executorAuthorized = false;
            }
          }

          setAgentState({
            id: activeAgentId,
            exists: Boolean(exists),
            balance: nativeBalance ?? 0n,
            showcaseTokenBalance,
            walletShowcaseTokenBalance,
            executorAuthorized,
            autoSignEnabled: Boolean(autoSignEnabled),
          });
        }
      } catch {
        setAgentState({
          ...EMPTY_AGENT_STATE,
          walletShowcaseTokenBalance,
        });
      }

      try {
        const walletBalance = await publicClient.getBalance({ address: normalizedEvmAddress });
        setWalletBalanceWei(walletBalance.toString());
      } catch {
        setWalletBalanceWei(null);
      }
    } else {
      setAgentState({
        ...EMPTY_AGENT_STATE,
      });
      setWalletBalanceWei(null);
    }
  }, [
    executorAddress,
    fetchLatestAgentId,
    normalizedContractAddress,
    normalizedEvmAddress,
    publicClient,
    showcaseTokenAddress,
  ]);

  useEffect(() => {
    void refresh();
    const pollId = window.setInterval(() => {
      void refresh();
    }, 4_000);
    return () => {
      window.clearInterval(pollId);
    };
  }, [refresh]);

  const doContractTx = useCallback(async (
    action: string,
    contractAddress: `0x${string}`,
    input: string,
    valueWeiHex?: string,
    autoSignEnabled?: boolean,
  ) => {
    // Use ref so we always read the latest address even if React hasn't
    // committed a re-render since the wallet connected / state was refreshed.
    const currentInitiaAddress = initiaAddressRef.current;
    if (!currentInitiaAddress) throw new Error('Connect wallet first.');
    setBusyAction(action);
    setError(null);
    try {
      // requestTxSync is used instead of requestTxBlock for local dev robustness —
      // requestTxBlock can hang waiting for block confirmation when the local indexer
      // is not reachable. feeDenom pre-selects the fee token to skip the fee-selection UI.
      const tx = await (autoSignEnabled ? requestTxBlock : requestTxSync)({
        chainId: options.chainId,
        autoSign: autoSignEnabled,
        feeDenom: 'GAS',
        messages: [buildMsgCall(currentInitiaAddress, contractAddress, input, valueWeiHex ?? '0x0')],
      } as any);
      const txHash = extractTxHash(tx);
      setLastTxHash(txHash);
      await refresh();
      return txHash;
    } finally {
      setBusyAction(null);
    }
  }, [options.chainId, refresh, requestTxBlock, requestTxSync]);

  const doAgentTx = useCallback(async (action: string, input: string, valueWeiHex?: string, autoSignEnabled?: boolean) => {
    if (!normalizedContractAddress) throw new Error('Initia contract address is not configured.');
    return doContractTx(action, normalizedContractAddress, input, valueWeiHex, autoSignEnabled);
  }, [doContractTx, normalizedContractAddress]);

  const requireAgentId = useCallback((): bigint => {
    const current = agentStateRef.current;
    if (current.id === null || !current.exists) {
      throw new Error('Create an onchain agent first.');
    }
    return current.id;
  }, []);

  const safeOpenBridge = useCallback(async (rawParams?: InitiaBridgeOpenParams) => {
    const srcChainId = normalizeBridgeParam(rawParams?.srcChainId, 'initiation-2');
    const srcDenom = normalizeBridgeParam(rawParams?.srcDenom, 'uinit');
    const quantity = normalizeBridgeParam(rawParams?.quantity, '0');
    try {
      await (openBridge as (p: { srcChainId: string; srcDenom: string; quantity: string }) => Promise<void>)({
        srcChainId,
        srcDenom,
        quantity,
      });
      return;
    } catch (err: unknown) {
      const message = (err as Error)?.message ?? String(err);
      if (message.includes('[BigNumber Error] Not a number')) {
        try {
          // Retry without denom preselection; some bridge builds fail while parsing
          // a prefilled amount/denom state during modal initialization.
          await (openBridge as (p: { srcChainId: string; quantity: string }) => Promise<void>)({ srcChainId, quantity: '0' });
          return;
        } catch {
          if (options.bridgeUrl && typeof window !== 'undefined') {
            window.open(options.bridgeUrl, '_blank', 'noopener,noreferrer');
            return;
          }
        }
      }
      throw err;
    }
  }, [openBridge, options.bridgeUrl]);

  const startSteps = useCallback((labels: string[]) => {
    setProgressSteps(labels.map((label, i) => ({
      label,
      status: (i === 0 ? 'active' : 'pending') as ProgressStep['status'],
    })));
  }, []);

  const advanceStep = useCallback((completedIndex: number) => {
    setProgressSteps(prev => prev.map((s, i) => {
      if (i === completedIndex) return { ...s, status: 'done' as const };
      if (i === completedIndex + 1) return { ...s, status: 'active' as const };
      return s;
    }));
  }, []);

  const clearSteps = useCallback(() => setProgressSteps([]), []);

  useEffect(() => {
    window.__initiaBridgeApi = {
      openConnect: () => openConnect(),
      openWallet: () => openWallet(),
      openBridge: (params) => safeOpenBridge(params),
      refresh: () => refresh(),
    };
    return () => {
      if (window.__initiaBridgeApi) {
        delete window.__initiaBridgeApi;
      }
    };
  }, [openConnect, openWallet, refresh, safeOpenBridge]);

  useEffect(() => {
    const onAction = (event: Event) => {
      const custom = event as CustomEvent<InitiaBridgeActionEventDetail>;
      if (custom.detail?.type !== 'action') return;

      const { id, action, params } = custom.detail.payload;
      const run = async () => {
        switch (action) {
          case 'openConnect':
            await openConnect();
            return {};
          case 'openWallet':
            await openWallet();
            return {};
          case 'openBridge': {
            await safeOpenBridge(params as InitiaBridgeOpenParams | undefined);
            return {};
          }
          case 'refresh':
            await refresh();
            return {};
          case 'createAgentOnchain': {
            const metadataPointer = (params?.metadataPointer ?? {}) as Record<string, unknown>;
            const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataPointer));
            const input = encodeFunctionData({
              abi: AGENT_ABI,
              functionName: 'createAgent',
              args: [toHex(metadataBytes)],
            });
            startSteps(['Confirm agent creation']);
            const txHash = await doAgentTx('createAgentOnchain', input, undefined, params?.autoSign === true);
            advanceStep(0);
            // doContractTx's finally cleared busyAction — re-set it for the polling phase
            // so Vue keeps showing the loading state while we wait for block confirmation.
            setBusyAction('createAgentOnchain');
            try {
              // Derive EVM addr: prefer direct field, fall back to bech32→hex so wallets
              // that only expose initiaAddress (Cosmos-only) still work.
              const pollAddr: `0x${string}` | null =
                evmAddressRef.current ?? bech32ToEvmHex(initiaAddressRef.current);

              let latestAgentId: bigint | null = pollAddr
                ? await fetchLatestAgentId(pollAddr).catch(() => null)
                : null;

              if (latestAgentId === null && pollAddr) {
                const POLL_INTERVAL_MS = 1_500;
                const CONFIRM_TIMEOUT_MS = 45_000;
                const startedAt = Date.now();
                while (latestAgentId === null && Date.now() - startedAt < CONFIRM_TIMEOUT_MS) {
                  await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                  latestAgentId = await fetchLatestAgentId(pollAddr).catch(() => null);
                }
              }

              await refresh();
              return {
                txHash,
                onchainAgentId: latestAgentId?.toString() ?? null,
              };
            } finally {
              setBusyAction(null);
              clearSteps();
            }
          }
          case 'deposit': {
            const agentId = requireAgentId();
            const amount = String(params?.amount ?? '0');
            const wei = parseEther(amount);
            const input = encodeFunctionData({ abi: AGENT_ABI, functionName: 'depositNative', args: [agentId] });
            startSteps(['Confirm INIT deposit']);
            try {
              const txHash = await doAgentTx('deposit', input, `0x${wei.toString(16)}`, params?.autoSign === true);
              return { txHash, onchainAgentId: agentId.toString() };
            } finally {
              clearSteps();
            }
          }
          case 'withdraw': {
            const currentEvmAddrForWithdraw =
              evmAddressRef.current ?? bech32ToEvmHex(initiaAddressRef.current);
            if (!currentEvmAddrForWithdraw) throw new Error('Connect wallet first.');
            const agentId = requireAgentId();
            const amount = String(params?.amount ?? '0');
            const wei = parseEther(amount);
            const input = encodeFunctionData({
              abi: AGENT_ABI,
              functionName: 'withdrawNative',
              args: [agentId, wei, currentEvmAddrForWithdraw],
            });
            startSteps(['Confirm INIT withdrawal']);
            try {
              const txHash = await doAgentTx('withdraw', input, undefined, params?.autoSign === true);
              return { txHash, onchainAgentId: agentId.toString() };
            } finally {
              clearSteps();
            }
          }
          case 'mintShowcaseToken': {
            if (!showcaseTokenFaucetAddress) throw new Error('iUSD-demo faucet address is not configured.');
            const amount = String(params?.amount ?? '0');
            const wei = parseEther(amount);
            const input = encodeFunctionData({
              abi: IUSD_FAUCET_ABI,
              functionName: 'mint',
              args: [wei],
            });
            startSteps(['Confirm iUSD-demo mint']);
            try {
              const txHash = await doContractTx('mintShowcaseToken', showcaseTokenFaucetAddress, input, undefined, params?.autoSign === true);
              return { txHash };
            } finally {
              clearSteps();
            }
          }
          case 'depositShowcaseToken': {
            if (!showcaseTokenAddress) throw new Error('Showcase token address is not configured.');
            if (!normalizedContractAddress) throw new Error('Initia contract address is not configured.');
            const agentId = requireAgentId();
            const amount = String(params?.amount ?? '0');
            const wei = parseEther(amount);

            startSteps(['Approve iUSD-demo spending', 'Deposit iUSD-demo to vault']);
            try {
              const approveInput = encodeFunctionData({
                abi: ERC20_ABI,
                functionName: 'approve',
                args: [normalizedContractAddress!, wei],
              });
              const approveTxHash = await doContractTx(
                'depositShowcaseTokenApprove',
                showcaseTokenAddress,
                approveInput,
                undefined,
                params?.autoSign === true,
              );
              advanceStep(0);

              const depositInput = encodeFunctionData({
                abi: AGENT_ABI,
                functionName: 'depositToken',
                args: [agentId, showcaseTokenAddress, wei],
              });
              const txHash = await doAgentTx('depositShowcaseToken', depositInput, undefined, params?.autoSign === true);
              return { txHash, approveTxHash, onchainAgentId: agentId.toString() };
            } finally {
              clearSteps();
            }
          }
          case 'withdrawShowcaseToken': {
            if (!showcaseTokenAddress) throw new Error('Showcase token address is not configured.');
            const currentEvmAddr = evmAddressRef.current;
            if (!currentEvmAddr) throw new Error('Connect wallet first.');
            const agentId = requireAgentId();
            const amount = String(params?.amount ?? '0');
            const wei = parseEther(amount);
            const input = encodeFunctionData({
              abi: AGENT_ABI,
              functionName: 'withdrawToken',
              args: [agentId, showcaseTokenAddress, wei, currentEvmAddr],
            });
            startSteps(['Confirm iUSD-demo withdrawal']);
            try {
              const txHash = await doAgentTx('withdrawShowcaseToken', input, undefined, params?.autoSign === true);
              return { txHash, onchainAgentId: agentId.toString() };
            } finally {
              clearSteps();
            }
          }
          case 'authorizeExecutor': {
            if (!executorAddress) throw new Error('Executor address is not configured.');
            const agentId = requireAgentId();

            const authSteps = showcaseTargetAddress
              ? ['Whitelist trading target', 'Authorize executor contract']
              : ['Authorize executor contract'];
            startSteps(authSteps);
            try {
              let whitelistTxHash: string | null = null;
              if (showcaseTargetAddress) {
                const whitelistInput = encodeFunctionData({
                  abi: AGENT_ABI,
                  functionName: 'setAllowedPerpDex',
                  args: [agentId, showcaseTargetAddress, true],
                });
                whitelistTxHash = await doAgentTx('authorizeExecutorTarget', whitelistInput, undefined, params?.autoSign === true);
                advanceStep(0);
              }

              const approvalInput = encodeFunctionData({
                abi: AGENT_ABI,
                functionName: 'setExecutorApproval',
                args: [agentId, executorAddress, true, true, maxTradeValueWei, dailyTradeValueWei],
              });
              const txHash = await doAgentTx('authorizeExecutor', approvalInput, undefined, params?.autoSign === true);
              return { txHash, whitelistTxHash, onchainAgentId: agentId.toString() };
            } finally {
              clearSteps();
            }
          }
          case 'enableAutoSign': {
            if (!initiaAddressRef.current) throw new Error('Connect wallet first.');
            const agentId = requireAgentId();
            setBusyAction('enableAutoSign');
            startSteps(['Grant auto-sign permission', 'Enable delegation on-chain']);
            try {
              await (autoSign as any)?.enable?.(options.chainId, { permissions: ['/minievm.evm.v1.MsgCall'] });
              advanceStep(0);
              const input = encodeFunctionData({ abi: AGENT_ABI, functionName: 'setDelegatedExecutionEnabled', args: [agentId, true] });
              // Pass true so the delegation tx uses auto-sign (just granted above)
              const txHash = await doAgentTx('enableAutoSign', input, undefined, true);
              return { txHash, onchainAgentId: agentId.toString() };
            } finally {
              setBusyAction(null);
              clearSteps();
            }
          }
          case 'disableAutoSign': {
            if (!initiaAddressRef.current) throw new Error('Connect wallet first.');
            const agentId = requireAgentId();
            setBusyAction('disableAutoSign');
            startSteps(['Revoke auto-sign permission', 'Disable delegation on-chain']);
            try {
              await (autoSign as any)?.disable?.(options.chainId);
              advanceStep(0);
              const input = encodeFunctionData({ abi: AGENT_ABI, functionName: 'setDelegatedExecutionEnabled', args: [agentId, false] });
              const txHash = await doAgentTx('disableAutoSign', input);
              return { txHash, onchainAgentId: agentId.toString() };
            } finally {
              setBusyAction(null);
              clearSteps();
            }
          }
          case 'executeTick': {
            if (!initiaAddressRef.current) throw new Error('Connect wallet first.');
            const agentId = requireAgentId();
            setBusyAction('executeTick');
            startSteps(['Execute trading tick']);
            try {
              const input = encodeFunctionData({ abi: AGENT_ABI, functionName: 'executeTick', args: [agentId] });
              const txHash = await doAgentTx(
                'executeTick',
                input,
                undefined,
                params?.autoSign === true,
              );
              return { txHash, onchainAgentId: agentId.toString() };
            } finally {
              setBusyAction(null);
              clearSteps();
            }
          }
          default:
            throw new Error(`Unsupported action: ${action}`);
        }
      };

      void run()
        .then((result) => {
          dispatchBridgeResponse(id, true, result);
        })
        .catch((err: unknown) => {
          const message = (err as Error)?.message || String(err);
          clearSteps();
          setError(message);
          dispatchBridgeResponse(id, false, null, message);
        });
    };

    window.addEventListener(INITIA_BRIDGE_ACTION_EVENT, onAction);
    return () => {
      window.removeEventListener(INITIA_BRIDGE_ACTION_EVENT, onAction);
    };
  }, [
    advanceStep,
    autoSign,
    clearSteps,
    dailyTradeValueWei,
    doAgentTx,
    doContractTx,
    fetchLatestAgentId,
    maxTradeValueWei,
    normalizedContractAddress,
    openConnect,
    openWallet,
    options.chainId,
    refresh,
    requireAgentId,
    safeOpenBridge,
    showcaseTargetAddress,
    showcaseTokenFaucetAddress,
    showcaseTokenAddress,
    startSteps,
    executorAddress,
  ]);

  useEffect(() => {
    const autoSignExpiresAt = autoSign?.expiredAtByChain?.[options.chainId] ?? null;
    const autoSignGrantEnabled = !!autoSign?.isEnabledByChain?.[options.chainId];
    const autoSignConfiguredOnchain = agentState.autoSignEnabled;
    const state: InitiaBridgeState = {
      ready: true,
      chainOk,
      initiaAddress: normalizedInitiaAddress,
      evmAddress: normalizedEvmAddress,
      onchainAgentId: agentState.id?.toString() ?? null,
      walletBalanceWei,
      vaultBalanceWei: agentState.exists ? agentState.balance.toString() : null,
      walletShowcaseTokenBalanceWei: normalizedEvmAddress ? agentState.walletShowcaseTokenBalance.toString() : null,
      showcaseTokenBalanceWei: agentState.exists ? agentState.showcaseTokenBalance.toString() : null,
      agentExists: agentState.exists,
      executorAuthorized: agentState.exists && agentState.executorAuthorized,
      autoSignEnabled: autoSignConfiguredOnchain && autoSignGrantEnabled,
      autoSignConfiguredOnchain,
      autoSignGrantEnabled,
      autoSignExpiresAt: autoSignExpiresAt?.toISOString?.() ?? null,
      busyAction,
      lastTxHash,
      error,
      progressSteps,
    };
    dispatchBridgeState(state);
  }, [
    agentState.autoSignEnabled,
    agentState.balance,
    agentState.executorAuthorized,
    agentState.exists,
    agentState.id,
    agentState.showcaseTokenBalance,
    agentState.walletShowcaseTokenBalance,
    autoSign,
    busyAction,
    chainOk,
    error,
    normalizedEvmAddress,
    normalizedInitiaAddress,
    lastTxHash,
    options.chainId,
    progressSteps,
    walletBalanceWei,
  ]);

  return null;
}

function BridgeRoot(props: { options: InitiaBridgeMountOptions }) {
  const { options } = props;

  const evmChain = useMemo(() => defineChain({
    id: options.evmChainId,
    name: options.chainName,
    nativeCurrency: { name: 'GAS', symbol: 'GAS', decimals: 18 },
    rpcUrls: { default: { http: [options.evmRpc] } },
  }), [options.chainName, options.evmChainId, options.evmRpc]);

  const customChain = useMemo(() => ({
    chain_id: options.chainId,
    chain_name: options.chainName,
    pretty_name: options.chainName,
    network_type: 'testnet',
    bech32_prefix: 'init',
    apis: {
      rpc: [{ address: options.rpcUrl }],
      rest: [{ address: options.restUrl }],
      indexer: [{ address: options.indexerUrl }],
      'json-rpc': [{ address: options.evmRpc }],
    },
    fees: {
      fee_tokens: [{ denom: 'GAS', fixed_min_gas_price: 0, low_gas_price: 0, average_gas_price: 0, high_gas_price: 0 }],
    },
    staking: { staking_tokens: [{ denom: 'GAS' }] },
    native_assets: [{ denom: 'GAS', name: 'GAS', symbol: 'GAS', decimals: 18 }],
    metadata: { is_l1: false, minitia: { type: 'minievm' } },
  }), [options.chainId, options.chainName, options.evmRpc, options.indexerUrl, options.restUrl, options.rpcUrl]);

  const queryClient = useMemo(() => new QueryClient(), []);
  const wagmiConfig = useMemo(() => createConfig({
    chains: [evmChain],
    transports: {
      [evmChain.id]: http(options.evmRpc),
    },
  }), [evmChain, options.evmRpc]);

  return createElement(
    WagmiProvider as any,
    { config: wagmiConfig },
    createElement(
      QueryClientProvider as any,
      { client: queryClient },
      createElement(
        InterwovenKitProvider as any,
        {
          ...TESTNET,
          defaultChainId: options.defaultChainId,
          customChain,
          customChains: [customChain],
          enableAutoSign: { [options.chainId]: ['/minievm.evm.v1.MsgCall'] },
        } as any,
        createElement(BridgeRuntime, { options, evmChain }),
      ),
    ),
  );
}

export function mountInitiaBridge(container: HTMLElement, options: InitiaBridgeMountOptions): () => void {
  let root: Root | null = createRoot(container);
  root.render(createElement(BridgeRoot as any, { options }) as any);
  return () => {
    if (root) {
      root.unmount();
      root = null;
    }
  };
}
