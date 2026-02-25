<template>
  <main class="page">
    <div v-if="pending && !manager" style="text-align: center; padding: 48px;">
      <span class="spinner" />
    </div>

    <template v-else-if="manager">
      <!-- Header -->
      <div class="page-header">
        <div>
          <NuxtLink to="/managers" class="back-link">← Managers</NuxtLink>
          <div style="display: flex; align-items: center; gap: 10px; margin-top: 4px;">
            <h1 class="page-title">{{ manager.name }}</h1>
            <span class="badge" :class="statusBadgeClass">{{ manager.status }}</span>
          </div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button v-if="manager.status !== 'running'" class="btn btn-success" :disabled="actionLoading" @click="doAction('start')">Start</button>
          <button v-if="manager.status === 'running'" class="btn btn-ghost" :disabled="actionLoading || !!doStatus?.deciding" @click="triggerDecision">Push decision</button>
          <button v-if="manager.status === 'running'" class="btn btn-ghost" :disabled="actionLoading" @click="doAction('pause')">Pause</button>
          <button v-if="manager.status !== 'stopped'" class="btn btn-ghost" :disabled="actionLoading" @click="doAction('stop')">Stop</button>
          <NuxtLink :to="`/managers/${manager.id}/edit`" class="btn btn-ghost">Edit</NuxtLink>
        </div>
      </div>

      <!-- Deciding banner -->
      <div v-if="doStatus?.deciding" class="deciding-banner">
        <span class="deciding-dot" />
        <span class="deciding-text">Analyzing portfolio &amp; making decisions…</span>
        <span v-if="doStatus.lastDecisionMs" class="deciding-hint">last cycle took {{ (doStatus.lastDecisionMs / 1000).toFixed(1) }}s</span>
      </div>

      <!-- Next decision countdown (only when running and not deciding) -->
      <div v-else-if="manager.status === 'running' && nextDecisionLabel" class="next-decision-bar">
        <div class="next-decision-progress" :style="{ width: progressPct + '%' }" />
        <span class="next-decision-label">Next decision {{ nextDecisionLabel }}</span>
      </div>

      <!-- Stats -->
      <div class="stats-grid" style="grid-template-columns: repeat(5, 1fr); margin-bottom: 24px;">
        <div class="stat-card">
          <div class="stat-label">Model</div>
          <div class="stat-value" style="font-size: 13px; font-family: inherit;">{{ shortModel }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Interval</div>
          <div class="stat-value" style="font-size: 16px;">{{ manager.config?.decisionInterval ?? '—' }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Cycles</div>
          <div class="stat-value" style="font-size: 20px;">{{ doStatus?.tickCount ?? 0 }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Max Drawdown</div>
          <div class="stat-value" style="font-size: 16px;">{{ maxDrawdownLabel }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Max Agents</div>
          <div class="stat-value" style="font-size: 16px;">{{ manager.config?.riskParams?.maxAgents ?? '—' }}</div>
        </div>
      </div>

      <!-- Tabs -->
      <div class="tabs">
        <div class="tab" :class="{ active: activeTab === 'agents' }" @click="activeTab = 'agents'">
          Agents <span v-if="managedAgents.length" style="color: var(--text-muted); margin-left: 4px;">{{ managedAgents.length }}</span>
        </div>
        <div class="tab" :class="{ active: activeTab === 'logs' }" @click="activeTab = 'logs'">
          Decision Log <span v-if="logs.length" style="color: var(--text-muted); margin-left: 4px;">{{ logs.length }}</span>
        </div>
      </div>

      <!-- Agents tab -->
      <div v-if="activeTab === 'agents'">
        <div v-if="managedAgents.length === 0" class="empty-state" style="padding: 32px 24px;">
          <div class="empty-title">No agents yet</div>
          <p>The manager will create agents based on its strategy when started.</p>
        </div>
        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Pairs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in managedAgents" :key="a.id">
                <td style="color: var(--text);">{{ a.name }}</td>
                <td><span class="badge" :class="agentBadgeClass(a.status)">{{ a.status }}</span></td>
                <td class="mono">{{ a.config?.pairs?.join(', ') ?? '—' }}</td>
                <td><NuxtLink :to="`/agents/${a.id}`" class="btn btn-ghost btn-sm">View →</NuxtLink></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Logs tab -->
      <div v-if="activeTab === 'logs'">
        <div v-if="logs.length === 0" class="empty-state" style="padding: 32px 24px;">
          <div class="empty-title">No decisions logged yet</div>
          <p>Start the manager to begin generating decisions.</p>
        </div>
        <div v-else style="display: flex; flex-direction: column; gap: 8px;">
          <div v-for="log in logs" :key="log.id" class="card" style="padding: 14px 16px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
              <span class="badge" :class="actionBadgeClass(log.action)" style="font-size: 11px;">{{ log.action }}</span>
              <span style="font-size: 12px; color: var(--text-muted);">{{ new Date(log.createdAt).toLocaleString() }}</span>
            </div>
            <p style="font-size: 13px; color: var(--text-dim);">{{ log.reasoning }}</p>
            <p v-if="log.result?.detail" style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">{{ log.result.detail }}</p>
            <p v-if="log.result?.error" style="font-size: 12px; color: var(--red); margin-top: 4px;">{{ log.result.error }}</p>
          </div>
          <button v-if="hasMoreLogs" class="btn btn-ghost" style="align-self: center; margin-top: 8px;" @click="loadMoreLogs">Load more…</button>
        </div>
      </div>
    </template>

    <div v-else class="alert alert-error">Manager not found.</div>
  </main>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const id = route.params.id as string;

const activeTab = ref<'agents' | 'logs'>('agents');
const actionLoading = ref(false);

const { data: managerData, pending, refresh } = await useFetch<any>(`/api/managers/${id}`, {
  credentials: 'include',
});
const manager = computed(() => managerData.value ?? null);
const doStatus = computed(() => manager.value?.doStatus ?? null);

const { data: agentsData, refresh: refreshAgents } = await useFetch<{ agents: any[] }>(`/api/managers/${id}/agents`, {
  credentials: 'include',
});
const managedAgents = computed(() => agentsData.value?.agents ?? []);

const { data: logsData, refresh: refreshLogs } = await useFetch<{ logs: any[] }>(`/api/managers/${id}/logs`, {
  credentials: 'include',
});
const logs = ref<any[]>(logsData.value?.logs ?? []);
const hasMoreLogs = ref((logsData.value?.logs?.length ?? 0) === 20);

// Polling: refresh manager (for doStatus) every 2s when running.
// Reload logs+agents when `deciding` transitions true→false (decision just finished).
// NOTE: tickCount increments at the START of alarm(), before runManagerLoop writes logs,
// so tracking tickCount would reload before the log entry exists. Track `deciding` instead.
let prevDeciding = doStatus.value?.deciding ?? false;

const pollTimer = setInterval(async () => {
  if (manager.value?.status !== 'running') return;
  await refresh();
  const nowDeciding = doStatus.value?.deciding ?? false;
  if (prevDeciding && !nowDeciding) {
    // Decision just finished — reload logs + agents
    const fresh = await $fetch<{ logs: any[] }>(`/api/managers/${id}/logs`, { credentials: 'include' });
    logs.value = fresh.logs ?? [];
    hasMoreLogs.value = (fresh.logs?.length ?? 0) === 20;
    await refreshAgents();
  }
  prevDeciding = nowDeciding;
}, 2000);

// Countdown to next decision — updated directly by interval, not via reactive `now`
const INTERVAL_MS: Record<string, number> = { '1h': 3600_000, '4h': 14400_000, '1d': 86400_000 };

const nextDecisionLabel = ref<string | null>(null);
const progressPct = ref(0);

function updateCountdown() {
  const nextAt = doStatus.value?.nextAlarmAt;
  if (!nextAt) {
    nextDecisionLabel.value = null;
    progressPct.value = 0;
    return;
  }
  const ms = nextAt - Date.now();
  if (ms <= 0) {
    nextDecisionLabel.value = 'imminently';
  } else {
    const s = Math.floor(ms / 1000);
    if (s < 60) nextDecisionLabel.value = `in ${s}s`;
    else {
      const m = Math.floor(s / 60);
      if (m < 60) nextDecisionLabel.value = `in ${m}m ${s % 60}s`;
      else {
        const h = Math.floor(m / 60);
        nextDecisionLabel.value = `in ${h}h ${m % 60}m`;
      }
    }
  }
  const intervalMs = INTERVAL_MS[manager.value?.config?.decisionInterval ?? '1h'] ?? 3600_000;
  const remaining = Math.max(0, nextAt - Date.now());
  const elapsed = intervalMs - remaining;
  progressPct.value = Math.min(100, Math.max(0, (elapsed / intervalMs) * 100));
}

const clockTimer = setInterval(updateCountdown, 1000);

onUnmounted(() => {
  clearInterval(pollTimer);
  clearInterval(clockTimer);
});

// Derived display values
const statusBadgeClass = computed(() => ({
  'badge-running': manager.value?.status === 'running',
  'badge-paused': manager.value?.status === 'paused',
  'badge-stopped': manager.value?.status === 'stopped',
}));

const shortModel = computed(() => {
  const m = manager.value?.config?.llmModel ?? '';
  return m.split('/').pop()?.replace(':free', '') ?? m;
});

const maxDrawdownLabel = computed(() => {
  const v = manager.value?.config?.riskParams?.maxTotalDrawdown;
  return v != null ? (v * 100).toFixed(0) + '%' : '—';
});

function agentBadgeClass(status: string) {
  return { 'badge-running': status === 'running', 'badge-paused': status === 'paused', 'badge-stopped': status === 'stopped' };
}

function actionBadgeClass(action: string) {
  if (action === 'create_agent') return 'badge-running';
  if (action === 'pause_agent' || action === 'terminate_agent') return 'badge-stopped';
  if (action === 'modify_agent') return 'badge-paused';
  return 'badge-stopped';
}

async function triggerDecision() {
  actionLoading.value = true;
  try {
    await $fetch(`/api/managers/${id}/trigger`, { method: 'POST', credentials: 'include' });
    activeTab.value = 'logs';
    await refresh();
  } catch (err) {
    console.error(err);
  } finally {
    actionLoading.value = false;
  }
}

async function doAction(action: 'start' | 'stop' | 'pause') {
  actionLoading.value = true;
  try {
    await $fetch(`/api/managers/${id}/${action}`, { method: 'POST', credentials: 'include' });
    await refresh();
    if (action === 'start') await refreshAgents();
  } catch (err) {
    console.error(err);
  } finally {
    actionLoading.value = false;
  }
}

async function loadMoreLogs() {
  const page = Math.ceil(logs.value.length / 20) + 1;
  const next = await $fetch<{ logs: any[] }>(`/api/managers/${id}/logs?page=${page}`, { credentials: 'include' });
  const newLogs = next.logs ?? [];
  logs.value.push(...newLogs);
  hasMoreLogs.value = newLogs.length === 20;
}
</script>

<style scoped>
.back-link { font-size: 13px; color: var(--text-muted); }
.back-link:hover { color: var(--text-dim); }

/* Deciding banner */
.deciding-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  margin-bottom: 20px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-radius: var(--radius);
  font-size: 13px;
}
.deciding-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  animation: deciding-pulse 1.2s ease-in-out infinite;
}
@keyframes deciding-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}
.deciding-text { color: var(--text); font-weight: 500; }
.deciding-hint { margin-left: auto; font-size: 12px; color: var(--text-muted); }

/* Next decision countdown bar */
.next-decision-bar {
  position: relative;
  height: 28px;
  margin-bottom: 20px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  display: flex;
  align-items: center;
}
.next-decision-progress {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--green) 12%, transparent);
  transition: width 1s linear;
}
.next-decision-label {
  position: relative;
  padding: 0 12px;
  font-size: 12px;
  color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
}
</style>
