import { computed, readonly, ref } from 'vue';
import type {
  InitiaBridgeAction,
  InitiaBridgeActionEventDetail,
  InitiaBridgeOpenParams,
  InitiaBridgeResponseEventDetail,
  InitiaBridgeState,
  InitiaBridgeStateEventDetail,
} from '~/utils/initia/bridge-types';
import {
  INITIA_BRIDGE_ACTION_EVENT,
  INITIA_BRIDGE_RESPONSE_EVENT,
  INITIA_BRIDGE_STATE_EVENT,
} from '~/utils/initia/bridge-types';

const BRIDGE_ACTION_TIMEOUT_MS = 90_000;
const BRIDGE_READY_TIMEOUT_MS = 20_000;

const initiaBridgeState = ref<InitiaBridgeState>({
  ready: false,
  chainOk: false,
  initiaAddress: null,
  evmAddress: null,
  onchainAgentId: null,
  walletBalanceWei: null,
  vaultBalanceWei: null,
  walletShowcaseTokenBalanceWei: null,
  showcaseTokenBalanceWei: null,
  agentExists: false,
  executorAuthorized: false,
  autoSignEnabled: false,
  busyAction: null,
  lastTxHash: null,
  error: null,
});

let listenersBound = false;

function getDirectBridgeApi() {
  if (!import.meta.client) return null;
  return (window as Window & {
    __initiaBridgeApi?: {
      openConnect?: () => Promise<void> | void;
      openWallet?: () => Promise<void> | void;
      openBridge?: (params?: InitiaBridgeOpenParams) => Promise<void> | void;
      refresh?: () => Promise<void> | void;
    };
  }).__initiaBridgeApi ?? null;
}

function getBridgeMountError() {
  if (!import.meta.client) return null;
  return (window as Window & { __initiaBridgeMountError?: string | null }).__initiaBridgeMountError ?? null;
}

function invokeDirectModalAction(action: 'openConnect' | 'openWallet'): boolean {
  const direct = getDirectBridgeApi();
  if (!direct) return false;
  const fn = action === 'openConnect' ? direct.openConnect : direct.openWallet;
  if (!fn) return false;

  Promise.resolve(fn()).catch((err) => {
    setBridgeError((err as Error)?.message ?? String(err));
  });
  return true;
}

function setBridgeError(message: string) {
  initiaBridgeState.value = {
    ...initiaBridgeState.value,
    error: message,
  };
}

function ensureBridgeListeners() {
  if (!import.meta.client || listenersBound) return;
  listenersBound = true;

  window.addEventListener(INITIA_BRIDGE_STATE_EVENT, (event) => {
    const custom = event as CustomEvent<InitiaBridgeStateEventDetail>;
    if (custom.detail?.type !== 'state') return;
    initiaBridgeState.value = {
      ...initiaBridgeState.value,
      ...custom.detail.payload,
    };
  });
}

async function waitForBridgeReady() {
  if (!import.meta.client) return;
  ensureBridgeListeners();
  const mountError = getBridgeMountError();
  if (mountError) throw new Error(mountError);
  if (getDirectBridgeApi()) return;
  if (initiaBridgeState.value.ready) return;

  await new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      window.removeEventListener(INITIA_BRIDGE_STATE_EVENT, onState);
      if (timeoutId) window.clearTimeout(timeoutId);
      if (pollId) window.clearInterval(pollId);
    };

    const completeIfReady = () => {
      const mountErr = getBridgeMountError();
      if (mountErr) {
        cleanup();
        reject(new Error(mountErr));
        return true;
      }
      if (getDirectBridgeApi() || initiaBridgeState.value.ready) {
        cleanup();
        resolve();
        return true;
      }
      return false;
    };

    const onState = (event: Event) => {
      const custom = event as CustomEvent<InitiaBridgeStateEventDetail>;
      if (custom.detail?.type !== 'state') return;
      if (!custom.detail.payload?.ready) return;
      completeIfReady();
    };

    window.addEventListener(INITIA_BRIDGE_STATE_EVENT, onState);
    pollId = setInterval(() => {
      completeIfReady();
    }, 150);
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Initia bridge is not ready.'));
    }, BRIDGE_READY_TIMEOUT_MS);
  });
}

