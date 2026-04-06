<script setup lang="ts">
const props = withDefaults(defineProps<{
  title?: string;
  agentId?: string | null;
  syncOnAction?: boolean;
}>(), {
  title: 'Onchain Vault',
  agentId: null,
  syncOnAction: true,
});

const runtimeConfig = useRuntimeConfig();
const { request } = useApi();
const {
  state: initiaState,
  openConnect,
  openWallet,
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
} = useInitiaBridge();

const nativeAmount = ref('0.1');
const tokenAmount = ref('10');
const localBusy = ref<
  | 'create'
  | 'deposit'
  | 'withdraw'
  | 'depositToken'
  | 'withdrawToken'
  | 'authorizeExecutor'
  | 'enableAutoSign'
  | 'disableAutoSign'
  | 'executeTick'
  | null
>(null);
const actionError = ref<string | null>(null);
const actionTxHashes = ref<string[]>([]);

const connected = computed(() => Boolean(initiaState.value.initiaAddress || initiaState.value.evmAddress));
const busy = computed(() => Boolean(localBusy.value || initiaState.value.busyAction));
const hasAgent = computed(() => initiaState.value.agentExists);

function formatWei(wei: string | null | undefined): string {
  if (!wei) return '0.000000';
  try {
    const n = BigInt(wei);
    const e18 = 1_000_000_000_000_000_000n;
    const whole = n / e18;
    const frac = n % e18;
    return `${whole}.${frac.toString().padStart(18, '0').slice(0, 6)}`;
  } catch {
    return '0.000000';
  }
}

function clearFeedback() {
  actionError.value = null;
  actionTxHashes.value = [];
}

function addTxHash(hash: unknown) {
  if (!hash || typeof hash !== 'string') return;
  if (!actionTxHashes.value.includes(hash)) {
    actionTxHashes.value = [...actionTxHashes.value, hash];
  }
}

function checkAmount(amount: string): boolean {
  const n = Number(amount);
  return Number.isFinite(n) && n > 0;
}

async function syncStateToApi(trigger: string) {
  if (!props.syncOnAction || !props.agentId) return;
  if (!initiaState.value.initiaAddress) return;

  try {
    await request(`/api/agents/${props.agentId}/initia/sync`, {
      method: 'POST',
      body: {
        state: {
          walletAddress: initiaState.value.initiaAddress,
          evmAddress: initiaState.value.evmAddress ?? undefined,
          chainOk: initiaState.value.chainOk,
          existsOnchain: initiaState.value.agentExists,
          autoSignEnabled: initiaState.value.autoSignEnabled,
          walletBalanceWei: initiaState.value.walletBalanceWei ?? undefined,
          vaultBalanceWei: initiaState.value.vaultBalanceWei ?? undefined,
          walletShowcaseTokenBalanceWei: initiaState.value.walletShowcaseTokenBalanceWei ?? undefined,
          showcaseTokenBalanceWei: initiaState.value.showcaseTokenBalanceWei ?? undefined,
          onchainAgentId: initiaState.value.onchainAgentId ?? undefined,
          executorAuthorized: initiaState.value.executorAuthorized,
          contractAddress: String(runtimeConfig.public.initiaContractAddress || '') || undefined,
          lastTxHash: initiaState.value.lastTxHash ?? undefined,
          syncTrigger: trigger,
        },
      },
      silent: true,
    });
  } catch (err) {
    console.warn('[initia-vault-panel] failed to sync initia state', err);
  }
}

async function runAction(
  action: NonNullable<typeof localBusy.value>,
  fn: () => Promise<Record<string, unknown> | { txHash?: string | null }>,
) {
  clearFeedback();
  localBusy.value = action;
  try {
    const res = await fn();
    addTxHash((res as { txHash?: string | null }).txHash ?? null);
    addTxHash((res as { approveTxHash?: string | null }).approveTxHash ?? null);
    addTxHash((res as { whitelistTxHash?: string | null }).whitelistTxHash ?? null);
    await refresh();
    await syncStateToApi(action);
  } catch (err) {
    actionError.value = extractApiError(err);
  } finally {
    localBusy.value = null;
  }
}

async function handleConnectOrWallet() {
  clearFeedback();
  if (connected.value) {
    await openWallet();
    return;
  }
  await openConnect();
}

