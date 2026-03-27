<template>
  <main class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Agent Managers</h1>
        <p class="page-subtitle">{{ managers.length }} managers · {{ managers.filter(m => m.status === 'running').length }} running</p>
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <div class="view-toggle">
          <button :class="['toggle-btn', { active: viewMode === 'table' }]" title="Table view" @click="viewMode = 'table'">☰</button>
          <button :class="['toggle-btn', { active: viewMode === 'grid' }]" title="Grid view" @click="viewMode = 'grid'">⊞</button>
        </div>
        <NuxtLink to="/managers/new" class="btn btn-primary">+ New Manager</NuxtLink>
      </div>
    </div>

    <div v-if="pending" style="text-align: center; padding: 48px;">
      <span class="spinner" />
    </div>

    <div v-else-if="error" class="alert alert-error">Failed to load managers.</div>

    <div v-else-if="managers.length === 0" class="empty-state">
      <div class="empty-icon">🧠</div>
      <div class="empty-title">No managers yet</div>
      <p>Create a manager to autonomously run and optimize your trading agents.</p>
      <NuxtLink to="/managers/new" class="btn btn-primary" style="margin-top: 16px;">Create Manager</NuxtLink>
    </div>

    <!-- TABLE VIEW -->
    <div v-else-if="viewMode === 'table'" class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width: 32px;"></th>
            <th class="sortable" @click="toggleSort('name')">Name <span class="sort-icon">{{ sortIcon('name') }}</span></th>
            <th class="sortable" @click="toggleSort('status')">Status <span class="sort-icon">{{ sortIcon('status') }}</span></th>
            <th>Model</th>
            <th class="sortable" @click="toggleSort('decisionInterval')">Interval <span class="sort-icon">{{ sortIcon('decisionInterval') }}</span></th>
            <th class="sortable" @click="toggleSort('agentCount')">Agents <span class="sort-icon">{{ sortIcon('agentCount') }}</span></th>
            <th class="sortable" @click="toggleSort('createdAt')">Created <span class="sort-icon">{{ sortIcon('createdAt') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="m in sortedManagers"
            :key="m.id"
            class="manager-table-row"
            @click="$router.push(`/managers/${m.id}`)"
          >
            <td style="font-size: 18px; line-height: 1;">{{ managerEmoji(m) }}</td>
            <td style="font-weight: 500; color: var(--text);">{{ m.name }}</td>
            <td><span class="badge" :class="badgeClass(m.status)">{{ m.status }}</span></td>
            <td style="color: var(--text-muted); font-size: 12px;">{{ shortModel(m.config?.llmModel) }}</td>
            <td class="mono" style="font-size: 12px;">{{ m.config?.decisionInterval ?? '—' }}</td>
            <td class="mono" style="font-size: 12px;">{{ m.agentCount ?? '—' }}</td>
            <td style="color: var(--text-muted); font-size: 12px;">{{ formatDate(m.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- GRID VIEW -->
    <div v-else class="agents-grid">
      <ManagerCard
        v-for="m in managers"
        :key="m.id"
        :manager="m"
      />
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { getManagerProfile, DEFAULT_MANAGER_PROFILE_ID } from '@dex-agents/shared';

definePageMeta({ ssr: false });

const router = useRouter();

type ManagerListItem = {
  id: string;
  name: string;
  status: string;
  profileId?: string | null;
  agentCount?: number;
  createdAt: string;
  config: {
    llmModel?: string;
    decisionInterval?: string;
    profileId?: string;
  } | null;
};

const { data, pending, error } = await useFetch<{ managers: ManagerListItem[] }>('/api/managers', {
  credentials: 'include',
});
const managers = computed(() => data.value?.managers ?? []);

const viewMode = ref<'table' | 'grid'>('table');

type SortKey = 'name' | 'status' | 'decisionInterval' | 'agentCount' | 'createdAt';
type SortDir = 'asc' | 'desc';
const sortKey = ref<SortKey>('name');
const sortDir = ref<SortDir>('asc');

function toggleSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'asc';
  }
}

function sortIcon(key: SortKey) {
  if (sortKey.value !== key) return '↕';
  return sortDir.value === 'asc' ? '↑' : '↓';
}

const sortedManagers = computed(() => {
  return [...managers.value].sort((a, b) => {
    const av = managerSortValue(a, sortKey.value);
    const bv = managerSortValue(b, sortKey.value);
    const dir = sortDir.value === 'asc' ? 1 : -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
});

function managerSortValue(manager: ManagerListItem, key: SortKey): string | number {
  switch (key) {
    case 'decisionInterval':
      return manager.config?.decisionInterval ?? '';
    case 'agentCount':
      return manager.agentCount ?? 0;
    case 'name':
      return manager.name;
    case 'status':
      return manager.status;
    case 'createdAt':
      return manager.createdAt;
  }
}

function managerEmoji(m: ManagerListItem) {
  const configProfileId = m.config?.profileId;
  const profileId = m.profileId ?? configProfileId ?? DEFAULT_MANAGER_PROFILE_ID;
  return getManagerProfile(profileId)?.emoji ?? '🧠';
}

function badgeClass(status: string) {
  return {
    'badge-running': status === 'running',
    'badge-paused': status === 'paused',
    'badge-stopped': status === 'stopped',
  };
}

function shortModel(llmModel?: string) {
  if (!llmModel) return '—';
  return llmModel.split('/').pop()?.replace(':free', '') ?? llmModel;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
</script>

<style scoped>
.view-toggle {
  display: flex;
  gap: 2px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius, 6px);
  padding: 2px;
}
.toggle-btn {
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  transition: background 0.15s, color 0.15s;
}
.toggle-btn.active {
  background: var(--accent);
  color: #fff;
}
.manager-table-row {
  cursor: pointer;
  transition: background 0.12s;
}
.manager-table-row:hover {
  background: var(--bg-hover);
}
.sortable {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.sortable:hover { color: var(--text); }
.sort-icon {
  font-size: 10px;
  color: var(--text-muted);
  margin-left: 2px;
}
</style>
