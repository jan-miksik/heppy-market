<script setup lang="ts">
defineProps<{
  currentPaperBalance: number;
  walletIusdDisplay: string | null;
  walletGasDisplay: string | null;
  fundAmount: string;
  faucetAmount: string;
  busy: boolean;
  funding: boolean;
  withdrawing: boolean;
  bridging: boolean;
  mintingFaucet: boolean;
  toppingUpGas: boolean;
}>();

const emit = defineEmits<{
  'update:fundAmount': [value: string];
  'update:faucetAmount': [value: string];
  deposit: [];
  withdraw: [];
  bridge: [];
  mintFaucet: [];
  topUpGas: [];
  clearFeedback: [];
}>();
</script>

<template>
  <div class="fund-step">
    <div class="fund-step__surface">
      <div class="fund-step__header">
        <span class="fund-step__title">Fund agent vault</span>
      </div>

      <div class="fund-step__wallet-row">
        <span class="fund-step__bal-key">agent balance</span>
        <span class="fund-step__bal-val">{{ currentPaperBalance.toLocaleString() }} iUSD-demo</span>
      </div>

      <div v-if="walletIusdDisplay" class="fund-step__wallet-row">
        <span class="fund-step__bal-key">wallet balance</span>
        <span class="fund-step__bal-val">{{ walletIusdDisplay }} iUSD-demo</span>
      </div>

      <div v-if="walletGasDisplay" class="fund-step__wallet-row">
        <span class="fund-step__bal-key">wallet fee balance</span>
        <span class="fund-step__bal-val">{{ walletGasDisplay }} GAS</span>
      </div>

      <div class="fund-step__input-row">
        <input
          :value="fundAmount"
          type="number"
          min="0.0001"
          step="0.0001"
          class="fund-step__input"
          placeholder="1000"
          :disabled="busy"
          @focus="emit('clearFeedback')"
          @input="emit('update:fundAmount', ($event.target as HTMLInputElement).value)"
        >
        <span class="fund-step__currency">iUSD-demo</span>
      </div>

      <div class="fund-step__actions">
        <button class="fund-step__btn fund-step__btn--primary" :disabled="busy" @click="emit('deposit')">
          <span v-if="funding" class="spinner" style="width:12px;height:12px;border-color:#0003;border-top-color:#0a0a0a" />
          {{ funding ? 'Depositing...' : 'Deposit' }}
        </button>
        <button class="fund-step__btn fund-step__btn--ghost" :disabled="busy" @click="emit('withdraw')">
          <span v-if="withdrawing" class="spinner" style="width:12px;height:12px;" />
          {{ withdrawing ? 'Withdrawing...' : 'Withdraw' }}
        </button>
        <button class="fund-step__btn fund-step__btn--bridge" :disabled="busy" @click="emit('bridge')">
          <span v-if="bridging" class="spinner" style="width:12px;height:12px;" />
          {{ bridging ? 'Opening...' : 'Bridge' }}
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

      <div class="fund-step__faucet fund-step__faucet--gas">
        <div class="fund-step__faucet-title">Test GAS top-up</div>
        <p class="fund-step__hint">
          Contract actions pay fees in native GAS. If this wallet is empty, top it up before minting or depositing.
        </p>
        <button class="fund-step__btn fund-step__btn--gas" :disabled="busy" @click="emit('topUpGas')">
          <span v-if="toppingUpGas" class="spinner" style="width:12px;height:12px;" />
          {{ toppingUpGas ? 'Funding...' : 'Get Test GAS' }}
        </button>
      </div>

      <div class="fund-step__faucet">
        <div class="fund-step__faucet-title">iUSD-demo faucet</div>
        <div class="fund-step__input-row">
          <input
            :value="faucetAmount"
            type="number"
            min="0.0001"
            step="0.0001"
            class="fund-step__input"
            placeholder="1000"
            :disabled="busy"
            @focus="emit('clearFeedback')"
            @input="emit('update:faucetAmount', ($event.target as HTMLInputElement).value)"
          >
          <span class="fund-step__currency">iUSD-demo</span>
        </div>
        <button class="fund-step__btn fund-step__btn--faucet" :disabled="busy" @click="emit('mintFaucet')">
          <span v-if="mintingFaucet" class="spinner" style="width:12px;height:12px;" />
          {{ mintingFaucet ? 'Minting...' : 'Mint Faucet Tokens' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fund-step {
  max-width: 440px;
  margin: 0 auto;
  width: 100%;
}

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

.fund-step__btn--primary:not(:disabled):hover { background: #fff; }

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

.fund-step__hint {
  margin: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  line-height: 1.6;
  color: var(--text-muted, #a7a7a7);
}

.fund-step__faucet--gas {
  border-color: color-mix(in srgb, #38bdf8 30%, var(--border, #2a2a2a));
  background: color-mix(in srgb, #38bdf8 9%, transparent);
}

.fund-step__btn--gas {
  border-color: color-mix(in srgb, #38bdf8 45%, var(--border, #2a2a2a));
  color: #38bdf8;
  background: color-mix(in srgb, #38bdf8 10%, transparent);
}

.fund-step__btn--gas:not(:disabled):hover {
  background: color-mix(in srgb, #38bdf8 16%, transparent);
}

.fund-step__btn--faucet {
  border-color: color-mix(in srgb, #4ade80 45%, var(--border, #2a2a2a));
  color: #4ade80;
  background: color-mix(in srgb, #4ade80 10%, transparent);
}

.fund-step__btn--faucet:not(:disabled):hover {
  background: color-mix(in srgb, #4ade80 16%, transparent);
}
</style>
