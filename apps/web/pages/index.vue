<script setup lang="ts">
definePageMeta({ ssr: false });
const { agents, fetchAgents, startAgent, stopAgent } = useAgents();
const { stats, trades, fetchStats, fetchTrades } = useTrades();

const refreshing = ref(false);

async function refresh() {
  refreshing.value = true;
  await Promise.all([fetchAgents(), fetchStats(), fetchTrades({ limit: 10 })]);
  refreshing.value = false;
}

onMounted(refresh);

// Auto-refresh every 30s
const timer = setInterval(refresh, 30_000);
onUnmounted(() => clearInterval(timer));

const runningCount = computed(() => agents.value.filter((a) => a.status === 'running').length);
const openTrades = computed(() => trades.value.filter((t) => t.status === 'open'));
</script>

<template>
  <main class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Dashboard</h1>
        <p class="page-subtitle">Base chain DEX paper trading — real prices, simulated execution</p>
      </div>
      <button class="btn btn-ghost btn-sm" :disabled="refreshing" @click="refresh">
        <span v-if="refreshing" class="spinner" />
        <span v-else>↻</span>
        Refresh
      </button>
    </div>

    <!-- Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Agents</div>
        <div class="stat-value">{{ agents.length }}</div>
        <div class="stat-change">{{ runningCount }} running</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Trades</div>
        <div class="stat-value">{{ stats?.totalTrades ?? '—' }}</div>
        <div class="stat-change">{{ stats?.openTrades ?? 0 }} open</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value" :class="(stats?.winRate ?? 0) >= 50 ? 'positive' : 'negative'">
          {{ stats ? stats.winRate.toFixed(1) + '%' : '—' }}
        </div>
        <div class="stat-change">across closed trades</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total P&amp;L</div>
        <div
          class="stat-value"
          :class="(stats?.totalPnlUsd ?? 0) >= 0 ? 'positive' : 'negative'"
        >
          {{ stats ? (stats.totalPnlUsd >= 0 ? '+' : '') + '$' + stats.totalPnlUsd.toFixed(0) : '—' }}
        </div>
        <div class="stat-change">paper USDC</div>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
      <!-- Active Agents -->
      <div class="card">
        <div class="card-header">Active Agents</div>
        <div v-if="agents.length === 0" class="empty-state" style="padding: 24px;">
          <div class="empty-title">No agents yet</div>
          <NuxtLink to="/agents" class="btn btn-primary btn-sm" style="margin-top: 12px;">
            Create Agent
          </NuxtLink>
        </div>
        <div v-else style="display: flex; flex-direction: column; gap: 8px;">
          <div
            v-for="agent in agents.slice(0, 5)"
            :key="agent.id"
            style="display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--border);"
          >
            <div>
              <NuxtLink :to="`/agents/${agent.id}`" style="font-weight: 500; color: var(--text);">
                {{ agent.name }}
              </NuxtLink>
              <div style="font-size: 11px; color: var(--text-muted);">
                {{ agent.config.pairs.slice(0, 2).join(', ') }}
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="badge" :class="`badge-${agent.status}`">{{ agent.status }}</span>
              <button
                v-if="agent.status !== 'running'"
                class="btn btn-success btn-sm"
                @click="startAgent(agent.id)"
              >▶</button>
              <button
                v-else
                class="btn btn-ghost btn-sm"
                @click="stopAgent(agent.id)"
              >■</button>
            </div>
          </div>
          <NuxtLink v-if="agents.length > 5" to="/agents" style="font-size: 12px; color: var(--accent);">
            View all {{ agents.length }} agents →
          </NuxtLink>
        </div>
      </div>

      <!-- Recent Trades -->
      <div class="card">
        <div class="card-header">Recent Trades</div>
        <div v-if="trades.length === 0" class="empty-state" style="padding: 24px;">
          <div class="empty-title">No trades yet</div>
          <p style="font-size: 12px;">Start an agent to begin trading</p>
        </div>
        <div v-else>
          <div
            v-for="trade in trades.slice(0, 8)"
            :key="trade.id"
            style="display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border);"
          >
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="badge" :class="`badge-${trade.side}`">{{ trade.side }}</span>
              <span class="mono" style="color: var(--text);">{{ trade.pair }}</span>
            </div>
            <div style="text-align: right;">
              <div
                class="mono"
                style="font-size: 12px;"
                :class="trade.pnlPct !== undefined ? (trade.pnlPct >= 0 ? 'positive' : 'negative') : 'neutral'"
              >
                {{ trade.pnlPct !== undefined ? (trade.pnlPct >= 0 ? '+' : '') + trade.pnlPct.toFixed(2) + '%' : trade.status }}
              </div>
              <div style="font-size: 11px; color: var(--text-muted);">${{ trade.amountUsd.toLocaleString() }}</div>
            </div>
          </div>
          <NuxtLink to="/trades" style="font-size: 12px; color: var(--accent); display: block; margin-top: 8px;">
            View all trades →
          </NuxtLink>
        </div>
      </div>
    </div>
  </main>
</template>
