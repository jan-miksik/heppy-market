import { useCallback } from 'react';
import { encodeFunctionData, parseEther, toHex } from 'viem';
import { useInterwovenKit } from '@initia/interwovenkit-react';
import { AGENT_ABI, IUSD_FAUCET_ABI, ERC20_ABI } from '~/utils/initia/bridge/abi';
import { buildMsgCall, extractTxHash } from '~/utils/initia/bridge/helpers';

function gasLimitForAction(action: string): number {
  switch (action) {
    case 'createAgentOnchain':
      return 600_000;
    case 'authorizeExecutor':
    case 'authorizeExecutorTarget':
      return 300_000;
    case 'depositShowcaseToken':
    case 'withdrawShowcaseToken':
    case 'mintShowcaseToken':
    case 'depositShowcaseTokenApprove':
    case 'executeTick':
    case 'enableAutoSignOnchain':
    case 'disableAutoSignOnchain':
      return 220_000;
    case 'deposit':
    case 'withdraw':
      return 180_000;
    default:
      return 250_000;
  }
}

export function useContractActions(params: {
  chainId: string;
  normalizedContractAddress: `0x${string}` | null;
  executorAddress: `0x${string}` | null;
  showcaseTokenAddress: `0x${string}` | null;
  showcaseTokenFaucetAddress: `0x${string}` | null;
  showcaseTargetAddress: `0x${string}` | null;
  maxTradeValueWei: string;
  dailyTradeValueWei: string;
  initiaAddressRef: React.MutableRefObject<string | null>;
  refresh: () => Promise<void>;
  setBusyAction: (a: string | null) => void;
  setError: (e: string | null) => void;
  setLastTxHash: (h: string | null) => void;
  startSteps: (l: string[]) => void;
  advanceStep: (i: number) => void;
}) {
  const {
    chainId,
    normalizedContractAddress,
    executorAddress,
    showcaseTokenAddress,
    showcaseTokenFaucetAddress,
    showcaseTargetAddress,
    maxTradeValueWei,
    dailyTradeValueWei,
    initiaAddressRef,
    refresh,
    setBusyAction,
    setError,
    setLastTxHash,
    startSteps,
    advanceStep,
  } = params;

  const { requestTxBlock, requestTxSync, autoSign } = useInterwovenKit();

  const doContractTx = useCallback(async (
    action: string,
    contractAddress: `0x${string}`,
    input: string,
    valueWeiHex?: string,
    autoSignEnabled?: boolean,
  ) => {
    const currentInitiaAddress = initiaAddressRef.current;
    if (!currentInitiaAddress) throw new Error('Connect wallet first.');
    setBusyAction(action);
    setError(null);
    try {
      const tx = await (autoSignEnabled ? requestTxBlock : requestTxSync)({
        chainId,
        autoSign: autoSignEnabled,
        feeDenom: 'GAS',
        gas: gasLimitForAction(action),
        messages: [buildMsgCall(currentInitiaAddress, contractAddress, input, valueWeiHex ?? '0x0')],
      } as any);
      const txHash = extractTxHash(tx);
      setLastTxHash(txHash);
      await refresh();
      return txHash;
    } finally {
      setBusyAction(null);
    }
  }, [chainId, initiaAddressRef, refresh, requestTxBlock, requestTxSync, setBusyAction, setError, setLastTxHash]);

  const doAgentTx = useCallback(async (action: string, input: string, valueWeiHex?: string, autoSignEnabled?: boolean) => {
    if (!normalizedContractAddress) throw new Error('Initia contract address is not configured.');
    return doContractTx(action, normalizedContractAddress, input, valueWeiHex, autoSignEnabled);
  }, [doContractTx, normalizedContractAddress]);

  return { doContractTx, doAgentTx, autoSign };
}
