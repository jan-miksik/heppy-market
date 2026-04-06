<script setup lang="ts">
definePageMeta({ ssr: false });

const runtimeConfig = useRuntimeConfig();
const { state: initiaState, openWallet: openInitiaWallet } = useInitiaBridge();

const contract = runtimeConfig.public.initiaContractAddress as string;
const chainId = runtimeConfig.public.initiaRollupChainId as string;
const evmChainId = runtimeConfig.public.initiaEvmChainId as string;

const copied = ref<string | null>(null);
const bridging = ref(false);

function formatWei(wei: string | null | undefined): string {
  if (!wei) return '—';
  try {
    const n = BigInt(wei);
    if (n === 0n) return '0.000000';
    const e18 = BigInt('1000000000000000000');
    const whole = n / e18;
    const frac = n % e18;
    return `${whole}.${frac.toString().padStart(18, '0').slice(0, 6)}`;
  } catch {
    return '—';
  }
}

async function copy(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = key;
    setTimeout(() => { copied.value = null; }, 1500);
  } catch {}
}

async function handleBridge() {
  bridging.value = true;
  try {
    await openInitiaWallet();
  } finally {
    bridging.value = false;
  }
}
</script>

<template>
  <div class="about-page">
    <div class="about-inner">

      <!-- Hero -->
      <section class="about-hero">
        <span class="about-eyebrow">about</span>
        <h1 class="about-title">initRoot</h1>
        <p class="about-desc">
          Autonomous AI trading agents on Initia. Deploy strategies, track performance,
          and let LLMs manage your portfolio in paper-trading mode — with on-chain vault
          integration via InterwovenKit.
        </p>
      </section>

            <!-- Network -->
            <section class="about-section">
        <span class="about-section-label">network</span>
        <div class="about-net-rows">
          <div class="about-net-row">
            <span class="about-net-key">app contract</span>
            <span class="about-net-val">{{ contract }}</span>
            <button
              class="copy-btn"
              :class="{ 'copy-btn--ok': copied === 'contract' }"
              @click="copy(contract, 'contract')"
            >{{ copied === 'contract' ? 'copied' : 'copy' }}</button>
          </div>
          <div class="about-net-row">
            <span class="about-net-key">chain</span>
            <span class="about-net-val">{{ chainId }}</span>
          </div>
          <div class="about-net-row">
            <span class="about-net-key">evm chain id</span>
            <span class="about-net-val">{{ evmChainId }}</span>
          </div>
        </div>
      </section>

      <!-- Balances + Bridge -->
      <section class="about-section about-section--bridge">
        <span class="about-section-label">balances</span>
        <div class="about-balances">
          <div class="about-balance-cell">
            <div class="about-balance-amount">{{ formatWei(initiaState.walletBalanceWei) }}</div>
            <div class="about-balance-unit">wallet · INIT</div>
          </div>
          <div class="about-balance-sep" />
          <div class="about-balance-cell">
            <div class="about-balance-amount">{{ formatWei(initiaState.vaultBalanceWei) }}</div>
            <div class="about-balance-unit">vault · INIT</div>
          </div>
        </div>
        <button class="about-bridge-btn" :disabled="bridging" @click="handleBridge">
          {{ bridging ? 'Opening…' : 'Bridge assets →' }}
        </button>
      </section>



      <!-- System bar -->
      <div class="about-sysbar">
        <span>⟨ initia · {{ initiaState.chainOk ? 'chain:ok' : 'chain:err' }} · {{ initiaState.ready ? 'bridge:ready' : 'bridge:init' }} ⟩</span>
        <span class="about-sysbar-dot" :class="initiaState.chainOk ? 'about-sysbar-dot--ok' : 'about-sysbar-dot--err'" />
      </div>

    </div>
  </div>
</template>

<style scoped>
/* ── Layout ───────────────────────────────────────────────── */
.about-page {
  min-height: calc(100vh - 56px);
  padding: var(--space-2xl) var(--space-lg);
}

