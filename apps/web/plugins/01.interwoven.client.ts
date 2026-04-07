import { mountInitiaBridge } from '~/utils/initia/react-bridge';

export default defineNuxtPlugin(() => {
  if (!import.meta.client) return;

  const win = window as Window & { __initiaBridgeMounted?: boolean; __initiaBridgeMountError?: string | null };
  if (win.__initiaBridgeMounted) return;
  win.__initiaBridgeMountError = null;

  const runtimeConfig = useRuntimeConfig();
  const host = document.createElement('div');
  host.id = 'initia-bridge-host';
  host.style.width = '0';
  host.style.height = '0';
  host.style.overflow = 'visible';
  document.body.appendChild(host);

  const evmChainId = Number.parseInt(String(runtimeConfig.public.initiaEvmChainId || '2178983797612220'), 10);
  const chainId = String(runtimeConfig.public.initiaRollupChainId || 'pillow-rollup');
  const defaultChainId = chainId;
  const chainName = `${chainId} (Nuxt)`;

  try {
    const teardown = mountInitiaBridge(host, {
      chainId,
      defaultChainId,
      chainName,
      evmChainId: Number.isFinite(evmChainId) ? evmChainId : 2178983797612220,
      evmRpc: String(runtimeConfig.public.initiaEvmRpc || 'http://localhost:8545'),
      restUrl: String(runtimeConfig.public.initiaRestUrl || 'http://localhost:1317'),
      rpcUrl: String(runtimeConfig.public.initiaRpcUrl || 'http://localhost:26657'),
      indexerUrl: String(runtimeConfig.public.initiaIndexerUrl || 'http://localhost:8080'),
      contractAddress: String(runtimeConfig.public.initiaContractAddress || ''),
      showcaseTokenAddress: String(runtimeConfig.public.initiaShowcaseTokenAddress || ''),
      showcaseTokenFaucetAddress: String(runtimeConfig.public.initiaShowcaseTokenFaucetAddress || ''),
      executorAddress: String(runtimeConfig.public.initiaExecutorAddress || ''),
      showcaseTargetAddress: String(runtimeConfig.public.initiaShowcaseTargetAddress || ''),
      maxTradeValueWei: String(runtimeConfig.public.initiaExecutorMaxTradeWei || '0'),
      dailyTradeValueWei: String(runtimeConfig.public.initiaExecutorDailyLimitWei || '0'),
      bridgeUrl: String(runtimeConfig.public.initiaBridgeUrl || 'https://bridge.testnet.initia.xyz'),
    });
    win.__initiaBridgeMounted = true;
    window.addEventListener('beforeunload', () => teardown(), { once: true });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    win.__initiaBridgeMountError = message;
    console.error('[initia-bridge] failed to mount bridge runtime', err);
  }
});