async function handleCreateAgentOnchain() {
  if (!connected.value) {
    actionError.value = 'Connect wallet first.';
    return;
  }

  await runAction('create', async () => {
    const metadataPointer = {
      source: 'initroot',
      createdAt: new Date().toISOString(),
    };
    return await createAgentOnchain(metadataPointer);
  });
}

async function handleDepositNative() {
  if (!checkAmount(nativeAmount.value)) {
    actionError.value = 'Enter a valid native amount > 0.';
    return;
  }
  await runAction('deposit', async () => await deposit(nativeAmount.value));
}

async function handleWithdrawNative() {
  if (!checkAmount(nativeAmount.value)) {
    actionError.value = 'Enter a valid native amount > 0.';
    return;
  }
  await runAction('withdraw', async () => await withdraw(nativeAmount.value));
}

async function handleDepositToken() {
  if (!checkAmount(tokenAmount.value)) {
    actionError.value = 'Enter a valid showcase token amount > 0.';
    return;
  }
  await runAction('depositToken', async () => await depositShowcaseToken(tokenAmount.value));
}

async function handleWithdrawToken() {
  if (!checkAmount(tokenAmount.value)) {
    actionError.value = 'Enter a valid showcase token amount > 0.';
    return;
  }
  await runAction('withdrawToken', async () => await withdrawShowcaseToken(tokenAmount.value));
}

async function handleAuthorizeExecutor() {
  await runAction('authorizeExecutor', async () => await authorizeExecutor());
}

async function handleEnableAutoSign() {
  await runAction('enableAutoSign', async () => await enableAutoSign());
}

async function handleDisableAutoSign() {
  await runAction('disableAutoSign', async () => await disableAutoSign());
}

async function handleExecuteTick() {
  await runAction('executeTick', async () => await executeTick());
}
</script>

