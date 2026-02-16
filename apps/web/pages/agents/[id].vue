<script setup lang="ts">
definePageMeta({ ssr: false });
import type { Trade } from '~/composables/useTrades';

const route = useRoute();
const id = computed(() => route.params.id as string);
const { getAgent, startAgent, stopAgent, pauseAgent, deleteAgent } = useAgents();
const { fetchAgentTrades, formatPnl, pnlClass } = useTrades();
const { request } = useApi();
const router = useRouter();

interface MarketDataEntry {
  pair: string;
  pairAddress?: string;
  dexScreenerUrl?: string;
  priceUsd: number;
  priceChange?: Record<string, number | undefined>;
  volume24h?: number;
  liquidity?: number;
  indicators?: Record<string, unknown>;
}

interface AgentDecision {
  id: string;
  decision: string;
  confidence: number;
  reasoning: string;
  llmModel: string;
  llmLatencyMs: number;
  marketDataSnapshot?: string;
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

interface DoStatus {
  agentId: string | null;
  status: string;
  balance: number | null;
  nextAlarmAt: number | null;
}

const agent = ref<Awaited<ReturnType<typeof getAgent>> | null>(null);
const trades = ref<Trade[]>([]);
const decisions = ref<AgentDecision[]>([]);
const snapshots = ref<PerformanceSnapshot[]>([]);
const doStatus = ref<DoStatus | null>(null);
const loading = ref(true);
const isAnalyzing = ref(false);
const activeTab = ref<'trades' | 'decisions' | 'performance'>('trades');
const expandedDecisions = ref<Set<string>>(new Set());
const expandedTrades = ref<Set<string>>(new Set());

// Countdown timer
const now = ref(Date.now());
let countdownInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  countdownInterval = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (countdownInterval) clearInterval(countdownInterval);
});

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
    // Load DO status for countdown
    await refreshDoStatus();
  } finally {
    loading.value = false;
  }
}

