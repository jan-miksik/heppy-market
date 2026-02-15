<script setup lang="ts">
definePageMeta({ ssr: false });
import type { Trade } from '~/composables/useTrades';

const route = useRoute();
const id = computed(() => route.params.id as string);
const { getAgent, startAgent, stopAgent, pauseAgent, deleteAgent } = useAgents();
const { fetchAgentTrades, formatPnl, pnlClass } = useTrades();
const { request } = useApi();
const router = useRouter();

interface AgentDecision {
  id: string;
  decision: string;
  confidence: number;
  reasoning: string;
  llmModel: string;
  llmLatencyMs: number;
  createdAt: string;
}

interface PerformanceSnapshot {
  id: string;
  balance: number;
  totalPnlPct: number;
  winRate: number;
  totalTrades: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
  snapshotAt: string;
}

const agent = ref<Awaited<ReturnType<typeof getAgent>> | null>(null);
const trades = ref<Trade[]>([]);
const decisions = ref<AgentDecision[]>([]);
const snapshots = ref<PerformanceSnapshot[]>([]);
const loading = ref(true);
const activeTab = ref<'trades' | 'decisions' | 'performance'>('trades');

async function loadAll() {
  loading.value = true;
  try {
    const [a, t, d, p] = await Promise.all([
      getAgent(id.value),
      fetchAgentTrades(id.value),
      request<{ decisions: AgentDecision[] }>(`/api/agents/${id.value}/decisions`),
      request<{ snapshots: PerformanceSnapshot[] }>(`/api/agents/${id.value}/performance`),
    ]);
    agent.value = a;
    trades.value = t;
    decisions.value = d.decisions;
    snapshots.value = p.snapshots;
  } finally {
    loading.value = false;
  }
}

onMounted(loadAll);

const openTrades = computed(() => trades.value.filter((t) => t.status === 'open'));
const closedTrades = computed(() => trades.value.filter((t) => t.status !== 'open'));
const winRate = computed(() => {
  if (closedTrades.value.length === 0) return 0;
  const wins = closedTrades.value.filter((t) => (t.pnlPct ?? 0) > 0).length;
  return (wins / closedTrades.value.length) * 100;
});
const totalPnlUsd = computed(() =>
  closedTrades.value.reduce((acc, t) => acc + (t.pnlUsd ?? 0), 0)
);
const latestSnapshot = computed(() => snapshots.value[0] ?? null);

