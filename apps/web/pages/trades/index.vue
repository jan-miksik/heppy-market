<script setup lang="ts">
import { getAgentProfile, DEFAULT_AGENT_PROFILE_ID } from '@something-in-loop/shared';
import type { PaperMode } from '~/components/PaperToggle.vue';

definePageMeta({ ssr: false });

const TRADE_HISTORY_PAPER_STORAGE_KEY = 'heppy:trades:paperMode';

const { trades, loading, error, fetchTrades } = useTrades();
const { stats, error: realStatsError, fetchStats } = useTrades();
const { stats: paperStats, error: paperStatsError, fetchStats: fetchPaperStats } = useTrades();
const { agents, fetchAgents } = useAgents();

const statusFilter = ref('');
const limitFilter = ref(100);
const storedPaperMode = ref<PaperMode | null>(null);
const preferencesReady = ref(false);
const agentsReady = ref(false);

const realAgents = computed(() => agents.value.filter((agent) => !agent.isPaper));
const paperAgents = computed(() => agents.value.filter((agent) => agent.isPaper));
const hasRealAgents = computed(() => realAgents.value.length > 0);
const hasPaperAgents = computed(() => paperAgents.value.length > 0);

const paperMode = computed<PaperMode>(() => {
  if (!hasRealAgents.value && hasPaperAgents.value) return 'paper';
  if (hasRealAgents.value && !hasPaperAgents.value) return 'live';
  return storedPaperMode.value ?? 'live';
});

const showPaperBand = computed(() => paperMode.value === 'all' && hasPaperAgents.value);
const isPaperOnly = computed(() => paperMode.value === 'paper');
const primaryStats = computed(() => (isPaperOnly.value ? paperStats.value : stats.value));
const pageError = computed(() => error.value ?? realStatsError.value ?? paperStatsError.value ?? null);

const tradesSummaryText = computed(() => {
  if (paperMode.value === 'paper') return `Showing ${trades.value.length} paper trades`;
  if (paperMode.value === 'all') return `Showing ${trades.value.length} live + paper trades`;
  return `Showing ${trades.value.length} live trades`;
});

const agentEmojiMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const agent of agents.value) {
    const configProfileId = (agent.config as { profileId?: string }).profileId;
    const profileId = agent.profileId ?? configProfileId ?? DEFAULT_AGENT_PROFILE_ID;
    map[agent.id] = getAgentProfile(profileId)?.emoji ?? '🤖';
  }
  return map;
});

function readStoredPaperMode(): PaperMode | null {
  if (!import.meta.client) return null;
  const raw = localStorage.getItem(TRADE_HISTORY_PAPER_STORAGE_KEY);
  if (raw === 'live' || raw === 'all' || raw === 'paper') return raw;
  // Back-compat with old boolean-shaped keys
  const legacy = localStorage.getItem('heppy:trades:showPaperAgents');
  if (legacy === 'true') return 'all';
  if (legacy === 'false') return 'live';
  return null;
}

function saveStoredPaperMode(value: PaperMode) {
  if (!import.meta.client) return;
  localStorage.setItem(TRADE_HISTORY_PAPER_STORAGE_KEY, value);
}

function setPaperMode(value: PaperMode) {
  storedPaperMode.value = value;
  saveStoredPaperMode(value);
}

function winRateClass(rate: number): 'positive' | 'negative' | 'neutral' {
  if (rate === 0) return 'neutral';
  return rate >= 50 ? 'positive' : 'negative';
}

function formatSignedUsd(value: number): string {
  return `${value >= 0 ? '+' : ''}$${value.toFixed(0)}`;
}

function formatSignedPct(value: number, digits = 2): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

async function loadTradeData(force = false) {
  if (!preferencesReady.value || !agentsReady.value) return;

  const isPaperParam =
    paperMode.value === 'live' ? false
    : paperMode.value === 'paper' ? true
    : undefined;

  const tradeParams = {
    status: statusFilter.value || undefined,
    limit: limitFilter.value,
    isPaper: isPaperParam,
  };

  const requests: Promise<unknown>[] = [
    fetchTrades(tradeParams, { force }),
  ];

  if (paperMode.value === 'paper') {
    requests.push(fetchPaperStats({ isPaper: true, force }));
  } else {
    requests.push(fetchStats({ isPaper: false, force }));
    if (paperMode.value === 'all' && hasPaperAgents.value) {
      requests.push(fetchPaperStats({ isPaper: true, force }));
    }
  }

  await Promise.all(requests);
}

function onTradeClosed(updatedTrade: (typeof trades.value)[number]) {
  const tradeIndex = trades.value.findIndex((trade) => trade.id === updatedTrade.id);
  if (tradeIndex >= 0) {
    trades.value.splice(tradeIndex, 1, updatedTrade);
  }
  void loadTradeData(true);
}

onMounted(async () => {
  storedPaperMode.value = readStoredPaperMode();
  preferencesReady.value = true;
  await fetchAgents();
  agentsReady.value = true;
  await loadTradeData();
});

watch([statusFilter, limitFilter, paperMode], () => {
  if (!preferencesReady.value || !agentsReady.value) return;
  void loadTradeData();
});
</script>

