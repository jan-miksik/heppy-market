<template>
  <main class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Agent Managers</h1>
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <NuxtLink to="/managers/new" class="btn btn-primary">+ New Manager</NuxtLink>
      </div>
    </div>

    <div v-if="pending" class="page-loader">
      <div class="page-loader-track">
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
      </div>
      <span class="page-loader-label">Loading managers</span>
    </div>

    <div v-else-if="error" class="alert alert-error">Failed to load managers.</div>

    <div v-else-if="managers.length === 0" class="empty-state">
      <div class="empty-icon">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="16" cy="9" r="3" />
          <circle cx="7" cy="24" r="2.5" />
          <circle cx="16" cy="24" r="2.5" />
          <circle cx="25" cy="24" r="2.5" />
          <path d="M16 12 L7 21.5" />
          <path d="M16 12 L16 21.5" />
          <path d="M16 12 L25 21.5" />
        </svg>
      </div>
      <div class="empty-title">No paper managers yet</div>
      <p>Create a manager to autonomously run and optimize paper trading agents.</p>
      <NuxtLink to="/managers/new" class="btn btn-primary" style="margin-top: 16px;">Create Manager</NuxtLink>
    </div>

    <div v-else class="table-wrap managers-table-wrap">
      <table>
        <thead>
          <tr>
            <th class="icon-col"></th>
            <th class="sortable" @click="toggleSort('name')">Name <span class="sort-icon">{{ sortIcon('name') }}</span></th>
            <th class="sortable" @click="toggleSort('status')">Status <span class="sort-icon">{{ sortIcon('status') }}</span></th>
            <th>Model</th>
            <th class="sortable" @click="toggleSort('decisionInterval')">Interval <span class="sort-icon">{{ sortIcon('decisionInterval') }}</span></th>
            <th class="sortable" @click="toggleSort('agentCount')">Agents <span class="sort-icon">{{ sortIcon('agentCount') }}</span></th>
            <th class="sortable" @click="toggleSort('createdAt')">Created <span class="sort-icon">{{ sortIcon('createdAt') }}</span></th>
            <th style="text-align: right; white-space: nowrap;">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="m in sortedManagers"
            :key="m.id"
            class="manager-table-row"
            @click="$router.push(`/managers/${m.id}`)"
          >
            <td class="icon-col">
              <ProfileIcon :profile-id="m.profileId || m.config?.profileId" :size="28" />
            </td>
            <td style="font-weight: 500; color: var(--text);">{{ m.name }}</td>
            <td><span class="badge" :class="badgeClass(m.status)">{{ m.status }}</span></td>
            <td style="color: var(--text-muted); font-size: 12px;">{{ shortModel(m.config?.llmModel) }}</td>
            <td class="mono" style="font-size: 12px;">{{ m.config?.decisionInterval ?? '—' }}</td>
            <td class="mono" style="font-size: 12px;">{{ m.agentCount ?? '—' }}</td>
            <td style="color: var(--text-muted); font-size: 12px;">{{ formatDate(m.createdAt) }}</td>
            <td style="text-align: right;" @click.stop>
              <div class="manager-actions-menu">
                <button
                  type="button"
                  class="manager-actions-trigger"
                  @click="openActionsForManager = openActionsForManager === m.id ? null : m.id"
                >
                  ⋯
                </button>
                <div
                  v-if="openActionsForManager === m.id"
                  class="manager-actions-dropdown"
                >
                  <button
                    v-if="m.status !== 'running'"
                    type="button"
                    class="menu-item"
                    @click="handleAction(m.id, 'start')"
                  >
                    ▶ Start
                  </button>
                  <button
                    v-else
                    type="button"
                    class="menu-item"
                    @click="handleAction(m.id, 'stop')"
                  >
                    ■ Stop
                  </button>
                  <NuxtLink
                    :to="`/managers/${m.id}/edit`"
                    class="menu-item"
                    style="display: block; text-decoration: none;"
                  >
                    ✎ Edit
                  </NuxtLink>
                  <button
                    type="button"
                    class="menu-item menu-item--danger"
                    @click="handleDelete(m.id)"
                  >
                    ✕ Delete
                  </button>
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { getManagerProfile, DEFAULT_MANAGER_PROFILE_ID } from '@something-in-loop/shared';
import type { ManagerSummary } from '~/composables/useManagers';

definePageMeta({ ssr: false });

const { managers, loading: pending, error, fetchManagers, startManager, stopManager, deleteManager } = useManagers();
await fetchManagers();

const openActionsForManager = ref<string | null>(null);

function handleGlobalClick(e: MouseEvent) {
  const target = e.target as Node | null;
  if (!target) return;
  if (openActionsForManager.value) {
    const withinActionsMenu = (target as HTMLElement | null)?.closest?.('.manager-actions-menu');
    if (!withinActionsMenu) {
      openActionsForManager.value = null;
    }
  }
}

onMounted(() => {
  document.addEventListener('click', handleGlobalClick);
});

onUnmounted(() => {
  document.removeEventListener('click', handleGlobalClick);
});

async function handleAction(id: string, action: 'start' | 'stop') {
  try {
    if (action === 'start') await startManager(id);
    else await stopManager(id);
    await fetchManagers({ force: true });
    openActionsForManager.value = null;
  } catch (e) {
    alert(`Failed to ${action}: ${extractApiError(e)}`);
  }
}

async function handleDelete(id: string) {
  if (!confirm('Delete this manager? Paper agents can be detached or deleted in the next step.')) return;
  // Note: For simplicity in the list view, we just delete the manager. 
  // The API likely handles agent detachment/deletion or we can provide a modal.
  // Given the request, we'll navigate to the detail page or handle it here if possible.
  try {
    await deleteManager(id);
    await fetchManagers({ force: true });
    openActionsForManager.value = null;
  } catch (e) {
    alert(`Failed to delete: ${extractApiError(e)}`);
  }
}

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

function managerSortValue(manager: ManagerSummary, key: SortKey): string | number {
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
.icon-col {
  width: 52px;
  padding-left: 12px !important;
  padding-right: 8px !important;
  text-align: center;
  vertical-align: middle;
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
.managers-table-wrap {
  overflow: visible;
}
.manager-actions-menu {
  position: relative;
  display: inline-block;
}
.manager-actions-trigger {
  cursor: pointer;
  padding: 2px 8px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-muted);
  font-size: 14px;
  transition: border-color 150ms ease-out, color 150ms ease-out;
}
.manager-actions-trigger:hover {
  border-color: var(--border-light);
  color: var(--text);
}
.manager-actions-dropdown {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  padding: 6px 0;
  min-width: 140px;
  z-index: 999;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
  border-radius: var(--radius);
}
.menu-item {
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: none;
  text-align: center;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}
.menu-item:hover {
  background: var(--bg-hover);
}
.menu-item--danger {
  color: var(--red);
}
.menu-item--danger:hover {
  background: var(--red-dim);
}
</style>
