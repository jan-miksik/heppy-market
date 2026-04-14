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
const {
  state: initiaState,
  openConnect,
  openBridge,
  refresh,
  mintShowcaseToken,
  depositShowcaseToken,
  withdrawShowcaseToken,
  enableAutoSign,
} = useInitiaBridge();
const autoSignMgr = useAutoSign();
const { request } = useApi();
const {
  consentModalOpen,
  runWithAutoSignCheck,
  handleConsentProceed,
  handleConsentCancel,
} = useAutoSignConsent({ autoSignMgr, enableAutoSign });
const BRIDGE_SRC_CHAIN_ID = 'initiation-2';
const BRIDGE_SRC_DENOM = 'uinit';

const isOpen = ref(false);
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

const WALLET_STATE_TIMEOUT_MS = 30_000;
const WALLET_STATE_POLL_MS = 250;

async function ensureWalletConnected() {
  await refresh();
  if (initiaState.value.initiaAddress) return;

  await openConnect();
  const startedAt = Date.now();
  while (Date.now() - startedAt < WALLET_STATE_TIMEOUT_MS) {
    await refresh();
    if (initiaState.value.initiaAddress) return;
    await new Promise((resolve) => setTimeout(resolve, WALLET_STATE_POLL_MS));
  }
  throw new Error('Wallet connection was not detected. Finish wallet connect and try again.');
}

async function handleFund() {
  const amt = Number(amount.value);
  if (!Number.isFinite(amt) || amt <= 0) {
    error.value = 'Enter a valid amount greater than zero.';
    return;
  }
  clearMessages();
  funding.value = true;
  try {
    await ensureWalletConnected();
    const result = await depositShowcaseToken(String(amt));

    const newBalance = (props.currentBalance ?? 0) + amt;
    await updateAgent(props.agentId, { paperBalance: newBalance });

    await request(`/api/agents/${props.agentId}/initia/sync`, {
      method: 'POST',
      body: {
        state: {
          walletAddress: initiaState.value.initiaAddress,
          evmAddress: initiaState.value.evmAddress ?? undefined,
          onchainAgentId: initiaState.value.onchainAgentId ?? undefined,
          chainOk: initiaState.value.chainOk,
          existsOnchain: initiaState.value.agentExists,
          autoSignEnabled: initiaState.value.autoSignEnabled,
          walletBalanceWei: initiaState.value.walletBalanceWei ?? undefined,
          walletShowcaseTokenBalanceWei: initiaState.value.walletShowcaseTokenBalanceWei ?? undefined,
          showcaseTokenBalanceWei: initiaState.value.showcaseTokenBalanceWei ?? undefined,
          vaultBalanceWei: initiaState.value.vaultBalanceWei ?? undefined,
          lastTxHash: initiaState.value.lastTxHash ?? undefined,
          syncTrigger: 'detail-step-deposit',
        },
      },
      silent: true,
    }).catch(console.warn);

    successMsg.value = `Deposited ${amt.toLocaleString()} iUSD-demo.${result.txHash ? ` tx: ${result.txHash}` : ''}`;
    emit('done', newBalance);
  } catch (e) {
    error.value = extractApiError(e);
  } finally {
    funding.value = false;
  }
}