.about-inner {
  max-width: 680px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* ── Hero ─────────────────────────────────────────────────── */
.about-hero {
  padding-bottom: var(--space-2xl);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--space-2xl);
}

.about-eyebrow {
  display: block;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: var(--space-md);
}

.about-title {
  font-family: var(--font-mono);
  font-size: clamp(40px, 8vw, 72px);
  font-weight: 700;
  line-height: 0.95;
  letter-spacing: -0.03em;
  color: var(--text);
  margin-bottom: var(--space-lg);
}

.about-desc {
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-muted);
  max-width: 480px;
}

/* ── Sections ─────────────────────────────────────────────── */
.about-section {
  padding: var(--space-xl) 0 var(--space-xl) var(--space-lg);
  border-left: 3px solid var(--border);
  margin-bottom: var(--space-xl);
  transition: border-color var(--t-snap);
}

.about-section:hover {
  border-left-color: var(--accent-dim);
}

.about-section--bridge {
  border-left-color: var(--accent-dim);
}

.about-section-head {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-lg);
}

.about-section-label {
  display: block;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: var(--space-lg);
}

.about-section-head .about-section-label {
  margin-bottom: 0;
}

.about-conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.about-conn-dot--ok  { background: var(--green); }
.about-conn-dot--off { background: var(--text-muted); }

/* ── Identity addresses ───────────────────────────────────── */
.about-addr-block {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.about-addr-row {
  display: grid;
  grid-template-columns: 48px 1fr;
  gap: var(--space-md);
  align-items: start;
  padding: var(--space-sm) 0;
}

.about-addr-key {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  padding-top: 2px;
  flex-shrink: 0;
}

.about-addr-val-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.about-addr-val {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 400;
  color: var(--text);
  word-break: break-all;
  line-height: 1.5;
}

.about-addr-val--dim {
  color: var(--text-muted);
  font-style: italic;
}

.about-addr-divider {
  height: 1px;
  background: var(--border);
  margin: var(--space-xs) 0;
}

/* ── Balances ─────────────────────────────────────────────── */
.about-balances {
  display: grid;
  grid-template-columns: 1fr 1px 1fr;
  gap: var(--space-lg);
  align-items: start;
}

.about-balance-sep {
  background: var(--border);
  height: 100%;
  min-height: 40px;
}

.about-balance-cell {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.about-balance-amount {
  font-family: var(--font-mono);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.about-balance-unit {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
}

/* ── Bridge ───────────────────────────────────────────────── */
.about-bridge-hint {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  margin-bottom: var(--space-md);
}

.about-bridge-btn {
  height: 40px;
  padding: 0 var(--space-lg);
  background: transparent;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
  transition: background var(--t-snap), color var(--t-snap);
  letter-spacing: 0.02em;
}

.about-bridge-btn:hover:not(:disabled) {
  background: var(--accent-dim);
  color: var(--accent-hover);
}

.about-bridge-btn:disabled {
  opacity: 0.5;
  cursor: wait;
}

/* ── Network rows ─────────────────────────────────────────── */
.about-net-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.about-net-row {
  display: grid;
  grid-template-columns: 90px 1fr auto;
  gap: var(--space-sm);
  align-items: baseline;
}

.about-net-key {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  flex-shrink: 0;
}

.about-net-val {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  word-break: break-all;
}

/* ── Copy button ──────────────────────────────────────────── */
.copy-btn {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 2px 7px;
  cursor: pointer;
  transition: color var(--t-snap), border-color var(--t-snap);
  white-space: nowrap;
  align-self: flex-start;
}

.copy-btn:hover {
  color: var(--text);
  border-color: var(--border-light);
}

.copy-btn--ok {
  color: var(--green);
  border-color: var(--green);
}

/* ── System bar ───────────────────────────────────────────── */
.about-sysbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-sm) 0;
  border-top: 1px solid var(--border);
  margin-top: var(--space-xs);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.about-sysbar-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.about-sysbar-dot--ok  { background: var(--green); }
.about-sysbar-dot--err { background: var(--red); }
</style>
