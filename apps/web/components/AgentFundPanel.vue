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
const { state: initiaState, openConnect, openBridge, refresh, mintShowcaseToken } = useInitiaBridge();
const BRIDGE_SRC_CHAIN_ID = 'initiation-2';
const BRIDGE_SRC_DENOM = 'uinit';

const isOpen = ref(false);
const tab = ref<'deposit' | 'withdraw'>('deposit');
const amount = ref('1000');
const faucetAmount = ref('1000');
const funding = ref(false);
const withdrawing = ref(false);
const bridging = ref(false);
const mintingFaucet = ref(false);
const error = ref('');
const successMsg = ref('');

function open() {
  isOpen.value = true;
  amount.value = '1000';
  faucetAmount.value = '1000';
  error.value = '';
  successMsg.value = '';
}

function close() {
  isOpen.value = false;
  error.value = '';
  successMsg.value = '';
}

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

const walletDisplay = computed(() => formatWei(initiaState.value.walletShowcaseTokenBalanceWei));

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
    successMsg.value = `Funded — balance set to ${amt.toLocaleString()} iUSD-demo`;
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
    error.value = 'Enter a valid amount.';
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

async function handleMintFaucet() {
  const amt = Number(faucetAmount.value);
  if (!Number.isFinite(amt) || amt <= 0) {
    error.value = 'Enter a valid faucet amount greater than zero.';
    return;
  }
  clearMessages();
  mintingFaucet.value = true;
  try {
    if (!initiaState.value.initiaAddress) {
      await openConnect();
    }
    const result = await mintShowcaseToken(String(amt));
    await refresh();
    successMsg.value = `Minted ${amt.toLocaleString()} iUSD-demo.${result.txHash ? ` tx: ${result.txHash}` : ''}`;
  } catch (e) {
    error.value = extractApiError(e);
  } finally {
    mintingFaucet.value = false;
  }
}

const busy = computed(() => funding.value || withdrawing.value || bridging.value || mintingFaucet.value);
</script>