async function refreshDoStatus() {
  try {
    doStatus.value = await request<DoStatus>(`/api/agents/${id.value}/status`);
  } catch {
    // non-critical
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

/** Seconds until next agent analysis cycle */
const secondsUntilNextAction = computed(() => {
  if (!doStatus.value?.nextAlarmAt) return null;
  const diff = Math.floor((doStatus.value.nextAlarmAt - now.value) / 1000);
  return diff > 0 ? diff : 0;
});

function formatCountdown(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds === 0) return 'running…';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

/** Parse marketDataSnapshot string → MarketDataEntry[] */
function parseSnapshot(snapshot?: string): MarketDataEntry[] {
  if (!snapshot) return [];
  try {
    return JSON.parse(snapshot) as MarketDataEntry[];
  } catch {
    return [];
  }
}

/** Find pair address for an open trade from latest decisions */
function getPairAddress(pairName: string): string {
  for (const dec of decisions.value) {
    const snap = parseSnapshot(dec.marketDataSnapshot);
    const entry = snap.find((e) => e.pair === pairName);
    if (entry?.pairAddress) return entry.pairAddress;
  }
  return '';
}

/** Estimate unrealized P&L for an open position using latest known price */
function getUnrealizedPnl(trade: Trade): { pnlPct: number; currentPrice: number } | null {
  for (const dec of decisions.value) {
    const snap = parseSnapshot(dec.marketDataSnapshot);
    const entry = snap.find((e) => e.pair === trade.pair);
    if (entry && entry.priceUsd > 0) {
      const slippage = agent.value?.config.slippageSimulation ?? 0.3;
      const effectiveEntry = trade.side === 'buy'
        ? trade.entryPrice * (1 + slippage / 100)
        : trade.entryPrice * (1 - slippage / 100);
      const pnlPct = trade.side === 'buy'
        ? ((entry.priceUsd - effectiveEntry) / effectiveEntry) * 100
        : ((effectiveEntry - entry.priceUsd) / effectiveEntry) * 100;
      return { pnlPct, currentPrice: entry.priceUsd };
    }
  }
  return null;
}

async function handleStart() {
  if (!agent.value) return;
  await startAgent(id.value);
  agent.value.status = 'running';
  await refreshDoStatus();
}
async function handleStop() {
  if (!agent.value) return;
  await stopAgent(id.value);
  agent.value.status = 'stopped';
  doStatus.value = null;
}
async function handleAnalyze() {
  isAnalyzing.value = true;
  try {
    await request(`/api/agents/${id.value}/analyze`, { method: 'POST' });
    // Refresh data after a short delay for the loop to write to D1
    await new Promise((r) => setTimeout(r, 2000));
    const [t, d] = await Promise.all([
      fetchAgentTrades(id.value),
      request<{ decisions: AgentDecision[] }>(`/api/agents/${id.value}/decisions`),
    ]);
    trades.value = t;
    decisions.value = d.decisions;
    await refreshDoStatus();
  } finally {
    isAnalyzing.value = false;
  }
}
async function handleDelete() {
  if (!confirm('Delete this agent?')) return;
  await deleteAgent(id.value);
  router.push('/agents');
}

function toggleDecision(decId: string) {
  if (expandedDecisions.value.has(decId)) {
    expandedDecisions.value.delete(decId);
  } else {
    expandedDecisions.value.add(decId);
  }
}

function toggleTrade(tradeId: string) {
  if (expandedTrades.value.has(tradeId)) {
    expandedTrades.value.delete(tradeId);
  } else {
    expandedTrades.value.add(tradeId);
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
function formatPrice(p: number) {
  return p >= 1 ? p.toLocaleString('en', { maximumFractionDigits: 4 }) : p.toPrecision(5);
}
function decisionColor(d: string) {
  if (d === 'buy') return 'positive';
  if (d === 'sell') return 'negative';
  return 'neutral';
}
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
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
        <div style="display: flex; gap: 8px; align-items: center;">
          <button
            class="btn btn-ghost btn-sm"
            :disabled="isAnalyzing"
            @click="handleAnalyze"
            title="Run one analysis cycle immediately"
          >
            <span v-if="isAnalyzing" class="spinner" style="width: 14px; height: 14px; margin-right: 4px;" />
            {{ isAnalyzing ? 'Analyzing…' : '⚡ Run Analysis' }}
          </button>
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
          <div class="stat-label">Next Analysis</div>
          <div class="stat-value mono" :class="agent.status === 'running' ? 'positive' : 'neutral'">
            {{ agent.status === 'running' ? formatCountdown(secondsUntilNextAction) : '—' }}
          </div>
          <div class="stat-change">{{ openTrades.length }} of {{ agent.config.maxOpenPositions }} positions open</div>
        </div>
      </div>

      <!-- Open Positions section -->
      <div v-if="openTrades.length > 0" style="margin-bottom: 24px;">
        <h2 style="font-size: 15px; font-weight: 600; margin-bottom: 12px; color: var(--text-primary);">
          Open Positions
        </h2>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px;">
          <div
            v-for="trade in openTrades"
            :key="trade.id"
            class="card"
            style="padding: 0; overflow: hidden;"
          >
            <!-- Card header -->
            <div style="padding: 14px 16px 10px; display: flex; justify-content: space-between; align-items: flex-start;">
              <div>
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                  <span class="mono" style="font-size: 15px; font-weight: 600;">{{ trade.pair }}</span>
                  <span class="badge" :class="`badge-${trade.side}`">{{ trade.side === 'buy' ? 'LONG' : 'SHORT' }}</span>
                </div>
                <div style="font-size: 12px; color: var(--text-muted);">
                  Entry: <span class="mono">${{ formatPrice(trade.entryPrice) }}</span>
                  · Size: <span class="mono">${{ trade.amountUsd.toLocaleString() }}</span>
                  · {{ timeAgo(trade.openedAt) }}
                </div>
              </div>
              <!-- Unrealized P&L -->
              <div style="text-align: right;">
                <template v-if="getUnrealizedPnl(trade) as pnl">
                  <div
                    class="mono"
                    style="font-size: 16px; font-weight: 600;"
                    :class="(pnl as any).pnlPct >= 0 ? 'positive' : 'negative'"
                  >
                    {{ (pnl as any).pnlPct >= 0 ? '+' : '' }}{{ (pnl as any).pnlPct.toFixed(2) }}%
                  </div>
                  <div style="font-size: 11px; color: var(--text-muted);">
                    now ${{ formatPrice((pnl as any).currentPrice) }}
                  </div>
                </template>
                <div v-else style="font-size: 12px; color: var(--text-muted);">P&L: —</div>
              </div>
            </div>

            <!-- Countdown bar -->
            <div style="padding: 6px 16px 10px; display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 11px; color: var(--text-muted);">Next action in:</span>
              <span
                class="mono"
                style="font-size: 12px; font-weight: 600;"
                :class="agent.status === 'running' ? 'positive' : 'neutral'"
              >
                {{ agent.status === 'running' ? formatCountdown(secondsUntilNextAction) : 'agent stopped' }}
              </span>
              <span style="font-size: 11px; color: var(--text-muted);">· {{ trade.strategyUsed }}</span>
              <span style="margin-left: auto;">
                <span class="mono" style="font-size: 11px; color: var(--text-muted);">conf: {{ (trade.confidenceBefore * 100).toFixed(0) }}%</span>
              </span>
            </div>

            <!-- DexScreener chart -->
            <div style="padding: 0 0 0 0;">
              <DexChart chain="base" :pair-address="getPairAddress(trade.pair)" :height="300" />
            </div>

            <!-- Reasoning (collapsed) -->
            <div
              style="padding: 10px 16px; border-top: 1px solid var(--border-color, #2a2a3e); cursor: pointer; font-size: 12px; color: var(--text-muted);"
              @click="toggleTrade(trade.id)"
            >
              <span style="margin-right: 6px;">{{ expandedTrades.has(trade.id) ? '▼' : '▶' }}</span>
              <span v-if="!expandedTrades.has(trade.id)" style="overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical;">
                {{ trade.reasoning }}
              </span>
              <span v-else style="white-space: pre-wrap; display: block; margin-top: 4px; line-height: 1.5;">{{ trade.reasoning }}</span>
            </div>
          </div>
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
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Pair</th>
                <th>Side</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>Amount</th>
                <th>Conf</th>
                <th>P&amp;L</th>
                <th>Strategy</th>
                <th>Status</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="trades.length === 0">
                <td colspan="11" style="text-align: center; padding: 32px; color: var(--text-muted);">
                  No trades yet
                </td>
              </tr>
              <template v-for="trade in trades" :key="trade.id">
                <tr style="cursor: pointer;" @click="toggleTrade(trade.id)">
                  <td style="color: var(--text-muted); font-size: 11px; width: 16px;">
                    {{ expandedTrades.has(trade.id) ? '▼' : '▶' }}
                  </td>
                  <td class="mono">{{ trade.pair }}</td>
                  <td>
                    <span class="badge" :class="`badge-${trade.side}`">{{ trade.side }}</span>
                  </td>
                  <td class="mono">${{ formatPrice(trade.entryPrice) }}</td>
                  <td class="mono">{{ trade.exitPrice ? '$' + formatPrice(trade.exitPrice) : '—' }}</td>
                  <td class="mono">${{ trade.amountUsd.toLocaleString() }}</td>
                  <td class="mono" :class="trade.confidenceBefore >= 0.7 ? 'positive' : 'neutral'" style="font-size: 12px;">
                    {{ (trade.confidenceBefore * 100).toFixed(0) }}%
                  </td>
                  <td class="mono" :class="pnlClass(trade.pnlPct)">{{ formatPnl(trade.pnlPct) }}</td>
                  <td style="color: var(--text-muted); font-size: 12px;">{{ trade.strategyUsed }}</td>
                  <td>
                    <span class="badge" :class="trade.status === 'open' ? 'badge-running' : trade.status === 'stopped_out' ? 'badge-paused' : 'badge-stopped'">
                      {{ trade.status }}
                    </span>
                  </td>
                  <td style="color: var(--text-muted); font-size: 12px;">{{ formatDate(trade.openedAt) }}</td>
                </tr>
                <tr v-if="expandedTrades.has(trade.id)">
                  <td colspan="11" style="background: var(--bg-secondary, #1a1a2e); padding: 12px 16px;">
                    <div style="font-size: 12px; color: var(--text-muted); line-height: 1.6; white-space: pre-wrap;">
                      <strong style="color: var(--text-primary);">Reasoning:</strong> {{ trade.reasoning }}
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Decisions tab -->
      <div v-if="activeTab === 'decisions'" class="card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
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
                <td colspan="7" style="text-align: center; padding: 32px; color: var(--text-muted);">
                  No decisions yet — start the agent or click ⚡ Run Analysis
                </td>
              </tr>
              <template v-for="dec in decisions" :key="dec.id">
                <tr style="cursor: pointer;" @click="toggleDecision(dec.id)">
                  <td style="color: var(--text-muted); font-size: 11px; width: 16px;">
                    {{ expandedDecisions.has(dec.id) ? '▼' : '▶' }}
                  </td>
                  <td style="font-size: 12px; color: var(--text-muted);">{{ formatDate(dec.createdAt) }}</td>
                  <td>
                    <span class="badge" :class="dec.decision === 'buy' ? 'badge-buy' : dec.decision === 'sell' ? 'badge-sell' : 'badge-stopped'">
                      {{ dec.decision }}
                    </span>
                  </td>
                  <td class="mono" :class="dec.confidence >= 0.7 ? 'positive' : 'neutral'">
                    {{ (dec.confidence * 100).toFixed(0) }}%
                  </td>
                  <td style="font-size: 11px; color: var(--text-muted);">{{ dec.llmModel.split('/').pop() }}</td>
                  <td class="mono" style="color: var(--text-muted);">{{ dec.llmLatencyMs }}ms</td>
                  <td style="font-size: 12px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted);">
                    {{ dec.reasoning }}
                  </td>
                </tr>
                <!-- Expanded row -->
                <tr v-if="expandedDecisions.has(dec.id)">
                  <td colspan="7" style="background: var(--bg-secondary, #1a1a2e); padding: 16px;">
                    <!-- Full reasoning -->
                    <div style="margin-bottom: 14px;">
                      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 6px;">Reasoning</div>
                      <div style="font-size: 13px; line-height: 1.7; white-space: pre-wrap; color: var(--text-primary);">{{ dec.reasoning }}</div>
                    </div>
                    <!-- Market data snapshot -->
                    <template v-if="parseSnapshot(dec.marketDataSnapshot).length > 0">
                      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 8px;">Market Snapshot</div>
                      <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                        <div
                          v-for="entry in parseSnapshot(dec.marketDataSnapshot)"
                          :key="entry.pair"
                          style="background: var(--bg-primary, #0f0f1a); border: 1px solid var(--border-color, #2a2a3e); border-radius: 6px; padding: 10px 14px; min-width: 180px;"
                        >
                          <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">{{ entry.pair }}</div>
                          <div class="mono" style="font-size: 13px; margin-bottom: 4px;">${{ formatPrice(entry.priceUsd) }}</div>
                          <div v-if="entry.priceChange" style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px;">
                            <span v-if="entry.priceChange.h1 !== undefined">1h: <span :class="(entry.priceChange.h1 ?? 0) >= 0 ? 'positive' : 'negative'">{{ (entry.priceChange.h1 ?? 0).toFixed(2) }}%</span></span>
                            <span v-if="entry.priceChange.h24 !== undefined" style="margin-left: 8px;">24h: <span :class="(entry.priceChange.h24 ?? 0) >= 0 ? 'positive' : 'negative'">{{ (entry.priceChange.h24 ?? 0).toFixed(2) }}%</span></span>
                          </div>
                          <div v-if="entry.indicators" style="font-size: 11px; color: var(--text-muted);">
                            <div v-if="entry.indicators.rsi">RSI: <span class="mono">{{ entry.indicators.rsi }}</span></div>
                            <div v-if="entry.indicators.emaTrend">EMA: <span :class="entry.indicators.emaTrend === 'bullish' ? 'positive' : 'negative'">{{ entry.indicators.emaTrend }}</span></div>
                            <div v-if="entry.indicators.macdHistogram">MACD hist: <span class="mono">{{ entry.indicators.macdHistogram }}</span></div>
                            <div v-if="entry.indicators.bollingerPB">BB %B: <span class="mono">{{ entry.indicators.bollingerPB }}</span></div>
                          </div>
                          <div v-if="entry.dexScreenerUrl" style="margin-top: 8px;">
                            <a :href="entry.dexScreenerUrl" target="_blank" rel="noopener" style="font-size: 11px; color: var(--accent, #6366f1); text-decoration: none;">View on DexScreener ↗</a>
                          </div>
                        </div>
                      </div>
                    </template>
                  </td>
                </tr>
              </template>
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