<template>
  <section class="vault-panel">
    <div class="vault-panel__header">
      <span class="vault-panel__title">{{ props.title }}</span>
      <button class="btn btn-ghost btn-sm" :disabled="busy" @click="refresh">↻ Refresh</button>
    </div>

    <div class="vault-panel__stats">
      <div class="vault-panel__stat">
        <div class="vault-panel__label">Deposited on agent</div>
        <div class="vault-panel__value">{{ formatWei(initiaState.vaultBalanceWei) }} GAS</div>
      </div>
      <div class="vault-panel__stat">
        <div class="vault-panel__label">Wallet GAS</div>
        <div class="vault-panel__value">{{ formatWei(initiaState.walletBalanceWei) }} GAS</div>
      </div>
      <div class="vault-panel__stat">
        <div class="vault-panel__label">Deposited showcase</div>
        <div class="vault-panel__value">{{ formatWei(initiaState.showcaseTokenBalanceWei) }}</div>
      </div>
      <div class="vault-panel__stat">
        <div class="vault-panel__label">Wallet showcase</div>
        <div class="vault-panel__value">{{ formatWei(initiaState.walletShowcaseTokenBalanceWei) }}</div>
      </div>
      <div class="vault-panel__stat">
        <div class="vault-panel__label">Onchain Agent ID</div>
        <div class="vault-panel__value mono">{{ initiaState.onchainAgentId ?? 'not created' }}</div>
      </div>
      <div class="vault-panel__stat">
        <div class="vault-panel__label">Auto-sign</div>
        <div class="vault-panel__value mono">{{ initiaState.autoSignEnabled ? 'enabled' : 'disabled' }}</div>
      </div>
      <div class="vault-panel__stat">
        <div class="vault-panel__label">Executor</div>
        <div class="vault-panel__value mono">{{ initiaState.executorAuthorized ? 'authorized' : 'not authorized' }}</div>
      </div>
    </div>

    <div class="vault-panel__controls">
      <button class="btn btn-ghost btn-sm" :disabled="busy" @click="handleConnectOrWallet">
        {{ connected ? 'Wallet' : 'Connect' }}
      </button>

      <button
        class="btn btn-primary btn-sm"
        :disabled="busy || !connected"
        @click="handleCreateAgentOnchain"
      >
        {{ localBusy === 'create' ? 'Creating…' : 'Create Onchain Agent' }}
      </button>

      <input
        v-model="nativeAmount"
        type="number"
        min="0"
        step="0.0001"
        class="vault-panel__amount"
        placeholder="Native amount"
      >

      <button
        class="btn btn-success btn-sm"
        :disabled="busy || !connected || !hasAgent"
        @click="handleDepositNative"
      >
        {{ localBusy === 'deposit' ? 'Depositing…' : 'Deposit GAS' }}
      </button>

      <button
        class="btn btn-ghost btn-sm"
        :disabled="busy || !connected || !hasAgent"
        @click="handleWithdrawNative"
      >
        {{ localBusy === 'withdraw' ? 'Withdrawing…' : 'Withdraw GAS' }}
      </button>

      <input
        v-model="tokenAmount"
        type="number"
        min="0"
        step="0.0001"
        class="vault-panel__amount"
        placeholder="Showcase amount"
      >

      <button
        class="btn btn-success btn-sm"
        :disabled="busy || !connected || !hasAgent"
        @click="handleDepositToken"
      >
        {{ localBusy === 'depositToken' ? 'Depositing…' : 'Deposit Token' }}
      </button>

      <button
        class="btn btn-ghost btn-sm"
        :disabled="busy || !connected || !hasAgent"
        @click="handleWithdrawToken"
      >
        {{ localBusy === 'withdrawToken' ? 'Withdrawing…' : 'Withdraw Token' }}
      </button>

      <button
        class="btn btn-ghost btn-sm"
        :disabled="busy || !connected || !hasAgent"
        @click="handleAuthorizeExecutor"
      >
        {{ localBusy === 'authorizeExecutor' ? 'Authorizing…' : 'Authorize Executor' }}
      </button>

      <button
        class="btn btn-ghost btn-sm"
        :disabled="busy || !connected || !hasAgent || initiaState.autoSignEnabled"
        @click="handleEnableAutoSign"
      >
        {{ localBusy === 'enableAutoSign' ? 'Enabling…' : 'Enable Auto-Sign' }}
      </button>

      <button
        class="btn btn-ghost btn-sm"
        :disabled="busy || !connected || !hasAgent || !initiaState.autoSignEnabled"
        @click="handleDisableAutoSign"
      >
        {{ localBusy === 'disableAutoSign' ? 'Disabling…' : 'Disable Auto-Sign' }}
      </button>

      <button
        class="btn btn-ghost btn-sm"
        :disabled="busy || !connected || !hasAgent"
        @click="handleExecuteTick"
      >
        {{ localBusy === 'executeTick' ? 'Running…' : 'Execute Tick' }}
      </button>
    </div>

    <div class="vault-panel__status-row">
      <span class="mono">chain: {{ initiaState.chainOk ? 'ok' : 'err' }}</span>
      <span class="mono">bridge: {{ initiaState.ready ? 'ready' : 'init' }}</span>
      <span class="mono">wallet: {{ connected ? 'connected' : 'disconnected' }}</span>
      <span class="mono">sync: {{ props.agentId ? 'agent-linked' : 'local-only' }}</span>
    </div>

    <div v-if="actionTxHashes.length > 0" class="vault-panel__tx mono">
      <div v-for="hash in actionTxHashes" :key="hash">tx: {{ hash }}</div>
    </div>
    <div v-if="actionError || initiaState.error" class="vault-panel__error">
      {{ actionError || initiaState.error }}
    </div>
  </section>
</template>

<style scoped>
.vault-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  padding: 14px;
  margin-bottom: 14px;
}

.vault-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.vault-panel__title {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.vault-panel__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}

.vault-panel__stat {
  border: 1px solid var(--border);
  padding: 8px;
  background: color-mix(in srgb, var(--bg-card) 90%, transparent);
}

.vault-panel__label {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
}

.vault-panel__value {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
}

.vault-panel__controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.vault-panel__amount {
  height: 28px;
  min-width: 140px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  padding: 0 8px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.vault-panel__status-row {
  margin-top: 8px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--text-muted);
  font-size: 11px;
}

.vault-panel__tx {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-all;
  display: grid;
  gap: 4px;
}

.vault-panel__error {
  margin-top: 8px;
  border: 1px solid var(--red-dim, #2a1414);
  background: var(--red-dim, #2a1414);
  color: var(--red);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
  padding: 8px 10px;
  border-radius: var(--radius);
}

@media (max-width: 1100px) {
  .vault-panel__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .vault-panel__stats {
    grid-template-columns: 1fr;
  }
}
</style>