<template>
  <!-- Trigger button -->
  <button class="btn btn-ghost btn-sm" title="Deposit / Withdraw" @click="open">
    $ Deposit / Withdraw
  </button>

  <!-- Modal backdrop -->
  <Teleport to="body">
    <Transition name="fund-modal">
      <div v-if="isOpen" class="fund-backdrop" @click.self="close">
        <div class="fund-modal" role="dialog" aria-modal="true">

          <!-- Header -->
          <div class="fund-modal__head">
            <span class="fund-modal__title">iUSD-DEMO VAULT</span>
            <button class="fund-modal__close" aria-label="Close" @click="close">✕</button>
          </div>

          <!-- Balance row -->
          <div class="fund-modal__balances">
            <div class="fund-modal__bal-row">
              <span class="fund-modal__bal-key">agent balance</span>
              <span class="fund-modal__bal-val">${{ (currentBalance ?? 0).toLocaleString() }}</span>
            </div>
            <div v-if="walletDisplay" class="fund-modal__bal-row">
              <span class="fund-modal__bal-key">wallet iUSD-demo</span>
              <span class="fund-modal__bal-val">{{ walletDisplay }}</span>
            </div>
          </div>

          <div class="fund-modal__faucet">
            <div class="fund-modal__faucet-title">iUSD-demo faucet</div>
            <div class="fund-modal__input-row">
              <input
                v-model="faucetAmount"
                type="number"
                min="0.0001"
                step="0.0001"
                class="fund-modal__input"
                placeholder="1000"
                :disabled="busy"
                @focus="clearMessages"
              >
              <span class="fund-modal__currency">iUSD-demo</span>
            </div>
            <button
              class="fund-modal__btn fund-modal__btn--faucet"
              :disabled="busy"
              @click="handleMintFaucet"
            >
              <span v-if="mintingFaucet" class="spinner" style="width:11px;height:11px;" />
              {{ mintingFaucet ? 'Minting…' : 'Mint Faucet Tokens' }}
            </button>
          </div>

          <!-- Tab toggle -->
          <div class="fund-modal__tabs">
            <button
              class="fund-modal__tab"
              :class="{ 'fund-modal__tab--active': tab === 'deposit' }"
              @click="tab = 'deposit'; clearMessages()"
            >Deposit</button>
            <button
              class="fund-modal__tab"
              :class="{ 'fund-modal__tab--active': tab === 'withdraw' }"
              @click="tab = 'withdraw'; clearMessages()"
            >Withdraw</button>
          </div>

          <!-- Amount input -->
          <div class="fund-modal__input-row">
            <input
              v-model="amount"
              type="number"
              min="0"
              step="100"
              class="fund-modal__input"
              placeholder="Amount"
              :disabled="busy"
              @focus="clearMessages"
            >
            <span class="fund-modal__currency">iUSD-demo</span>
          </div>

          <!-- Quick presets -->
          <div class="fund-modal__presets">
            <button
              v-for="preset in [500, 1000, 5000, 10000]"
              :key="preset"
              class="fund-modal__preset"
              :disabled="busy"
              @click="amount = String(preset)"
            >{{ preset >= 1000 ? `${preset / 1000}k` : preset }}</button>
          </div>

          <!-- Feedback -->
          <div v-if="successMsg" class="fund-modal__feedback fund-modal__feedback--ok">{{ successMsg }}</div>
          <div v-if="error" class="fund-modal__feedback fund-modal__feedback--err">{{ error }}</div>

          <!-- Actions -->
          <div class="fund-modal__actions">
            <button
              v-if="tab === 'deposit'"
              class="fund-modal__btn fund-modal__btn--primary"
              :disabled="busy"
              @click="handleFund"
            >
              <span v-if="funding" class="spinner" style="width:11px;height:11px;border-color:#0003;border-top-color:#0a0a0a" />
              {{ funding ? 'Funding…' : 'Deposit' }}
            </button>
            <button
              v-else
              class="fund-modal__btn fund-modal__btn--primary"
              :disabled="busy"
              @click="handleWithdraw"
            >
              <span v-if="withdrawing" class="spinner" style="width:11px;height:11px;border-color:#0003;border-top-color:#0a0a0a" />
              {{ withdrawing ? 'Withdrawing…' : 'Withdraw' }}
            </button>
            <button
              class="fund-modal__btn fund-modal__btn--bridge"
              :disabled="busy"
              @click="handleBridge"
            >
              <span v-if="bridging" class="spinner" style="width:11px;height:11px;" />
              {{ bridging ? 'Opening…' : '⇌ Bridge' }}
            </button>
          </div>

          <!-- Bridge note -->
          <div class="fund-modal__bridge-note">
            <div class="fund-modal__bridge-note-title">Hackathon bridge note</div>
            <p>
              Local dev limitation: Interwoven Bridge resolves registered chain IDs only, so your local appchain or
              token route may not render. Bridge stays in this flow to demonstrate the hackathon path: bridge assets
              from L1 to appchain, then deposit into the agent vault.
            </p>
          </div>

        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ── Backdrop ── */
.fund-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.72);
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ── Modal ── */
.fund-modal {
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
  width: 340px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
  position: relative;
}

