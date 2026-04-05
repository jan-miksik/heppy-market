<script setup lang="ts">
const props = withDefaults(defineProps<{
  agentId: string;
  currentBalance?: number;
  showSkip?: boolean;
}>(), {
  currentBalance: 10_000,
  showSkip: false,
});

const emit = defineEmits<{
  done: [newBalance: number];
  skip: [];
}>();

const { updateAgent } = useAgents();
const { state: initiaState, openConnect, openBridge } = useInitiaBridge();
const BRIDGE_SRC_CHAIN_ID = 'initiation-2';
const BRIDGE_SRC_DENOM = 'uinit';

const amount = ref(String(props.currentBalance ?? 1000));
const funding = ref(false);
const withdrawing = ref(false);
const bridging = ref(false);
const error = ref('');
const successMsg = ref('');

function formatWei(wei: string | null | undefined): string {
  if (!wei) return null as unknown as string;
  try {
    const n = BigInt(wei);
    const e18 = 1_000_000_000_000_000_000n;
    const whole = n / e18;
    const frac = n % e18;
    return `${whole}.${frac.toString().padStart(18, '0').slice(0, 2)}`;
  } catch {
    return null as unknown as string;
  }
}

const walletDisplay = computed(() => formatWei(initiaState.value.walletBalanceWei));

function clearMessages() {
  error.value = '';
  successMsg.value = '';
}

async function handleFund() {
  const amt = Number(amount.value);
  if (!Number.isFinite(amt) || amt < 0) {
    error.value = 'Enter a valid amount (0 or higher).';
    return;
  }
  clearMessages();
  funding.value = true;
  try {
    await updateAgent(props.agentId, { paperBalance: amt });
    successMsg.value = `Agent funded with ${amt.toLocaleString()} iUSD-demo`;
    emit('done', amt);
  } catch (e) {
    error.value = extractApiError(e);
  } finally {
    funding.value = false;
  }
}

async function handleWithdraw() {
  const amt = Number(amount.value);
  if (!Number.isFinite(amt) || amt <= 0) {
    error.value = 'Enter a valid amount';
    return;
  }
  const newBalance = Math.max(0, (props.currentBalance ?? 0) - amt);
  clearMessages();
  withdrawing.value = true;
  try {
    await updateAgent(props.agentId, { paperBalance: newBalance });
    successMsg.value = `Withdrew ${amt.toLocaleString()} iUSD-demo`;
    emit('done', newBalance);
  } catch (e) {
    error.value = extractApiError(e);
  } finally {
    withdrawing.value = false;
  }
}

async function handleBridge() {
  clearMessages();
  bridging.value = true;
  try {
    if (!initiaState.value.initiaAddress) {
      await openConnect();
      return;
    }
    await openBridge({ srcChainId: BRIDGE_SRC_CHAIN_ID, srcDenom: BRIDGE_SRC_DENOM, quantity: '0' });
  } catch (e) {
    error.value = extractApiError(e);
  } finally {
    bridging.value = false;
  }
}
</script>

<template>
  <div class="fund-panel">
    <div class="fund-panel__header">
      <span class="fund-panel__label">iUSD-demo vault</span>
      <span class="fund-panel__badge">paper mode</span>
    </div>

    <div class="fund-panel__balances">
      <div class="fund-panel__bal-row">
        <span class="fund-panel__bal-key">agent balance</span>
        <span class="fund-panel__bal-val">${{ (currentBalance ?? 0).toLocaleString() }}</span>
      </div>
      <div v-if="walletDisplay" class="fund-panel__bal-row">
        <span class="fund-panel__bal-key">wallet (iUSD-demo)</span>
        <span class="fund-panel__bal-val">{{ walletDisplay }}</span>
      </div>
    </div>

    <div class="fund-panel__input-row">
      <input
        v-model="amount"
        type="number"
        min="0"
        step="100"
        class="fund-panel__input"
        placeholder="Amount"
        :disabled="funding || withdrawing"
        @focus="clearMessages"
      >
      <span class="fund-panel__currency">iUSD</span>
    </div>

    <div class="fund-panel__actions">
      <button
        class="fund-panel__btn fund-panel__btn--primary"
        :disabled="funding || withdrawing || bridging"
        @click="handleFund"
      >
        <span v-if="funding" class="spinner" style="width:12px;height:12px;border-color:#0003;border-top-color:#0a0a0a" />
        {{ funding ? 'Funding…' : 'Fund Agent' }}
      </button>
      <button
        class="fund-panel__btn fund-panel__btn--ghost"
        :disabled="funding || withdrawing || bridging"
        @click="handleWithdraw"
      >
        <span v-if="withdrawing" class="spinner" style="width:12px;height:12px;" />
        {{ withdrawing ? 'Withdrawing…' : 'Withdraw' }}
      </button>
      <button
        class="fund-panel__btn fund-panel__btn--bridge"
        :disabled="funding || withdrawing || bridging"
        @click="handleBridge"
      >
        <span v-if="bridging" class="spinner" style="width:12px;height:12px;" />
        {{ bridging ? 'Opening…' : 'Bridge' }}
      </button>
    </div>

    <div v-if="successMsg" class="fund-panel__success">{{ successMsg }}</div>
    <div v-if="error" class="fund-panel__error">{{ error }}</div>

    <div class="fund-panel__meta">
      <span class="fund-panel__meta-item">○ auto-sign — placeholder</span>
      <span class="fund-panel__meta-sep">·</span>
      <span class="fund-panel__meta-item">GAS → iUSD (demo only)</span>
    </div>

    <div class="fund-panel__bridge-note">
      <div class="fund-panel__bridge-note-title">Hackathon bridge note</div>
      <p>
        Local dev limitation: Interwoven Bridge resolves registered chain IDs only, so local appchain/token routes may not render.
        Bridge is still surfaced here to demonstrate onboarding flow from L1 assets to appchain agent funding.
      </p>
    </div>

    <button v-if="showSkip" class="fund-panel__skip" @click="$emit('skip')">
      skip for now →
    </button>
  </div>
