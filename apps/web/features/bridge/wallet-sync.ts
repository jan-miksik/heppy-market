import { useCallback } from 'react';
import { AGENT_ABI, ERC20_ABI } from '~/utils/initia/bridge/abi';
import { EMPTY_AGENT_STATE, type AgentState } from '~/utils/initia/bridge/state';

interface WalletSyncPublicClient {
  readContract: (args: any) => Promise<any>;
  getBalance: (args: { address: `0x${string}` }) => Promise<bigint>;
}

export function useWalletSync(params: {
  publicClient: WalletSyncPublicClient;
  normalizedEvmAddress: `0x${string}` | null;
  normalizedContractAddress: `0x${string}` | null;
  showcaseTokenAddress: `0x${string}` | null;
  executorAddress: `0x${string}` | null;
  fetchLatestAgentId: (owner: `0x${string}`) => Promise<bigint | null>;
}) {
  const {
    publicClient,
    normalizedEvmAddress,
    normalizedContractAddress,
    showcaseTokenAddress,
    executorAddress,
    fetchLatestAgentId,
  } = params;

  const refresh = useCallback(async () => {
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
          return {
            agentState: { ...EMPTY_AGENT_STATE, walletShowcaseTokenBalance },
            walletBalanceWei: (await publicClient.getBalance({ address: normalizedEvmAddress })).toString(),
            chainOk: true,
          };
        } else {
          const [owner, metadata, nativeBalance, exists, autoSignEnabled, paused] = await publicClient.readContract({
            address: normalizedContractAddress,
            abi: AGENT_ABI,
            functionName: 'getAgent',
            args: [activeAgentId],
          }) as any;
          void owner; void metadata; void paused;

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
                functionName: 'getDelegatedExecutorApproval',
                args: [activeAgentId, executorAddress],
              }) as any;
              executorAuthorized = Boolean(canTick) && Boolean(canTrade);
            } catch {
              executorAuthorized = false;
            }
          }

          return {
            agentState: {
              id: activeAgentId,
              exists: Boolean(exists),
              balance: nativeBalance ?? 0n,
              showcaseTokenBalance,
              walletShowcaseTokenBalance,
              executorAuthorized,
              autoSignEnabled: Boolean(autoSignEnabled),
            },
            walletBalanceWei: (await publicClient.getBalance({ address: normalizedEvmAddress })).toString(),
            chainOk: true,
          };
        }
      } catch (err) {
        return {
          agentState: { ...EMPTY_AGENT_STATE, walletShowcaseTokenBalance },
          walletBalanceWei: null,
          chainOk: false,
        };
      }
    } else {
      return {
        agentState: { ...EMPTY_AGENT_STATE },
        walletBalanceWei: null,
        chainOk: true,
      };
    }
  }, [executorAddress, fetchLatestAgentId, normalizedContractAddress, normalizedEvmAddress, publicClient, showcaseTokenAddress]);

  return { refresh };
}
