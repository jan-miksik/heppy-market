<script setup lang="ts">
definePageMeta({ ssr: false });
const { trades, stats, loading, error, fetchTrades, fetchStats } = useTrades();

const statusFilter = ref('');
const limitFilter = ref(100);

async function load() {
  await Promise.all([
    fetchTrades({ status: statusFilter.value || undefined, limit: limitFilter.value }),
    fetchStats(),
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
        <div class="stat-value" :class="stats.winRate >= 50 ? 'positive' : 'negative'">
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
            <option value="stopped_out">Stopped Out</option>
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
    <div v-if="loading" style="text-align: center; padding: 48px;">
      <span class="spinner" />
    </div>
    <div v-else-if="error" class="alert alert-error">{{ error }}</div>
    <div v-else class="card">
      <TradeTable :trades="trades" :show-agent="true" />
    </div>
  </main>
</template>
