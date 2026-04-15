<script setup lang="ts">
import { getAgentProfile, DEFAULT_AGENT_PROFILE_ID } from '@something-in-loop/shared';
import type { PaperMode } from '~/composables/usePaperModePreference';

definePageMeta({ ssr: false });
const { agents, loading, error, fetchAgents, createAgent, startAgent, stopAgent, deleteAgent, updateAgent } = useAgents();
const { stats, error: tradesError, fetchStats } = useTrades();
const { stats: paperStats, fetchStats: fetchPaperStats } = useTrades();
const { request } = useApi();
const { paperModePreference: storedPaperMode, setPaperModePreference } = usePaperModePreference();
const router = useRouter();
const refreshing = ref(false);

const overviewError = computed(() => tradesError.value);
const runningCount = computed(() => agents.value.filter((a) => a.status === 'running').length);

const realAgents = computed(() => agents.value.filter((a) => !a.isPaper));
const paperAgents = computed(() => agents.value.filter((a) => a.isPaper));
const hasRealAgents = computed(() => realAgents.value.length > 0);
const hasPaperAgents = computed(() => paperAgents.value.length > 0);

const paperMode = computed<PaperMode>(() => {
  if (!hasRealAgents.value && hasPaperAgents.value) return 'paper';
  if (hasRealAgents.value && !hasPaperAgents.value) return 'live';
  return storedPaperMode.value ?? 'live';
});

const visibleAgents = computed(() => {
  switch (paperMode.value) {
    case 'live': return realAgents.value;
    case 'paper': return paperAgents.value;
    case 'all': return agents.value;
    default: return realAgents.value;
  }
});

const isPaperOnly = computed(() => paperMode.value === 'paper');
const showPaperBand = computed(() => paperMode.value === 'all' && hasPaperAgents.value);
const primaryTradeStats = computed(() => (isPaperOnly.value ? paperStats.value : stats.value));
const primaryRealizedPnlUsd = computed(() => (isPaperOnly.value ? paperRealizedPnlUsd.value : realizedPnlUsd.value));

const managedAgents = computed(() => agents.value.filter((a) => !!a.managerId));

const editingAgent = ref<(typeof agents.value)[0] | null>(null);
const showEditModal = ref(false);
const saving = ref(false);
const saveError = ref('');


// Column visibility for table view
type ColumnKey =
  | 'status'
  | 'pairs'
  | 'model'
  | 'analysisInterval'
  | 'paperBalance'
  | 'maxPositionSizePct'
  | 'slTp'
  | 'totalPnl'
  | 'actions';

const STORAGE_KEY = 'heppy:agents:visibleColumns';

const defaultVisibleColumns: Record<ColumnKey, boolean> = {
  status: true,
  pairs: false,
  model: false,
  analysisInterval: true,
  paperBalance: true,
  maxPositionSizePct: false,
  slTp: false,
  totalPnl: true,
  actions: true,
};

const visibleColumns = ref<Record<ColumnKey, boolean>>({ ...defaultVisibleColumns });

const showColumnMenu = ref(false);
const columnMenuRef = ref<HTMLElement | null>(null);
const columnMenuButtonRef = ref<HTMLElement | null>(null);

// Row actions menu (max one open at a time)
const openActionsForAgent = ref<string | null>(null);

// Sorting
type SortKey =
  | 'name'
  | 'status'
  | 'analysisInterval'
  | 'paperBalance'
  | 'maxPositionSizePct'
  | 'totalPnl';
type SortDir = 'asc' | 'desc';
const sortKey = ref<SortKey>('name');
const sortDir = ref<SortDir>('asc');

watch(
  visibleColumns,
  (val) => {
    if (import.meta.client) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
    }
  },
  { deep: true },
);

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

