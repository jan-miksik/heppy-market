<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  agent: any;
  personaEmoji: string;
  isAnalyzing: boolean;
  analyzeStatusText: string;
  clearingHistory: boolean;
  menuOpen: boolean;
  livePricesLoading: boolean;
  livePricesError: string | null;
}>();

const emit = defineEmits<{
  (e: 'analyze'): void;
  (e: 'start'): void;
  (e: 'stop'): void;
  (e: 'clearHistory'): void;
  (e: 'delete'): void;
  (e: 'update:menuOpen', value: boolean): void;
}>();

const menuRef = ref<HTMLElement | null>(null);
const { updateAgent } = useAgents();

const editingBalance = ref(false);
const balanceInput = ref('');
const savingBalance = ref(false);

function openBalanceEdit() {
  balanceInput.value = String(props.agent.config.paperBalance ?? 0);
  editingBalance.value = true;
}

function cancelBalanceEdit() {
  editingBalance.value = false;
}

async function saveBalance() {
  const val = Number(balanceInput.value);
  if (!Number.isFinite(val) || val < 0) return;
  savingBalance.value = true;
  try {
    await updateAgent(props.agent.id, { paperBalance: val });
    props.agent.config.paperBalance = val;
    editingBalance.value = false;
  } finally {
    savingBalance.value = false;
  }
}

function formatInterval(val: string) {
  if (val === '1h') return '1h';
  if (val === '4h') return '4h';
  if (val === '1d') return '1d';
  return val;
}
</script>

<template>
  <div class="page-header">
    <div>
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
        <button class="btn btn-ghost btn-sm" @click="$router.back()">← Back</button>
        <h1 class="page-title">
          <span v-if="personaEmoji" class="agent-emoji" style="margin-right: 6px;">{{ personaEmoji }}</span>
          {{ agent.name }}
        </h1>
        <span v-if="agent.isPaper" class="paper-badge">PAPER</span>
        <span class="badge" :class="`badge-${agent.status}`">{{ agent.status }}</span>
      </div>
      <p class="page-subtitle">
        {{ agent.llmModel.split('/')[1] ?? agent.llmModel }} · {{ formatInterval(agent.config.analysisInterval) }} interval · temp {{ (agent.config.temperature ?? 0.7).toFixed(1) }}
        <span v-if="livePricesLoading" class="mono" style="opacity: 0.7;"> · fetching live prices…</span>
        <span v-else-if="livePricesError" class="mono" style="opacity: 0.7;"> · live price unavailable</span>
      </p>
    </div>
    <div style="display: flex; gap: 8px; align-items: center;">
      <button
        v-if="agent.isPaper"
        class="btn btn-go-live btn-sm"
        @click="$router.push(`/agents/create?from=${agent.id}`)"
        title="Convert this paper agent to a real agent"
      >
        Go Live →
      </button>
      <template v-if="agent.isPaper">
        <template v-if="editingBalance">
          <input
            v-model="balanceInput"
            type="number"
            min="0"
            step="1"
            class="balance-input"
            :disabled="savingBalance"
            @keydown.enter="saveBalance"
            @keydown.esc="cancelBalanceEdit"
          >
          <button class="btn btn-success btn-sm" :disabled="savingBalance" @click="saveBalance">
            {{ savingBalance ? '…' : '✓' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="savingBalance" @click="cancelBalanceEdit">✕</button>
        </template>
        <button v-else class="btn btn-ghost btn-sm" title="Edit paper balance" @click="openBalanceEdit">
          ✎ Balance
        </button>
      </template>
      <AgentFundPanel
        v-else
        :agent-id="agent.id"
        :current-balance="agent.config.paperBalance"
        @done="(bal) => { agent.config.paperBalance = bal; }"
      />
      <button
        class="btn btn-sm"
        :class="isAnalyzing ? 'btn-analyze-active' : 'btn-ghost'"
        :disabled="isAnalyzing"
        @click="$emit('analyze')"
        title="Run one analysis cycle immediately"
      >
        <span v-if="isAnalyzing" class="analyze-pulse" />
        <span v-if="isAnalyzing" class="analyze-status-text">{{ analyzeStatusText }}</span>
        <template v-else>⚡ Run Analysis</template>
      </button>
      <button v-if="agent.status !== 'running'" class="btn btn-success btn-sm" @click="$emit('start')">
        ▶ Start
      </button>
      
      <div ref="menuRef" style="position: relative;">
        <button class="btn btn-ghost btn-sm" @click.stop="$emit('update:menuOpen', !menuOpen)" title="More actions">•••</button>
        <div v-if="menuOpen" class="agent-dot-menu">
          <NuxtLink :to="`/agents/${agent.id}/edit`" class="agent-dot-menu-item" @click="$emit('update:menuOpen', false)">✎ Edit</NuxtLink>
          <button v-if="agent.status === 'running'" class="agent-dot-menu-item" @click="$emit('stop'); $emit('update:menuOpen', false)">■ Stop</button>
          <button class="agent-dot-menu-item" :disabled="clearingHistory" @click="$emit('clearHistory'); $emit('update:menuOpen', false)">
            {{ clearingHistory ? 'Clearing…' : 'Clear history' }}
          </button>
          <div class="agent-dot-menu-sep" />
          <button class="agent-dot-menu-item agent-dot-menu-item--danger" @click="$emit('delete'); $emit('update:menuOpen', false)">Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.balance-input {
  width: 100px;
  height: 28px;
  background: var(--bg, #0a0a0a);
  border: 1px solid var(--accent, #7c6af7);
  border-radius: 3px;
  color: var(--text, #e0e0e0);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 0 8px;
  outline: none;
}

.paper-badge {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 7px;
  border-radius: var(--radius);
  background: color-mix(in srgb, #d97706 12%, transparent);
  color: #d97706;
  border: 1px solid color-mix(in srgb, #d97706 30%, transparent);
}

.btn-go-live {
  background: color-mix(in srgb, #d97706 12%, transparent);
  border: 1px solid color-mix(in srgb, #d97706 40%, transparent);
  color: #d97706;
  font-family: var(--font-mono);
  font-weight: 700;
  letter-spacing: 0.04em;
  transition: background 0.12s, border-color 0.12s;
}

.btn-go-live:hover {
  background: color-mix(in srgb, #d97706 22%, transparent);
  border-color: #d97706;
}

.agent-dot-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 200;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  min-width: 148px;
  padding: 4px 0;
  display: flex;
  flex-direction: column;
}

.agent-dot-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 7px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  text-decoration: none;
  transition: background var(--t-snap), color var(--t-snap);
}

.agent-dot-menu-item:hover:not(:disabled) {
  background: var(--border);
  color: var(--text);
}

.agent-dot-menu-item:disabled {
  opacity: 0.5;
  cursor: default;
}

.agent-dot-menu-item--danger {
  color: var(--red);
}

.agent-dot-menu-item--danger:hover:not(:disabled) {
  background: var(--red-dim);
  color: var(--red);
}

.agent-dot-menu-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

.btn-analyze-active {
  background: var(--bg-card);
  border: 1px solid var(--accent);
  color: var(--text);
  cursor: wait;
  gap: 6px;
  min-width: 180px;
}

.analyze-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: analyze-blink 1.2s ease-in-out infinite;
  flex-shrink: 0;
}

.analyze-status-text {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  letter-spacing: 0.01em;
}

@keyframes analyze-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