async function handleWithdraw() {
  const amt = Number(amount.value);
  if (!Number.isFinite(amt) || amt <= 0) {
    error.value = 'Enter a valid amount greater than zero.';
    return;
  }
  const newBalance = Math.max(0, (props.currentBalance ?? 0) - amt);
  clearMessages();
  withdrawing.value = true;
  try {
    await ensureWalletConnected();
    const result = await withdrawShowcaseToken(String(amt));

    await updateAgent(props.agentId, { paperBalance: newBalance });

    await request(`/api/agents/${props.agentId}/initia/sync`, {
      method: 'POST',
      body: {
        state: {
          walletAddress: initiaState.value.initiaAddress,
          evmAddress: initiaState.value.evmAddress ?? undefined,
          onchainAgentId: initiaState.value.onchainAgentId ?? undefined,
          chainOk: initiaState.value.chainOk,
          existsOnchain: initiaState.value.agentExists,
          autoSignEnabled: initiaState.value.autoSignEnabled,
          walletBalanceWei: initiaState.value.walletBalanceWei ?? undefined,
          walletShowcaseTokenBalanceWei: initiaState.value.walletShowcaseTokenBalanceWei ?? undefined,
          showcaseTokenBalanceWei: initiaState.value.showcaseTokenBalanceWei ?? undefined,
          vaultBalanceWei: initiaState.value.vaultBalanceWei ?? undefined,
          lastTxHash: initiaState.value.lastTxHash ?? undefined,
          syncTrigger: 'detail-step-withdraw',
        },
      },
      silent: true,
    }).catch(console.warn);

    successMsg.value = `Withdrew ${amt.toLocaleString()} iUSD-demo.${result.txHash ? ` tx: ${result.txHash}` : ''}`;
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
  await runWithAutoSignCheck('mintShowcaseToken', async () => {
    mintingFaucet.value = true;
    try {
      await ensureWalletConnected();
      const autoSign = autoSignMgr.isEnabled('mintShowcaseToken') && autoSignMgr.chainAutoSignGrantEnabled.value;
      const result = await mintShowcaseToken(String(amt), { autoSign });
      await refresh();
      successMsg.value = `Minted ${amt.toLocaleString()} iUSD-demo.${result.txHash ? ` tx: ${result.txHash}` : ''}`;
    } catch (e) {
      error.value = extractApiError(e);
    } finally {
      mintingFaucet.value = false;
    }
  });
}

const busy = computed(() => funding.value || withdrawing.value || bridging.value || mintingFaucet.value);
</script>

<template>
  <button class="btn btn-ghost btn-sm" title="Deposit / Withdraw" @click="open">
    $ Deposit / Withdraw
  </button>

  <Teleport to="body">
    <Transition name="fund-modal">
      <div v-if="isOpen" class="fund-backdrop" @click.self="close">
        <div class="fund-modal fund-step" role="dialog" aria-modal="true">
          <div class="fund-step__surface">
            <button class="fund-modal__close" aria-label="Close" @click="close">✕</button>

            <div class="fund-step__header">
              <span class="fund-step__title">Agent vault</span>
            </div>

            <div class="fund-step__wallet-row">
              <span class="fund-step__bal-key">agent balance</span>
              <span class="fund-step__bal-val">{{ (currentBalance ?? 0).toLocaleString() }} iUSD-demo</span>
            </div>

            <div v-if="walletDisplay" class="fund-step__wallet-row">
              <span class="fund-step__bal-key">wallet balance</span>
              <span class="fund-step__bal-val">{{ walletDisplay }} iUSD-demo</span>
            </div>

            <div class="fund-step__input-row">
              <input
                v-model="amount"
                type="number"
                min="0.0001"
                step="0.0001"
                class="fund-step__input"
                placeholder="1000"
                :disabled="busy"
                @focus="clearMessages"
              >
              <span class="fund-step__currency">iUSD-demo</span>
            </div>

            <div v-if="successMsg" class="fund-step__feedback fund-step__feedback--ok">{{ successMsg }}</div>
            <div v-if="error" class="fund-step__feedback fund-step__feedback--err">{{ error }}</div>

            <div class="fund-step__actions">
              <button
                class="fund-step__btn fund-step__btn--primary"
                :disabled="busy"
                @click="handleFund"
              >
                <span v-if="funding" class="spinner" style="width:12px;height:12px;border-color:#0003;border-top-color:#0a0a0a" />
                {{ funding ? 'Depositing…' : 'Deposit' }}
              </button>
              <button
                class="fund-step__btn fund-step__btn--ghost"
                :disabled="busy"
                @click="handleWithdraw"
              >
                <span v-if="withdrawing" class="spinner" style="width:12px;height:12px;" />
                {{ withdrawing ? 'Withdrawing…' : 'Withdraw' }}
              </button>
              <button
                class="fund-step__btn fund-step__btn--bridge"
                :disabled="busy"
                @click="handleBridge"
              >
                <span v-if="bridging" class="spinner" style="width:12px;height:12px;" />
                {{ bridging ? 'Opening…' : 'Bridge' }}
              </button>
            </div>

            <div class="fund-step__bridge-note">
              <div class="fund-step__bridge-note-title">Hackathon bridge note</div>
              <p>
                Local dev limitation: Interwoven Bridge resolves registered chain IDs only, so your local appchain or token route may not render.
                We still keep bridge in this flow because it demonstrates the hackathon path: bridge assets from L1 to appchain, then deposit into the agent vault.
                This improves onboarding speed, liquidity access, and immediate utility.
              </p>
            </div>

            <div class="fund-step__faucet">
              <div class="fund-step__faucet-title">iUSD-demo faucet</div>
              <div class="fund-step__input-row">
                <input
                  v-model="faucetAmount"
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  class="fund-step__input"
                  placeholder="1000"
                  :disabled="busy"
                  @focus="clearMessages"
                >
                <span class="fund-step__currency">iUSD-demo</span>
              </div>
              <button
                class="fund-step__btn fund-step__btn--faucet"
                :disabled="busy"
                @click="handleMintFaucet"
              >
                <span v-if="mintingFaucet" class="spinner" style="width:12px;height:12px;" />
                {{ mintingFaucet ? 'Minting…' : 'Mint Faucet Tokens' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <AutoSignConsentModal
    :open="consentModalOpen"
    @proceed="handleConsentProceed"
    @cancel="handleConsentCancel"
  />
</template>

<style scoped>
.fund-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.72);
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.fund-modal {
  width: min(100%, 440px);
  position: relative;
}

.fund-modal__close {
  position: absolute;
  top: 14px;
  right: 14px;
  background: none;
  border: none;
  color: var(--text-muted, #555);
  font-size: 13px;
  cursor: pointer;
  padding: 4px;
  line-height: 1;
  transition: color 0.1s;
  z-index: 2;
}
.fund-modal__close:hover { color: var(--text, #e0e0e0); }

.fund-step__surface {
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 6px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.fund-step__header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.fund-step__title {
  flex: 1;
  font-family: 'Space Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
}

.fund-step__desc {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-muted, #555);
  margin: 0;
}

.fund-step__wallet-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--border, #2a2a2a) 20%, transparent);
  border-radius: 3px;
}

.fund-step__bal-key {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-muted, #555);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.fund-step__bal-val {
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  color: var(--text, #e0e0e0);
}

.fund-step__input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fund-step__input {
  flex: 1;
  height: 38px;
  background: var(--bg, #0a0a0a);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 3px;
  color: var(--text, #e0e0e0);
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  padding: 0 12px;
  outline: none;
  transition: border-color 0.12s;
}
.fund-step__input:focus { border-color: var(--accent, #7c6af7); }
.fund-step__input:disabled { opacity: 0.4; }

.fund-step__currency {
  font-family: 'Space Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-muted, #555);
  white-space: nowrap;
}

.fund-step__feedback {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  padding: 6px 10px;
  border-radius: 4px;
}
.fund-step__feedback--ok {
  color: #4ade80;
  background: color-mix(in srgb, #4ade80 8%, transparent);
  border: 1px solid color-mix(in srgb, #4ade80 20%, transparent);
}
.fund-step__feedback--err {
  color: #e55;
  background: color-mix(in srgb, #e55 8%, transparent);
  border: 1px solid color-mix(in srgb, #e55 20%, transparent);
}

.fund-step__actions {
  display: flex;
  gap: 8px;
}

.fund-step__btn {
  flex: 1;
  height: 34px;
  border-radius: 3px;
  border: 1px solid var(--border, #2a2a2a);
  background: transparent;
  color: var(--text, #e0e0e0);
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  transition: opacity 0.12s, border-color 0.12s, background 0.12s;
  min-height: 2.5rem;
}

.fund-step__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.fund-step__btn--primary {
  background: #e0e0e0;
  color: #0a0a0a;
  border-color: transparent;
}

.fund-step__btn--primary:not(:disabled):hover {
  background: #fff;
}

.fund-step__btn--ghost:not(:disabled):hover {
  border-color: #555;
  color: #fff;
}

.fund-step__btn--bridge {
  color: #f59e0b;
  border-color: color-mix(in srgb, #f59e0b 40%, var(--border, #2a2a2a));
}

.fund-step__btn--bridge:not(:disabled):hover {
  background: color-mix(in srgb, #f59e0b 10%, transparent);
}

.fund-step__bridge-note {
  border: 1px solid color-mix(in srgb, #f59e0b 30%, var(--border, #2a2a2a));
  background: color-mix(in srgb, #f59e0b 8%, transparent);
  border-radius: 4px;
  padding: 10px;
}

.fund-step__bridge-note-title {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #f59e0b;
  margin-bottom: 6px;
}

.fund-step__bridge-note p {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  line-height: 1.6;
  color: var(--text-muted, #a7a7a7);
}

.fund-step__faucet {
  border: 1px solid color-mix(in srgb, #4ade80 30%, var(--border, #2a2a2a));
  background: color-mix(in srgb, #4ade80 9%, transparent);
  border-radius: 4px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fund-step__faucet-title {
  font-family: 'Space Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #4ade80;
}

.fund-step__btn--faucet {
  border-color: color-mix(in srgb, #4ade80 45%, var(--border, #2a2a2a));
  color: #4ade80;
  background: color-mix(in srgb, #4ade80 10%, transparent);
}

.fund-step__btn--faucet:not(:disabled):hover {
  background: color-mix(in srgb, #4ade80 16%, transparent);
}

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