<template>
  <main class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Trade History</h1>
        <p class="page-subtitle">
          Review live and paper trades together, or filter to just one side.
        </p>
      </div>
      <PaperToggle
        v-if="hasRealAgents || hasPaperAgents"
        :model-value="paperMode"
        :has-live="hasRealAgents"
        :has-paper="hasPaperAgents"
        @update:model-value="setPaperMode"
      />
    </div>

    <div v-if="primaryStats" class="stats-grid" style="margin-bottom: 24px;">
      <div
        class="stat-card"
        :class="{
          'stat-card--paper-split': showPaperBand && paperStats,
          'stat-card--paper-only': isPaperOnly,
          'stat-card--paper-lead': (showPaperBand && paperStats) || isPaperOnly,
        }"
      >
        <div class="stat-card__band">
          <div class="stat-label">Total Trades</div>
          <div class="stat-value">{{ primaryStats.totalTrades }}</div>
          <div class="stat-change">{{ primaryStats.openTrades }} open</div>
        </div>
        <Transition name="paper-band">
          <div v-if="showPaperBand && paperStats" class="stat-card__band stat-card__band--paper stat-card__band--paper-lead">
            <div class="stat-card__paper-label">Total Trades</div>
            <div class="stat-card__paper-value">{{ paperStats.totalTrades }}</div>
            <div class="stat-card__paper-meta">{{ paperStats.openTrades }} open</div>
          </div>
        </Transition>
      </div>

      <div
        class="stat-card"
        :class="{
          'stat-card--paper-split': showPaperBand && paperStats,
          'stat-card--paper-only': isPaperOnly,
        }"
      >
        <div class="stat-card__band">
          <div class="stat-label">Win Rate</div>
          <div class="stat-value" :class="winRateClass(primaryStats.winRate)">
            {{ primaryStats.winRate.toFixed(1) }}%
          </div>
          <div class="stat-change">across closed trades</div>
        </div>
        <Transition name="paper-band">
          <div v-if="showPaperBand && paperStats" class="stat-card__band stat-card__band--paper">
            <div class="stat-card__paper-label">Win Rate</div>
            <div class="stat-card__paper-value">{{ paperStats.winRate.toFixed(1) }}%</div>
            <div class="stat-card__paper-meta">across closed trades</div>
          </div>
        </Transition>
      </div>

      <div
        class="stat-card"
        :class="{
          'stat-card--paper-split': showPaperBand && paperStats,
          'stat-card--paper-only': isPaperOnly,
        }"
      >
        <div class="stat-card__band">
          <div class="stat-label">Total P&amp;L</div>
          <div class="stat-value" :class="primaryStats.totalPnlUsd >= 0 ? 'positive' : 'negative'">
            {{ formatSignedUsd(primaryStats.totalPnlUsd) }}
          </div>
          <div class="stat-change">closed trades</div>
        </div>
        <Transition name="paper-band">
          <div v-if="showPaperBand && paperStats" class="stat-card__band stat-card__band--paper">
            <div class="stat-card__paper-label">Total P&amp;L</div>
            <div
              class="stat-card__paper-value"
              :class="paperStats.totalPnlUsd >= 0 ? 'positive' : 'negative'"
            >
              {{ formatSignedUsd(paperStats.totalPnlUsd) }}
            </div>
            <div class="stat-card__paper-meta">closed trades</div>
          </div>
        </Transition>
      </div>

      <div
        class="stat-card"
        :class="{
          'stat-card--paper-split': showPaperBand && paperStats,
          'stat-card--paper-only': isPaperOnly,
        }"
      >
        <div class="stat-card__band">
          <div class="stat-label">Avg P&amp;L</div>
          <div class="stat-value" :class="primaryStats.avgPnlPct >= 0 ? 'positive' : 'negative'">
            {{ formatSignedPct(primaryStats.avgPnlPct) }}
          </div>
          <div class="stat-change">per closed trade</div>
        </div>
        <Transition name="paper-band">
          <div v-if="showPaperBand && paperStats" class="stat-card__band stat-card__band--paper">
            <div class="stat-card__paper-label">Avg P&amp;L</div>
            <div
              class="stat-card__paper-value"
              :class="paperStats.avgPnlPct >= 0 ? 'positive' : 'negative'"
            >
              {{ formatSignedPct(paperStats.avgPnlPct) }}
            </div>
            <div class="stat-card__paper-meta">per closed trade</div>
          </div>
        </Transition>
      </div>
    </div>

    <div class="card" style="margin-bottom: 16px;">
      <div class="trades-filters">
        <div class="trades-filters__group">
          <label class="form-label" style="margin: 0; white-space: nowrap;">Status:</label>
          <select v-model="statusFilter" class="form-select" style="width: 140px;">
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <div class="trades-filters__group">
          <label class="form-label" style="margin: 0; white-space: nowrap;">Show:</label>
          <select v-model.number="limitFilter" class="form-select" style="width: 100px;">
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="250">250</option>
            <option :value="500">500</option>
          </select>
        </div>
        <span class="trades-filters__summary">{{ tradesSummaryText }}</span>
      </div>
    </div>

    <div v-if="loading" class="page-loader">
      <div class="page-loader-track">
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
      </div>
      <span class="page-loader-label">Loading trades</span>
    </div>
    <div v-else-if="pageError" class="alert alert-error">{{ pageError }}</div>
    <div v-else class="card">
      <TradeTable
        :trades="trades"
        :show-agent="true"
        :agent-emojis="agentEmojiMap"
        @trade-closed="onTradeClosed"
      />
    </div>
  </main>
</template>

<style scoped>
.page-header {
  gap: 16px;
}

.trades-filters {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.trades-filters__group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.trades-filters__summary {
  font-size: 12px;
  color: var(--text-muted);
}

</style>