/* ── Header ── */
.fund-modal__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.fund-modal__title {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--text-muted, #555);
  flex: 1;
}
.fund-modal__badge {
  font-family: 'Space Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #f59e0b;
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  border: 1px solid color-mix(in srgb, #f59e0b 25%, transparent);
  padding: 2px 6px;
}
.fund-modal__close {
  background: none;
  border: none;
  color: var(--text-muted, #555);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  transition: color 0.1s;
}
.fund-modal__close:hover { color: var(--text, #e0e0e0); }

/* ── Balances ── */
.fund-modal__balances {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px;
  background: var(--bg, #0a0a0a);
  border: 1px solid var(--border, #1e1e1e);
}
.fund-modal__bal-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.fund-modal__bal-key {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted, #444);
}
.fund-modal__bal-val {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  font-weight: 500;
  color: var(--text, #e0e0e0);
}

/* ── Tabs ── */
.fund-modal__tabs {
  display: flex;
  border: 1px solid var(--border, #2a2a2a);
  overflow: hidden;
}
.fund-modal__tab {
  flex: 1;
  padding: 7px;
  background: none;
  border: none;
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}
.fund-modal__tab + .fund-modal__tab {
  border-left: 1px solid var(--border, #2a2a2a);
}
.fund-modal__tab--active {
  background: var(--border, #2a2a2a);
  color: var(--text, #e0e0e0);
}

/* ── Input ── */
.fund-modal__input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.fund-modal__input {
  flex: 1;
  height: 36px;
  background: var(--bg, #0a0a0a);
  border: 1px solid var(--border, #2a2a2a);
  color: var(--text, #e0e0e0);
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  padding: 0 10px;
  outline: none;
  transition: border-color 0.12s;
}
.fund-modal__input:focus { border-color: var(--accent, #7c6af7); }
.fund-modal__input:disabled { opacity: 0.4; }
.fund-modal__currency {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-muted, #555);
  white-space: nowrap;
}

/* ── Presets ── */
.fund-modal__presets {
  display: flex;
  gap: 5px;
}
.fund-modal__preset {
  flex: 1;
  padding: 4px 0;
  background: none;
  border: 1px solid var(--border, #2a2a2a);
  color: var(--text-muted, #555);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  cursor: pointer;
  transition: border-color 0.1s, color 0.1s;
}
.fund-modal__preset:not(:disabled):hover {
  border-color: var(--accent, #7c6af7);
  color: var(--text, #e0e0e0);
}
.fund-modal__preset:disabled { opacity: 0.35; cursor: not-allowed; }

/* ── Feedback ── */
.fund-modal__feedback {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  padding: 6px 10px;
  border-radius: 0;
}
.fund-modal__feedback--ok {
  color: #4ade80;
  background: color-mix(in srgb, #4ade80 8%, transparent);
  border: 1px solid color-mix(in srgb, #4ade80 20%, transparent);
}
.fund-modal__feedback--err {
  color: #e55;
  background: color-mix(in srgb, #e55 8%, transparent);
  border: 1px solid color-mix(in srgb, #e55 20%, transparent);
}

/* ── Actions ── */
.fund-modal__actions {
  display: flex;
  gap: 8px;
}
.fund-modal__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border: none;
  cursor: pointer;
  transition: background 0.1s, opacity 0.1s;
}
.fund-modal__btn:disabled { opacity: 0.35; cursor: not-allowed; }
.fund-modal__btn--primary {
  flex: 1;
  background: #e0e0e0;
  color: #0a0a0a;
  justify-content: center;
}
.fund-modal__btn--primary:not(:disabled):hover { background: #fff; }
.fund-modal__btn--bridge {
  background: none;
  border: 1px solid color-mix(in srgb, #f59e0b 35%, #2a2a2a);
  color: #f59e0b;
}
.fund-modal__btn--bridge:not(:disabled):hover {
  background: color-mix(in srgb, #f59e0b 10%, transparent);
}

/* ── Bridge note ── */
.fund-modal__bridge-note {
  border: 1px solid color-mix(in srgb, #f59e0b 30%, var(--border, #2a2a2a));
  background: color-mix(in srgb, #f59e0b 8%, transparent);
  border-radius: 4px;
  padding: 8px 10px;
}
.fund-modal__bridge-note-title {
  font-family: 'Space Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #f59e0b;
  margin-bottom: 4px;
}
.fund-modal__bridge-note p {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  line-height: 1.55;
  color: var(--text-muted, #a7a7a7);
}

.fund-modal__faucet {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid color-mix(in srgb, #4ade80 28%, var(--border, #2a2a2a));
  background: color-mix(in srgb, #4ade80 8%, transparent);
  border-radius: 4px;
  padding: 9px 10px;
}

.fund-modal__faucet-title {
  font-family: 'Space Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #4ade80;
}

.fund-modal__btn--faucet {
  justify-content: center;
  border: 1px solid color-mix(in srgb, #4ade80 45%, var(--border, #2a2a2a));
  color: #4ade80;
  background: color-mix(in srgb, #4ade80 10%, transparent);
}

.fund-modal__btn--faucet:not(:disabled):hover {
  background: color-mix(in srgb, #4ade80 18%, transparent);
}

/* ── Transitions ── */
.fund-modal-enter-active,
.fund-modal-leave-active {
  transition: opacity 0.15s ease;
}
.fund-modal-enter-from,
.fund-modal-leave-to {
  opacity: 0;
}
.fund-modal-enter-active .fund-modal,
.fund-modal-leave-active .fund-modal {
  transition: transform 0.15s ease;
}
.fund-modal-enter-from .fund-modal {
  transform: translateY(-8px);
}
.fund-modal-leave-to .fund-modal {
  transform: translateY(-4px);
}
</style>