async function sendBridgeAction(action: InitiaBridgeAction): Promise<Record<string, unknown> | null> {
  if (!import.meta.client) {
    throw new Error('Initia bridge is only available in the browser.');
  }
  ensureBridgeListeners();
  if (
    (action.action === 'openConnect' || action.action === 'openWallet')
    && !initiaBridgeState.value.ready
  ) {
    await waitForBridgeReady();
  }
  if (
    action.action !== 'refresh'
    && action.action !== 'openConnect'
    && action.action !== 'openWallet'
  ) {
    await waitForBridgeReady();
  }

  const id = `ib_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const detail: InitiaBridgeActionEventDetail = {
    type: 'action',
    payload: {
      id,
      action: action.action,
      params: 'params' in action ? action.params : undefined,
    },
  };

  return await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const onResponse = (event: Event) => {
      const custom = event as CustomEvent<InitiaBridgeResponseEventDetail>;
      if (custom.detail?.type !== 'response') return;
      const payload = custom.detail.payload;
      if (!payload || payload.id !== id) return;

      window.removeEventListener(INITIA_BRIDGE_RESPONSE_EVENT, onResponse);
      if (timeoutId) window.clearTimeout(timeoutId);

      if (!payload.ok) {
        reject(new Error(payload.error || 'Initia bridge action failed.'));
        return;
      }
      resolve(payload.result ?? null);
    };

    window.addEventListener(INITIA_BRIDGE_RESPONSE_EVENT, onResponse);
    timeoutId = setTimeout(() => {
      window.removeEventListener(INITIA_BRIDGE_RESPONSE_EVENT, onResponse);
      reject(new Error('Initia bridge action timed out.'));
    }, BRIDGE_ACTION_TIMEOUT_MS);

    window.dispatchEvent(new CustomEvent<InitiaBridgeActionEventDetail>(INITIA_BRIDGE_ACTION_EVENT, { detail }));
  });
}

export function useInitiaBridge() {
  ensureBridgeListeners();

  const ready = computed(() => initiaBridgeState.value.ready);
  const isConnected = computed(() => !!initiaBridgeState.value.initiaAddress);

  async function openConnect() {
    await waitForBridgeReady();
    if (invokeDirectModalAction('openConnect')) return;
    throw new Error('Initia wallet bridge is ready but openConnect API is missing.');
  }

  async function openWallet() {
    await waitForBridgeReady();
    if (invokeDirectModalAction('openWallet')) return;
    throw new Error('Initia wallet bridge is ready but openWallet API is missing.');
  }

  async function openBridge(params?: InitiaBridgeOpenParams) {
    await waitForBridgeReady();
    const normalizedParams: InitiaBridgeOpenParams = {
      ...params,
      quantity: (params?.quantity?.trim() || '0'),
    };
    const direct = getDirectBridgeApi();
    if (direct?.openBridge) {
      await Promise.resolve(direct.openBridge(normalizedParams)).catch((err) => {
        setBridgeError((err as Error)?.message ?? String(err));
      });
      return;
    }
    await sendBridgeAction({ action: 'openBridge', params: normalizedParams });
  }

  async function refresh() {
    const direct = getDirectBridgeApi();
    if (direct?.refresh) {
      await direct.refresh();
      return;
    }
    await sendBridgeAction({ action: 'refresh' });
  }

  async function createAgentOnchain(
    metadataPointer: Record<string, unknown>,
  ): Promise<{ txHash?: string | null; onchainAgentId?: string | null }> {
    const result = await sendBridgeAction({ action: 'createAgentOnchain', params: { metadataPointer } });
    return {
      txHash: (result?.txHash as string | undefined) ?? null,
      onchainAgentId: (result?.onchainAgentId as string | undefined) ?? null,
    };
  }

  async function deposit(amount: string): Promise<{ txHash?: string | null }> {
    const result = await sendBridgeAction({ action: 'deposit', params: { amount } });
    return {
      txHash: (result?.txHash as string | undefined) ?? null,
    };
  }

  async function withdraw(amount: string): Promise<{ txHash?: string | null }> {
    const result = await sendBridgeAction({ action: 'withdraw', params: { amount } });
    return {
      txHash: (result?.txHash as string | undefined) ?? null,
    };
  }

  async function depositShowcaseToken(amount: string): Promise<{ txHash?: string | null }> {
    const result = await sendBridgeAction({ action: 'depositShowcaseToken', params: { amount } });
    return {
      txHash: (result?.txHash as string | undefined) ?? null,
    };
  }

  async function withdrawShowcaseToken(amount: string): Promise<{ txHash?: string | null }> {
    const result = await sendBridgeAction({ action: 'withdrawShowcaseToken', params: { amount } });
    return {
      txHash: (result?.txHash as string | undefined) ?? null,
    };
  }

  async function authorizeExecutor(): Promise<{ txHash?: string | null }> {
    const result = await sendBridgeAction({ action: 'authorizeExecutor' });
    return {
      txHash: (result?.txHash as string | undefined) ?? null,
    };
  }

  async function enableAutoSign(): Promise<{ txHash?: string | null }> {
    const result = await sendBridgeAction({ action: 'enableAutoSign' });
    return {
      txHash: (result?.txHash as string | undefined) ?? null,
    };
  }

  async function disableAutoSign(): Promise<{ txHash?: string | null }> {
    const result = await sendBridgeAction({ action: 'disableAutoSign' });
    return {
      txHash: (result?.txHash as string | undefined) ?? null,
    };
  }

  async function executeTick(): Promise<{ txHash?: string | null }> {
    const result = await sendBridgeAction({ action: 'executeTick' });
    return {
      txHash: (result?.txHash as string | undefined) ?? null,
    };
  }

  return {
    state: readonly(initiaBridgeState),
    ready,
    isConnected,
    openConnect,
    openWallet,
    openBridge,
    refresh,
    createAgentOnchain,
    deposit,
    withdraw,
    depositShowcaseToken,
    withdrawShowcaseToken,
    authorizeExecutor,
    enableAutoSign,
    disableAutoSign,
    executeTick,
  };
}