async function handleStart() {
  if (!agent.value) return;
  await startAgent(id.value);
  agent.value.status = 'running';
}
async function handleStop() {
  if (!agent.value) return;
  await stopAgent(id.value);
  agent.value.status = 'stopped';
}
async function handleDelete() {
  if (!confirm('Delete this agent?')) return;
  await deleteAgent(id.value);
  router.push('/agents');
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
function decisionColor(d: string) {
  if (d === 'buy') return 'positive';
  if (d === 'sell') return 'negative';
  return 'neutral';
}
</script>

<template>
  <main class="page">
    <div v-if="loading" style="text-align: center; padding: 64px;">
      <span class="spinner" style="width: 32px; height: 32px;" />
    </div>

    <template v-else-if="agent">
      <!-- Header -->
      <div class="page-header">
        <div>
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
            <button class="btn btn-ghost btn-sm" @click="$router.back()">← Back</button>
            <h1 class="page-title">{{ agent.name }}</h1>
            <span class="badge" :class="`badge-${agent.status}`">{{ agent.status }}</span>
          </div>
          <p class="page-subtitle">
            {{ agent.autonomyLevel }} · {{ agent.llmModel.split('/')[1] ?? agent.llmModel }} · {{ agent.config.analysisInterval }} interval
          </p>
        </div>
        <div style="display: flex; gap: 8px;">
          <button v-if="agent.status !== 'running'" class="btn btn-success" @click="handleStart">
            ▶ Start
          </button>
          <button v-else class="btn btn-ghost" @click="handleStop">■ Stop</button>
          <button class="btn btn-danger btn-sm" @click="handleDelete">Delete</button>
        </div>
      </div>

      <!-- Stats row -->
      <div class="stats-grid" style="margin-bottom: 24px;">
        <div class="stat-card">
          <div class="stat-label">Balance</div>
          <div class="stat-value">${{ (latestSnapshot?.balance ?? agent.config.paperBalance).toLocaleString('en', { maximumFractionDigits: 0 }) }}</div>
          <div class="stat-change">started at ${{ agent.config.paperBalance.toLocaleString() }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total P&amp;L</div>
          <div class="stat-value" :class="totalPnlUsd >= 0 ? 'positive' : 'negative'">
            {{ totalPnlUsd >= 0 ? '+' : '' }}${{ totalPnlUsd.toFixed(0) }}
          </div>
          <div class="stat-change">
            {{ latestSnapshot ? (latestSnapshot.totalPnlPct >= 0 ? '+' : '') + latestSnapshot.totalPnlPct.toFixed(2) + '%' : '—' }}
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Win Rate</div>
          <div class="stat-value" :class="winRate >= 50 ? 'positive' : 'negative'">
            {{ winRate.toFixed(1) }}%
          </div>
          <div class="stat-change">{{ closedTrades.length }} closed trades</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Open Positions</div>
          <div class="stat-value">{{ openTrades.length }}</div>
          <div class="stat-change">of {{ agent.config.maxOpenPositions }} max</div>
        </div>
      </div>

      <!-- PnL Chart (if snapshots available) -->
      <div v-if="snapshots.length > 1" class="card" style="margin-bottom: 24px;">
        <div class="card-header">P&amp;L History</div>
        <PnLChart :snapshots="snapshots" :initialBalance="agent.config.paperBalance" />
      </div>

      <!-- Tabs -->
      <div class="tabs">
        <div class="tab" :class="{ active: activeTab === 'trades' }" @click="activeTab = 'trades'">
          Trades ({{ trades.length }})
        </div>
        <div class="tab" :class="{ active: activeTab === 'decisions' }" @click="activeTab = 'decisions'">
          Decisions ({{ decisions.length }})
        </div>
        <div class="tab" :class="{ active: activeTab === 'performance' }" @click="activeTab = 'performance'">
          Performance
        </div>
      </div>

      <!-- Trades tab -->
      <div v-if="activeTab === 'trades'" class="card">
        <TradeTable :trades="trades" />
      </div>

      <!-- Decisions tab -->
      <div v-if="activeTab === 'decisions'" class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Decision</th>
                <th>Confidence</th>
                <th>Model</th>
                <th>Latency</th>
                <th>Reasoning</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="decisions.length === 0">
                <td colspan="6" style="text-align: center; padding: 32px; color: var(--text-muted);">
                  No decisions yet — start the agent
                </td>
              </tr>
              <tr v-for="dec in decisions" :key="dec.id">
                <td style="font-size: 12px; color: var(--text-muted);">{{ formatDate(dec.createdAt) }}</td>
                <td>
                  <span class="badge" :class="dec.decision === 'buy' ? 'badge-buy' : dec.decision === 'sell' ? 'badge-sell' : 'badge-stopped'">
                    {{ dec.decision }}
                  </span>
                </td>
                <td class="mono" :class="dec.confidence >= 0.7 ? 'positive' : 'neutral'">
                  {{ (dec.confidence * 100).toFixed(0) }}%
                </td>
                <td style="font-size: 11px; color: var(--text-muted);">
                  {{ dec.llmModel.split('/').pop() }}
                </td>
                <td class="mono" style="color: var(--text-muted);">{{ dec.llmLatencyMs }}ms</td>
                <td style="font-size: 12px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  {{ dec.reasoning }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Performance tab -->
      <div v-if="activeTab === 'performance'" class="card">
        <div v-if="!latestSnapshot" class="empty-state" style="padding: 24px;">
          <div class="empty-title">No performance data yet</div>
          <p>Snapshots are saved every 6 analysis cycles.</p>
        </div>
        <div v-else>
          <div class="stats-grid" style="margin-bottom: 0;">
            <div class="stat-card">
              <div class="stat-label">Total Trades</div>
              <div class="stat-value">{{ latestSnapshot.totalTrades }}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Win Rate</div>
              <div class="stat-value" :class="latestSnapshot.winRate >= 0.5 ? 'positive' : 'negative'">
                {{ (latestSnapshot.winRate * 100).toFixed(1) }}%
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Sharpe Ratio</div>
              <div class="stat-value" :class="(latestSnapshot.sharpeRatio ?? 0) >= 0 ? 'positive' : 'negative'">
                {{ latestSnapshot.sharpeRatio?.toFixed(2) ?? '—' }}
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Max Drawdown</div>
              <div class="stat-value negative">
                {{ latestSnapshot.maxDrawdown ? '-' + latestSnapshot.maxDrawdown.toFixed(2) + '%' : '—' }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </main>
</template>
