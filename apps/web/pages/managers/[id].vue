<template>
  <div class="p-6 max-w-6xl mx-auto">
    <!-- Header -->
    <div class="flex items-center gap-3 mb-6">
      <NuxtLink to="/managers" class="text-gray-400 hover:text-white text-sm">← Managers</NuxtLink>
      <h1 class="text-xl font-bold text-white truncate">{{ manager?.name ?? 'Loading…' }}</h1>
      <span v-if="manager" :class="statusClass" class="text-xs px-2 py-0.5 rounded-full shrink-0">
        {{ manager.status }}
      </span>
    </div>

    <div v-if="pending" class="text-gray-400 text-sm">Loading…</div>
    <div v-else-if="!manager" class="text-red-400">Manager not found.</div>
    <template v-else>

      <!-- Controls -->
      <div class="flex gap-3 mb-6">
        <button
          v-if="manager.status !== 'running'"
          @click="doAction('start')"
          :disabled="actionLoading"
          class="bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
        >
          Start
        </button>
        <button
          v-if="manager.status === 'running'"
          @click="doAction('pause')"
          :disabled="actionLoading"
          class="bg-yellow-700 hover:bg-yellow-600 disabled:opacity-50 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
        >
          Pause
        </button>
        <button
          v-if="manager.status !== 'stopped'"
          @click="doAction('stop')"
          :disabled="actionLoading"
          class="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
        >
          Stop
        </button>
        <NuxtLink
          :to="`/managers/${manager.id}/edit`"
          class="border border-gray-600 text-gray-400 hover:text-white px-4 py-2 rounded text-sm transition-colors"
        >
          Edit
        </NuxtLink>
      </div>

      <!-- Config Summary -->
      <div class="bg-gray-900 border border-gray-700 rounded-lg p-4 mb-6">
        <h2 class="text-sm font-semibold text-gray-400 mb-3">Configuration</h2>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div class="text-gray-500 text-xs mb-1">Model</div>
            <div class="text-gray-300 truncate">{{ shortModel }}</div>
          </div>
          <div>
            <div class="text-gray-500 text-xs mb-1">Temperature</div>
            <div class="text-gray-300">{{ manager.config?.temperature ?? '—' }}</div>
          </div>
          <div>
            <div class="text-gray-500 text-xs mb-1">Interval</div>
            <div class="text-gray-300">{{ manager.config?.decisionInterval ?? '—' }}</div>
          </div>
          <div>
            <div class="text-gray-500 text-xs mb-1">Max Drawdown</div>
            <div class="text-gray-300">{{ manager.config?.riskParams?.maxTotalDrawdown != null ? (manager.config.riskParams.maxTotalDrawdown * 100).toFixed(0) + '%' : '—' }}</div>
          </div>
        </div>
      </div>

      <!-- Managed Agents -->
      <section class="mb-6">
        <h2 class="text-lg font-semibold text-white mb-3">Managed Agents ({{ managedAgents.length }})</h2>
        <div v-if="managedAgents.length === 0" class="text-gray-500 text-sm py-4">
          No agents yet. The manager will create them based on its strategy.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-gray-400 border-b border-gray-700">
              <tr>
                <th class="text-left py-2 pr-4">Name</th>
                <th class="text-left py-2 pr-4">Status</th>
                <th class="text-left py-2 pr-4">Pairs</th>
                <th class="text-left py-2">View</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in managedAgents" :key="a.id" class="border-b border-gray-800">
                <td class="py-2 pr-4 text-white">{{ a.name }}</td>
                <td class="py-2 pr-4">
                  <span :class="agentStatusClass(a.status)" class="text-xs px-2 py-0.5 rounded-full">{{ a.status }}</span>
                </td>
                <td class="py-2 pr-4 text-gray-400 text-xs">{{ a.config?.pairs?.join(', ') ?? '—' }}</td>
                <td class="py-2">
                  <NuxtLink :to="`/agents/${a.id}`" class="text-xs text-green-500 hover:underline">View →</NuxtLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Decision Logs -->
      <section>
        <h2 class="text-lg font-semibold text-white mb-3">Recent Decisions</h2>
        <div v-if="logs.length === 0" class="text-gray-500 text-sm py-4">No decisions logged yet.</div>
        <div v-else class="space-y-2">
          <div v-for="log in logs" :key="log.id" class="bg-gray-900 border border-gray-800 rounded p-3 text-sm">
            <div class="flex items-center gap-2 mb-1">
              <span :class="actionClass(log.action)" class="px-2 py-0.5 rounded text-xs font-medium">{{ log.action }}</span>
              <span class="text-gray-500 text-xs">{{ new Date(log.createdAt).toLocaleString() }}</span>
            </div>
            <p class="text-gray-300">{{ log.reasoning }}</p>
            <p v-if="log.result?.detail" class="text-gray-500 text-xs mt-1">{{ log.result.detail }}</p>
            <p v-if="log.result?.error" class="text-red-400 text-xs mt-1">Error: {{ log.result.error }}</p>
          </div>
        </div>
        <button
          v-if="hasMoreLogs"
          @click="loadMoreLogs"
          class="mt-3 text-sm text-gray-500 hover:text-white transition-colors"
        >
          Load more…
        </button>
      </section>

    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRoute } from 'vue-router';

definePageMeta({ middleware: 'auth' });

const route = useRoute();
const id = route.params.id as string;

const actionLoading = ref(false);

const { data: managerData, pending, refresh } = await useFetch<any>(`/api/managers/${id}`, {
  credentials: 'include',
});
const manager = computed(() => managerData.value ?? null);

const { data: agentsData, refresh: refreshAgents } = await useFetch<{ agents: any[] }>(`/api/managers/${id}/agents`, {
  credentials: 'include',
});
const managedAgents = computed(() => agentsData.value?.agents ?? []);

const { data: logsData } = await useFetch<{ logs: any[] }>(`/api/managers/${id}/logs`, {
  credentials: 'include',
});
const logs = ref<any[]>(logsData.value?.logs ?? []);
const hasMoreLogs = ref((logsData.value?.logs?.length ?? 0) === 20);

const statusClass = computed(() => {
  const s = manager.value?.status;
  return {
    'bg-green-900 text-green-300': s === 'running',
    'bg-yellow-900 text-yellow-300': s === 'paused',
    'bg-gray-800 text-gray-400': s === 'stopped',
  };
});

const shortModel = computed(() => {
  const m = manager.value?.config?.llmModel ?? '';
  return m.split('/').pop()?.replace(':free', '') ?? m;
});

function agentStatusClass(status: string) {
  return {
    'bg-green-900 text-green-300': status === 'running',
    'bg-yellow-900 text-yellow-300': status === 'paused',
    'bg-gray-800 text-gray-400': status === 'stopped',
  };
}

function actionClass(action: string) {
  if (action === 'create_agent') return 'bg-blue-900 text-blue-300';
  if (action === 'pause_agent' || action === 'terminate_agent') return 'bg-red-900 text-red-300';
  if (action === 'modify_agent') return 'bg-yellow-900 text-yellow-300';
  return 'bg-gray-800 text-gray-400';
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
  const currentPage = Math.ceil(logs.value.length / 20) + 1;
  const next = await $fetch<{ logs: any[] }>(`/api/managers/${id}/logs?page=${currentPage}`, {
    credentials: 'include',
  });
  const newLogs = next.logs ?? [];
  logs.value.push(...newLogs);
  hasMoreLogs.value = newLogs.length === 20;
}
</script>
