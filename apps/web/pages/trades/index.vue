<script setup lang="ts">
import { getAgentProfile, DEFAULT_AGENT_PROFILE_ID } from '@something-in-loop/shared';

definePageMeta({ ssr: false });
const { trades, stats, loading, error, fetchTrades, fetchStats } = useTrades();
const { agents, fetchAgents } = useAgents();

const agentEmojiMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const agent of agents.value) {
    const configProfileId = (agent.config as { profileId?: string }).profileId;
    const profileId = agent.profileId ?? configProfileId ?? DEFAULT_AGENT_PROFILE_ID;
    map[agent.id] = getAgentProfile(profileId)?.emoji ?? '🤖';
  }
  return map;
});

const statusFilter = ref('');
const limitFilter = ref(100);

function winRateClass(rate: number): 'positive' | 'negative' | 'neutral' {
  if (rate === 0) return 'neutral';
  return rate >= 50 ? 'positive' : 'negative';
}

async function load() {
  await Promise.all([
    fetchTrades({ status: statusFilter.value || undefined, limit: limitFilter.value }),
    fetchStats(),
    fetchAgents(),
  ]);
}

onMounted(load);
watch([statusFilter, limitFilter], load);
</script>

<template>
  <main class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Trade History</h1>
        <p class="page-subtitle">All paper trades across agents</p>
      </div>
    </div>

    <!-- Stats row -->
    <div v-if="stats" class="stats-grid" style="margin-bottom: 24px;">
      <div class="stat-card">
        <div class="stat-label">Total Trades</div>
        <div class="stat-value">{{ stats.totalTrades }}</div>
        <div class="stat-change">{{ stats.openTrades }} open</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value" :class="winRateClass(stats.winRate)">
          {{ stats.winRate.toFixed(1) }}%
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total P&amp;L</div>
        <div class="stat-value" :class="stats.totalPnlUsd >= 0 ? 'positive' : 'negative'">
          {{ stats.totalPnlUsd >= 0 ? '+' : '' }}${{ stats.totalPnlUsd.toFixed(0) }}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg P&amp;L</div>
        <div class="stat-value" :class="stats.avgPnlPct >= 0 ? 'positive' : 'negative'">
          {{ stats.avgPnlPct >= 0 ? '+' : '' }}{{ stats.avgPnlPct.toFixed(2) }}%
        </div>
        <div class="stat-change">per closed trade</div>
      </div>
    </div>

    <!-- Filters -->
    <div class="card" style="margin-bottom: 16px;">
      <div style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <label class="form-label" style="margin: 0; white-space: nowrap;">Status:</label>
          <select v-model="statusFilter" class="form-select" style="width: 140px;">
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <label class="form-label" style="margin: 0; white-space: nowrap;">Show:</label>
          <select v-model.number="limitFilter" class="form-select" style="width: 100px;">
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="250">250</option>
            <option :value="500">500</option>
          </select>
        </div>
        <span style="font-size: 12px; color: var(--text-muted);">
          Showing {{ trades.length }} trades
        </span>
      </div>
    </div>

    <!-- Table -->
    <div v-if="loading" class="page-loader">
      <div class="page-loader-track">
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
      </div>
      <span class="page-loader-label">Loading trades</span>
    </div>
    <div v-else-if="error" class="alert alert-error">{{ error }}</div>
    <div v-else class="card">
      <TradeTable :trades="trades" :show-agent="true" :agent-emojis="agentEmojiMap" />
    </div>
  </main>
</template>
