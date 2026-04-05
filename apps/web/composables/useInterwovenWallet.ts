import { computed } from 'vue';

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  providers?: Eip1193Provider[];
  isInterwoven?: boolean;
  isInitia?: boolean;
  isMetaMask?: boolean;
}

interface InterwovenWindow extends Window {
  interwoven?: {
    ethereum?: Eip1193Provider;
    openBridge?: (details?: { srcChainId?: string; srcDenom?: string; quantity?: string }) => unknown;
    openWallet?: () => unknown;
    open?: (view?: string) => unknown;
  };
  initia?: {
    ethereum?: Eip1193Provider;
  };
  ethereum?: Eip1193Provider;
}

const DEFAULT_BRIDGE_SRC_CHAIN_ID = 'initiation-2';
const DEFAULT_BRIDGE_SRC_DENOM = 'uinit';

function normalizeHexAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(value) ? value : null;
}

function normalizeBridgeOption(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerScore(provider: Eip1193Provider): number {
  let score = 0;
  if (provider.isInterwoven) score += 100;
  if (provider.isInitia) score += 80;
  if (provider.isMetaMask) score -= 10;
  return score;
}

export function useInterwovenWallet() {
  const runtimeConfig = useRuntimeConfig();
  const walletAddress = useState<string | null>('interwoven-wallet-address', () => null);
  const walletBusy = useState<boolean>('interwoven-wallet-busy', () => false);
  const walletError = useState<string | null>('interwoven-wallet-error', () => null);

  const isConnected = computed(() => !!walletAddress.value);

  function getInjectedProviders(): Eip1193Provider[] {
    if (!import.meta.client) return [];
    const win = window as InterwovenWindow;

    const candidates: Eip1193Provider[] = [];
    const push = (provider?: Eip1193Provider) => {
      if (!provider || typeof provider.request !== 'function') return;
      if (!candidates.includes(provider)) candidates.push(provider);
    };

    push(win.interwoven?.ethereum);
    push(win.initia?.ethereum);
    push(win.ethereum);
    for (const provider of win.ethereum?.providers ?? []) {
      push(provider);
    }

    if (!candidates.length) return [];

    candidates.sort((a, b) => providerScore(b) - providerScore(a));
    return candidates;
  }

  function getInjectedProvider(): Eip1193Provider | null {
    const providers = getInjectedProviders();
    return providers[0] ?? null;
  }

  async function getInjectedProvidersWithWait(waitMs = 2000): Promise<Eip1193Provider[]> {
    const startedAt = Date.now();

    while (Date.now() - startedAt <= waitMs) {
      const providers = getInjectedProviders();
      if (providers.length > 0) return providers;
      await sleep(120);
    }

    return [];
  }

  async function getInjectedProviderWithWait(waitMs = 2000): Promise<Eip1193Provider | null> {
    const providers = await getInjectedProvidersWithWait(waitMs);
    return providers[0] ?? null;
  }

  function getInterwovenWindow(): InterwovenWindow | null {
    if (!import.meta.client) return null;
    return window as InterwovenWindow;
  }

  async function syncWalletAddress(): Promise<string | null> {
    const provider = getInjectedProvider();
    if (!provider) {
      walletAddress.value = null;
      return null;
    }

    try {
      const accounts = await provider.request({ method: 'eth_accounts' });
      const first = Array.isArray(accounts) ? accounts[0] : null;
      const normalized = normalizeHexAddress(first);
      walletAddress.value = normalized;
      return normalized;
    } catch {
      walletAddress.value = null;
      return null;
    }
  }

  async function connectWallet(): Promise<string> {
    const providers = await getInjectedProvidersWithWait(3000);
    if (providers.length === 0) {
      throw new Error('Interwoven wallet provider not found. Open/enable the Interwoven wallet extension and refresh.');
    }

    walletBusy.value = true;
    walletError.value = null;
    try {
      let lastError: unknown = null;

      for (const provider of providers) {
        try {
          const accounts = await provider.request({ method: 'eth_requestAccounts' });
          const first = Array.isArray(accounts) ? accounts[0] : null;
          const normalized = normalizeHexAddress(first);
          if (!normalized) continue;
          walletAddress.value = normalized;
          return normalized;
        } catch (err) {
          lastError = err;
        }
      }

      if (lastError) {
        throw lastError;
      }

      throw new Error('Wallet did not return any usable account.');
    } catch (err: unknown) {
      walletError.value = (err as Error)?.message ?? 'Wallet connection failed.';
      throw err;
    } finally {
      walletBusy.value = false;
    }
  }

  async function openWallet(): Promise<void> {
    const win = getInterwovenWindow();
    if (!win) return;

    walletError.value = null;

    try {
      if (typeof win.interwoven?.openWallet === 'function') {
        await Promise.resolve(win.interwoven.openWallet());
      } else if (typeof win.interwoven?.open === 'function') {
        await Promise.resolve(win.interwoven.open('wallet'));
      } else {
        // Fallback: force account request to avoid silent no-op when
        // provider does not expose wallet UI helpers.
        await connectWallet();
      }
      await syncWalletAddress();
      return;
    } catch (err: unknown) {
      walletError.value = (err as Error)?.message ?? 'Unable to open wallet.';
      throw err;
    }
  }

  async function openBridge(params?: { srcChainId?: string; srcDenom?: string; quantity?: string }): Promise<void> {
    const win = getInterwovenWindow();
    if (!win) return;

    const srcChainId = normalizeBridgeOption(params?.srcChainId)
      ?? normalizeBridgeOption(runtimeConfig.public.initiaBridgeSrcChainId)
      ?? DEFAULT_BRIDGE_SRC_CHAIN_ID;
    const srcDenom = normalizeBridgeOption(params?.srcDenom)
      ?? normalizeBridgeOption(runtimeConfig.public.initiaBridgeSrcDenom)
      ?? DEFAULT_BRIDGE_SRC_DENOM;
    const quantity = normalizeBridgeOption(params?.quantity) ?? '0';
    const bridgeUrl = normalizeBridgeOption(runtimeConfig.public.initiaBridgeUrl);

    if (typeof win.interwoven?.openBridge === 'function') {
      try {
        await Promise.resolve(win.interwoven.openBridge({ srcChainId, srcDenom, quantity }));
        return;
      } catch (err: unknown) {
        const message = (err as Error)?.message ?? String(err);
        if (message.includes('[BigNumber Error] Not a number')) {
          try {
            await Promise.resolve(win.interwoven.openBridge({ srcChainId, quantity: '0' }));
            return;
          } catch {
            if (bridgeUrl) {
              window.open(bridgeUrl, '_blank', 'noopener,noreferrer');
              return;
            }
          }
        }
        throw err;
      }
    }

    if (typeof win.interwoven?.open === 'function') {
      await Promise.resolve(win.interwoven.open('bridge'));
      return;
    }

    if (typeof win.interwoven?.openWallet === 'function') {
      await Promise.resolve(win.interwoven.openWallet());
      return;
    }

    if (bridgeUrl) {
      window.open(bridgeUrl, '_blank', 'noopener,noreferrer');
      return;
    }

    throw new Error('Initia wallet bridge UI is unavailable in this environment.');
  }

  async function getChainId(): Promise<number> {
    const provider = await getInjectedProviderWithWait(1000);
    if (!provider) return 0;

    try {
      const chainHex = await provider.request({ method: 'eth_chainId' });
      if (typeof chainHex !== 'string') return 0;
      return Number.parseInt(chainHex, 16);
    } catch {
      return 0;
    }
  }

  async function signPersonalMessage(message: string, fromAddress?: string): Promise<string> {
    const provider = await getInjectedProviderWithWait(1000);
    if (!provider) throw new Error('Interwoven wallet provider not found.');

    const sender = normalizeHexAddress(fromAddress) ?? walletAddress.value;
    if (!sender) throw new Error('No wallet connected.');

    try {
      const result = await provider.request({
        method: 'personal_sign',
        params: [message, sender],
      });
      if (typeof result !== 'string') throw new Error('Wallet returned invalid signature.');
      return result;
    } catch (firstErr) {
      const result = await provider.request({
        method: 'personal_sign',
        params: [sender, message],
      }).catch(() => {
        throw firstErr;
      });
      if (typeof result !== 'string') throw new Error('Wallet returned invalid signature.');
      return result;
    }
  }

  function clearWalletState(): void {
    walletAddress.value = null;
    walletError.value = null;
    walletBusy.value = false;
  }

  return {
    walletAddress,
    isConnected,
    walletBusy,
    walletError,
    syncWalletAddress,
    connectWallet,
    openWallet,
    openBridge,
    getChainId,
    signPersonalMessage,
    clearWalletState,
  };
}