function sortedList(list: typeof agents.value) {
  return [...list].sort((a, b) => {
    let av: any, bv: any;
    if (sortKey.value === 'analysisInterval') {
      av = a.config.analysisInterval;
      bv = b.config.analysisInterval;
    } else if (sortKey.value === 'paperBalance') {
      av = agentBalance(a);
      bv = agentBalance(b);
    } else if (sortKey.value === 'maxPositionSizePct') {
      av = a.config.maxPositionSizePct;
      bv = b.config.maxPositionSizePct;
    } else if (sortKey.value === 'totalPnl') {
      av = agentPnl.value[a.id]?.totalPnlUsd ?? 0;
      bv = agentPnl.value[b.id]?.totalPnlUsd ?? 0;
    } else {
      av = (a as any)[sortKey.value] ?? '';
      bv = (b as any)[sortKey.value] ?? '';
    }
    const dir = sortDir.value === 'asc' ? 1 : -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

const sortedAgents = computed(() => sortedList(visibleAgents.value));

// Per-agent P&L (realized P&L from closed trades; synced with agent detail table)
const agentPnl = ref<Record<string, { totalPnlUsd: number; totalPnlPct: number }>>({});

function sumPnlForAgents(agentList: typeof agents.value, fallback: number) {
  if (agentList.length === 0) return 0;
  const ids = new Set(agentList.map((a) => a.id));
  let sum = 0;
  let hasAny = false;
  for (const [agentId, pnl] of Object.entries(agentPnl.value)) {
    if (!ids.has(agentId)) continue;
    sum += pnl.totalPnlUsd;
    hasAny = true;
  }
  if (!hasAny) return fallback;
  return sum;
}

const realizedPnlUsd = computed(() =>
  sumPnlForAgents(realAgents.value, stats.value?.totalPnlUsd ?? 0),
);
const paperRealizedPnlUsd = computed(() =>
  sumPnlForAgents(paperAgents.value, paperStats.value?.totalPnlUsd ?? 0),
);

function formatUsdNoNegativeZero(value: number, digits = 0): string {
  const abs = Math.abs(value);
  const effectiveDigits = digits === 0 && abs < 1 ? 2 : digits;
  const roundingUnit = 10 ** (-effectiveDigits);
  const roundsToZero = abs < 0.5 * roundingUnit;
  const normalized = Object.is(value, -0) || roundsToZero ? 0 : value;
  if (normalized < 0) return `$-${Math.abs(normalized).toFixed(effectiveDigits)}`;
  return `$${normalized.toFixed(effectiveDigits)}`;
}

function formatPnlInline(usd?: number | null, pct?: number | null): string {
  if (usd === undefined || usd === null || pct === undefined || pct === null) return '—';
  const normalizedPct = Object.is(pct, -0) || Math.abs(pct) < 0.05 ? 0 : pct;
  return `${formatUsdNoNegativeZero(usd, 0)} (${normalizedPct.toFixed(1)}%)`;
}

function agentBalance(agent: (typeof agents.value)[0]): number {
  return agent.config.paperBalance + (agentPnl.value[agent.id]?.totalPnlUsd ?? 0);
}

function winRateClass(rate?: number | null): 'positive' | 'negative' | 'neutral' {
  if (!rate) return 'neutral';
  return rate >= 50 ? 'positive' : 'negative';
}

function setPaperMode(value: PaperMode) {
  setPaperModePreference(value);
}

async function loadAgentPerformance(agentId: string) {
  try {
    const agent = agents.value.find((a) => a.id === agentId);
    if (!agent) return;
    const startingBalance = agent.config.paperBalance;
    // Use live trade history so refresh reflects the latest closed trades immediately.
    // Use live trade history so refresh reflects the latest closed trades immediately.
    const tradesRes = await request<{ trades: Array<{ status: 'open' | 'closed'; pnlUsd?: number | null }> }>(
      `/api/agents/${agentId}/trades`,
      { silent: true }
    ).catch(() => null);
    const totalPnlUsd = (tradesRes?.trades ?? [])
      .filter((t) => t.status === 'closed')
      .reduce((sum, t) => sum + (t.pnlUsd != null ? Number(t.pnlUsd) : 0), 0);
    const totalPnlPct = startingBalance > 0 ? (totalPnlUsd / startingBalance) * 100 : 0;
    if (!agents.value.some((a) => a.id === agentId)) return;
    agentPnl.value = {
      ...agentPnl.value,
      [agentId]: { totalPnlUsd, totalPnlPct },
    };
  } catch {
    // ignore per-agent performance errors in list view
  }
}

watch(
  agents,
  (list) => {
    const listIds = new Set(list.map((a) => a.id));
    const nextPnl: Record<string, { totalPnlUsd: number; totalPnlPct: number }> = {};
    for (const [agentId, pnl] of Object.entries(agentPnl.value)) {
      if (listIds.has(agentId)) nextPnl[agentId] = pnl;
    }
    agentPnl.value = nextPnl;
    for (const a of list) {
      loadAgentPerformance(a.id);
    }
  },
  { immediate: true },
);


function handleGlobalClick(e: MouseEvent) {
  const target = e.target as Node | null;
  if (!target) return;
  // Column menu close on outside click
  if (showColumnMenu.value) {
    if (!columnMenuRef.value?.contains(target) && !columnMenuButtonRef.value?.contains(target)) {
      showColumnMenu.value = false;
    }
  }
  // Row actions dropdown close on outside click
  if (openActionsForAgent.value) {
    const withinActionsMenu = (target as HTMLElement | null)?.closest?.('.agent-actions-menu');
    if (!withinActionsMenu) {
      openActionsForAgent.value = null;
    }
  }
}

onMounted(() => {
  if (import.meta.client) {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        visibleColumns.value = { ...defaultVisibleColumns, ...parsed };
      } catch (e) {
        // ignore parse errors
      }
    }
  }

  refreshOverview(false);
  document.addEventListener('click', handleGlobalClick);
});

onUnmounted(() => {
  document.removeEventListener('click', handleGlobalClick);
});

async function refreshOverview(force = false) {
  refreshing.value = true;
  try {
    await Promise.all([
      fetchAgents({ force }),
      fetchStats({ force, isPaper: false }),
      fetchPaperStats({ force, isPaper: true }),
    ]);
    await Promise.all(agents.value.map((a) => loadAgentPerformance(a.id)));
  } finally {
    refreshing.value = false;
  }
}


async function handleDelete(id: string) {
  if (!confirm('Delete this agent? This cannot be undone.')) return;
  try {
    await deleteAgent(id);
    await Promise.all([fetchStats({ force: true, isPaper: false }), fetchPaperStats({ force: true, isPaper: true })]);
  } catch (e) {
    alert(`Failed to delete: ${extractApiError(e)}`);
  }
}

function handleEditClick(id: string) {
  const found = agents.value.find((a) => a.id === id) ?? null;
  editingAgent.value = found;
  saveError.value = '';
  showEditModal.value = true;
}

async function handleEditSubmit(payload: Parameters<typeof updateAgent>[1]) {
  if (!editingAgent.value) return;
  saving.value = true;
  saveError.value = '';
  try {
    await updateAgent(editingAgent.value.id, payload);
    showEditModal.value = false;
    editingAgent.value = null;
  } catch (e) {
    saveError.value = extractApiError(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <main class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Agents</h1>
      </div>
      <div class="page-header__actions">
        <PaperToggle
          v-if="agents.length > 0"
          :model-value="paperMode"
          :has-live="hasRealAgents"
          :has-paper="hasPaperAgents"
          @update:model-value="setPaperMode"
        />
        <button class="btn btn-primary" @click="$router.push('/agents/create')">
          + New Agent
        </button>
      </div>
    </div>

    <div v-if="overviewError" class="alert alert-error" style="margin-bottom: 12px;">{{ overviewError }}</div>

    <template v-if="!loading">
      <div v-if="primaryTradeStats && visibleAgents.length > 0" class="stats-section" style="margin-bottom: 16px;">
        <div class="stats-grid">
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
              <div class="stat-value">{{ primaryTradeStats.totalTrades }}</div>
              <div class="stat-change">{{ primaryTradeStats.openTrades }} open</div>
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
              <div class="stat-value" :class="winRateClass(primaryTradeStats.winRate)">
                {{ primaryTradeStats.winRate.toFixed(1) + '%' }}
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
              <div class="stat-value" :class="primaryRealizedPnlUsd >= 0 ? 'positive' : 'negative'">
                {{ formatUsdNoNegativeZero(primaryRealizedPnlUsd, 0) }}
              </div>
              <div class="stat-change">{{ isPaperOnly ? 'closed trades · simulated' : 'closed trades' }}</div>
            </div>
            <Transition name="paper-band">
              <div v-if="showPaperBand && paperStats" class="stat-card__band stat-card__band--paper">
                <div class="stat-card__paper-label">Total P&amp;L</div>
                <div
                  class="stat-card__paper-value"
                  :class="paperRealizedPnlUsd >= 0 ? 'positive' : 'negative'"
                >
                  {{ formatUsdNoNegativeZero(paperRealizedPnlUsd, 0) }}
                </div>
                <div class="stat-card__paper-meta">closed trades · simulated</div>
              </div>
            </Transition>
          </div>
        </div>
      </div>
    </template>

    <div v-if="loading" class="page-loader">
      <div class="page-loader-track">
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
      </div>
      <span class="page-loader-label">Loading agents</span>
    </div>

    <div v-else-if="error" class="alert alert-error">{{ error }}</div>

    <div v-else-if="agents.length === 0" class="empty-state">
      <div class="empty-icon">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="16" cy="16" r="8" />
          <circle cx="16" cy="16" r="2.5" fill="currentColor" stroke="none" />
          <path d="M16 8 V5" />
          <path d="M16 24 V27" />
          <path d="M8 16 H5" />
          <path d="M24 16 H27" />
          <path d="M10.3 10.3 L8.2 8.2" />
          <path d="M21.7 21.7 L23.8 23.8" />
          <path d="M21.7 10.3 L23.8 8.2" />
          <path d="M10.3 21.7 L8.2 23.8" />
        </svg>
      </div>
      <div class="empty-title">No agents yet</div>
      <p>Create your first AI trading agent to get started.</p>
      <button class="btn btn-primary" style="margin-top: 16px;" @click="$router.push('/agents/create')">
        Create Agent
      </button>
    </div>

    <!-- TABLE VIEW -->
    <div v-else>
      <div class="table-wrap" style="overflow: visible;">
        <table>
          <thead>
            <tr>
              <th class="icon-col"></th>
              <th class="sortable" @click="toggleSort('name')">Name <span class="sort-icon">{{ sortIcon('name') }}</span></th>
              <th
                v-if="visibleColumns.status"
                class="sortable"
                @click="toggleSort('status')"
              >
                Status <span class="sort-icon">{{ sortIcon('status') }}</span>
              </th>
              <th v-if="visibleColumns.pairs">Pairs</th>
              <th v-if="visibleColumns.model">Model</th>
              <th
                v-if="visibleColumns.analysisInterval"
                class="sortable"
                @click="toggleSort('analysisInterval')"
              >
                Interval <span class="sort-icon">{{ sortIcon('analysisInterval') }}</span>
              </th>
              <th
                v-if="visibleColumns.paperBalance"
                class="sortable"
                @click="toggleSort('paperBalance')"
              >
                Balance <span class="sort-icon">{{ sortIcon('paperBalance') }}</span>
              </th>
              <th
                v-if="visibleColumns.maxPositionSizePct"
                class="sortable"
                @click="toggleSort('maxPositionSizePct')"
              >
                Max Pos <span class="sort-icon">{{ sortIcon('maxPositionSizePct') }}</span>
              </th>
              <th v-if="visibleColumns.slTp" style="min-width: 120px; white-space: nowrap;">SL / TP</th>
              <th
                v-if="visibleColumns.totalPnl"
                class="sortable"
                @click="toggleSort('totalPnl')"
              >
                Total P&amp;L <span class="sort-icon">{{ sortIcon('totalPnl') }}</span>
              </th>
              <th v-if="visibleColumns.actions" style="text-align: right; white-space: nowrap;">Actions</th>
              <th class="col-picker-th" ref="columnMenuButtonRef">
                <button
                  type="button"
                  class="col-picker-btn"
                  :class="{ active: showColumnMenu }"
                  title="Configure visible columns"
                  @click.stop="showColumnMenu = !showColumnMenu"
                >⋮</button>
                <div
                  v-if="showColumnMenu"
                  ref="columnMenuRef"
                  class="col-picker-panel"
                >
                  <div class="col-picker-title">Columns</div>
                  <div class="col-picker-list">
                    <label><input v-model="visibleColumns.status" type="checkbox" /> Status</label>
                    <label><input v-model="visibleColumns.pairs" type="checkbox" /> Pairs</label>
                    <label><input v-model="visibleColumns.model" type="checkbox" /> Model</label>
                    <label><input v-model="visibleColumns.analysisInterval" type="checkbox" /> Interval</label>
                    <label><input v-model="visibleColumns.paperBalance" type="checkbox" /> Balance</label>
                    <label><input v-model="visibleColumns.maxPositionSizePct" type="checkbox" /> Max Pos</label>
                    <label><input v-model="visibleColumns.slTp" type="checkbox" /> SL / TP</label>
                    <label><input v-model="visibleColumns.totalPnl" type="checkbox" /> Total P&amp;L</label>
                    <label><input v-model="visibleColumns.actions" type="checkbox" /> Actions</label>
                  </div>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="agent in sortedAgents"
              :key="agent.id"
              class="agent-table-row"
              :class="{ 'row--paper': agent.isPaper }"
              @click="$router.push(`/agents/${agent.id}`)"
            >
              <td class="icon-col">
                <ProfileIcon :profile-id="agent.profileId || agent.config?.profileId" :size="28" />
              </td>
              <td>
                <span style="font-weight: 500; color: var(--text);">{{ agent.name }}</span>
                <span v-if="agent.isPaper" class="paper-tag">PAPER</span>
                <span v-if="agent.managerId" class="managed-tag">
                  <ProfileIcon profile-id="passive_index" :size="12" style="margin-right: 4px;" />
                  managed
                </span>
              </td>
              <td v-if="visibleColumns.status">
                <span class="badge" :class="`badge-${agent.status}`">{{ agent.status }}</span>
              </td>
              <td v-if="visibleColumns.pairs" class="mono" style="font-size: 12px;">
                {{ agent.config.pairs.join(', ') }}
              </td>
              <td v-if="visibleColumns.model" style="color: var(--text-muted); font-size: 12px;">
                {{ agent.llmModel.split('/')[1]?.replace(':free', '') ?? agent.llmModel }}
              </td>
              <td v-if="visibleColumns.analysisInterval" class="mono" style="font-size: 12px;">
                {{ agent.config.analysisInterval }}
              </td>
              <td v-if="visibleColumns.paperBalance" class="mono" style="font-size: 12px;">
                {{ formatUsdNoNegativeZero(agentBalance(agent), 0) }}
              </td>
              <td v-if="visibleColumns.maxPositionSizePct" class="mono" style="font-size: 12px;">
                {{ agent.config.maxPositionSizePct }}%
              </td>
              <td v-if="visibleColumns.slTp" class="mono" style="font-size: 12px; white-space: nowrap;">
                {{ agent.config.stopLossPct }}% / {{ agent.config.takeProfitPct }}%
              </td>
              <td v-if="visibleColumns.totalPnl" class="mono" style="font-size: 12px; white-space: nowrap;">
                <Transition name="pnl">
                  <span
                    v-if="agentPnl[agent.id]"
                    :key="formatPnlInline(agentPnl[agent.id]!.totalPnlUsd, agentPnl[agent.id]!.totalPnlPct)"
                    :class="agentPnl[agent.id]!.totalPnlUsd > 0 ? 'positive' : agentPnl[agent.id]!.totalPnlUsd < 0 ? 'negative' : 'neutral'"
                  >{{ formatPnlInline(agentPnl[agent.id]!.totalPnlUsd, agentPnl[agent.id]!.totalPnlPct) }}</span>
                  <span v-else key="empty" style="color: var(--text-muted);">—</span>
                </Transition>
              </td>
              <td v-if="visibleColumns.actions" style="text-align: right;" @click.stop>
                <div class="agent-actions-menu">
                  <button
                    type="button"
                    class="agent-actions-trigger"
                    @click="openActionsForAgent = openActionsForAgent === agent.id ? null : agent.id"
                  >
                    ⋯
                  </button>
                  <div
                    v-if="openActionsForAgent === agent.id"
                    class="agent-actions-dropdown"
                  >
                    <button
                      v-if="agent.status !== 'running'"
                      type="button"
                      class="menu-item"
                      @click="startAgent(agent.id)"
                    >
                      ▶ Start
                    </button>
                    <button
                      v-else
                      type="button"
                      class="menu-item"
                      @click="stopAgent(agent.id)"
                    >
                      ■ Stop
                    </button>
                    <button
                      type="button"
                      class="menu-item"
                      @click="handleEditClick(agent.id)"
                    >
                      ✎ Edit
                    </button>
                    <button
                      type="button"
                      class="menu-item menu-item--danger"
                      @click="handleDelete(agent.id)"
                    >
                      ✕ Delete
                    </button>
                  </div>
                </div>
              </td>
              <td class="col-picker-td"></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>


    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEditModal && editingAgent" class="modal-overlay" @click.self="showEditModal = false">
        <div class="modal">
          <div class="modal-header">
            <span class="modal-title">Edit Agent</span>
            <button class="btn btn-ghost btn-sm" @click="showEditModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div v-if="saveError" class="alert alert-error">{{ saveError }}</div>
            <AgentConfigForm
              :initialValues="{
                name: editingAgent.name,
                llmModel: editingAgent.llmModel,
                pairs: editingAgent.config.pairs,
                paperBalance: editingAgent.config.paperBalance,
                strategies: editingAgent.config.strategies,
                analysisInterval: editingAgent.config.analysisInterval,
                maxPositionSizePct: editingAgent.config.maxPositionSizePct,
                stopLossPct: editingAgent.config.stopLossPct,
                takeProfitPct: editingAgent.config.takeProfitPct,
                maxOpenPositions: editingAgent.config.maxOpenPositions,
                temperature: editingAgent.config.temperature ?? 0.7,
                allowFallback: editingAgent.config.allowFallback ?? false,
              }"
              @submit="handleEditSubmit"
              @cancel="showEditModal = false"
            />
          </div>
          <div v-if="editingAgent.status === 'running'" class="modal-bottom-warning">Agent is running — changes take effect on the next analysis cycle.</div>
        </div>
      </div>
    </Teleport>
  </main>
</template>

<style scoped>
.stats-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stats-section-label {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-dim);
}

.stats-section-label--paper {
  color: #d97706;
  opacity: 0.8;
}

.page-header__actions {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.icon-col {
  width: 52px;
  padding-left: 12px !important;
  padding-right: 8px !important;
  text-align: center;
  vertical-align: middle;
}
.agent-table-row {
  cursor: pointer;
  transition: background 0.12s;
}
.agent-table-row:hover {
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
.paper-tag {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: var(--radius);
  background: color-mix(in srgb, #d97706 12%, transparent);
  color: #d97706;
  border: 1px solid color-mix(in srgb, #d97706 30%, transparent);
}

.managed-tag {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: var(--radius);
  background: var(--accent-dim);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
}
.agent-actions-menu {
  position: relative;
  display: inline-block;
}
.agent-actions-trigger {
  cursor: pointer;
  padding: 2px 8px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-muted);
  font-size: 14px;
  transition: border-color 150ms ease-out, color 150ms ease-out;
}
.agent-actions-trigger:hover {
  border-color: var(--border-light);
  color: var(--text);
}
.agent-actions-trigger::-webkit-details-marker {
  display: none;
}
.agent-actions-dropdown {
  position: absolute;
  right: 0;
  top: 0;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  padding: 6px 0;
  min-width: 140px;
  z-index: 999;
}
.menu-item {
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: none;
  text-align: left;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}
.menu-item:hover {
  background: var(--bg-hover);
}
.menu-item--danger {
  color: var(--danger, #f87171);
}
.stat-pnl-breakdown {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-muted);
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.stat-pnl-breakdown .positive { color: var(--success, #4ade80); }
.stat-pnl-breakdown .negative { color: var(--danger, #f87171); }
.pnl-sep { color: var(--text-dim); }
.col-picker-th {
  position: relative;
  width: 28px;
  min-width: 28px;
  padding: 0 4px;
  text-align: center;
  border-left: 1px solid var(--border, #2a2a2a);
}
.col-picker-td {
  width: 28px;
  min-width: 28px;
  border-left: 1px solid var(--border, #2a2a2a);
}
.col-picker-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin: 0 auto;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-muted, #555);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: border-color 150ms, color 150ms, background 150ms;
}
.col-picker-btn:hover,
.col-picker-btn.active {
  border-color: var(--border-light, #333);
  color: var(--text, #eee);
  background: color-mix(in srgb, var(--border, #2a2a2a) 40%, transparent);
}
.col-picker-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 200;
  background: var(--bg-card, #1a1a1a);
  border: 1px solid var(--border-light, #333);
  border-radius: 8px;
  padding: 10px;
  min-width: 155px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
.col-picker-title {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-muted, #555);
  margin-bottom: 8px;
}
.col-picker-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.col-picker-list label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  white-space: nowrap;
  transition: color 120ms;
}
.col-picker-list label:hover {
  color: var(--text, #eee);
}
input[type='checkbox'] {
  width: auto;
  height: unset;
}
</style>