</template>

<style scoped>
.fund-panel {
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 6px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.fund-panel__header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.fund-panel__label {
  font-family: 'Space Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
  flex: 1;
}

.fund-panel__badge {
  font-family: 'Space Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #f59e0b;
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  border: 1px solid color-mix(in srgb, #f59e0b 25%, transparent);
  padding: 2px 7px;
  border-radius: 2px;
}

.fund-panel__balances {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.fund-panel__bal-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.fund-panel__bal-key {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-muted, #555);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.fund-panel__bal-val {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  color: var(--text, #e0e0e0);
  font-weight: 500;
}

.fund-panel__input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fund-panel__input {
  flex: 1;
  height: 36px;
  background: var(--bg, #0a0a0a);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 3px;
  color: var(--text, #e0e0e0);
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  padding: 0 10px;
  outline: none;
  transition: border-color 0.12s;
}

.fund-panel__input:focus {
  border-color: var(--accent, #7c6af7);
}

.fund-panel__input:disabled {
  opacity: 0.4;
}

.fund-panel__currency {
  font-family: 'Space Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-muted, #555);
  white-space: nowrap;
}

.fund-panel__actions {
  display: flex;
  gap: 8px;
}

.fund-panel__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  font-family: 'Space Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-radius: 3px;
  border: none;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}

.fund-panel__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.fund-panel__btn--primary {
  background: #e0e0e0;
  color: #0a0a0a;
}

.fund-panel__btn--primary:not(:disabled):hover {
  background: #fff;
}

.fund-panel__btn--ghost {
  background: none;
  border: 1px solid #2a2a2a;
  color: #666;
}

.fund-panel__btn--ghost:not(:disabled):hover {
  border-color: #555;
  color: #aaa;
}

.fund-panel__btn--bridge {
  background: none;
  border: 1px solid color-mix(in srgb, #f59e0b 35%, #2a2a2a);
  color: #f59e0b;
}

.fund-panel__btn--bridge:not(:disabled):hover {
  background: color-mix(in srgb, #f59e0b 10%, transparent);
}

.fund-panel__success {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: #4ade80;
  padding: 6px 10px;
  background: color-mix(in srgb, #4ade80 8%, transparent);
  border: 1px solid color-mix(in srgb, #4ade80 20%, transparent);
  border-radius: 3px;
}

.fund-panel__error {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: #e55;
  padding: 6px 10px;
  background: color-mix(in srgb, #e55 8%, transparent);
  border: 1px solid color-mix(in srgb, #e55 20%, transparent);
  border-radius: 3px;
}

.fund-panel__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
  border-top: 1px solid var(--border, #1e1e1e);
}

.fund-panel__meta-item {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-muted, #444);
  letter-spacing: 0.02em;
}

.fund-panel__meta-sep {
  color: var(--border, #333);
  font-size: 10px;
}

.fund-panel__bridge-note {
  border: 1px solid color-mix(in srgb, #f59e0b 30%, var(--border, #2a2a2a));
  background: color-mix(in srgb, #f59e0b 8%, transparent);
  border-radius: 4px;
  padding: 10px;
}

.fund-panel__bridge-note-title {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #f59e0b;
  margin-bottom: 6px;
}

.fund-panel__bridge-note p {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  line-height: 1.55;
  color: var(--text-muted, #999);
}

.fund-panel__skip {
  background: none;
  border: none;
  padding: 0;
  font-family: 'Space Mono', monospace;
  font-size: 11px;
  color: var(--text-muted, #555);
  cursor: pointer;
  letter-spacing: 0.04em;
  text-align: left;
  transition: color 0.12s;
}

.fund-panel__skip:hover {
  color: var(--accent, #7c6af7);
}
</style>
