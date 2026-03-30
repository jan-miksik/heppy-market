<template>
  <main class="page">
    <div v-if="pending && !manager" class="page-loader">
      <div class="page-loader-track">
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
      </div>
      <span class="page-loader-label">Loading manager</span>
    </div>

    <template v-else-if="manager">
      <!-- Header -->
      <div class="page-header">
        <div>
          <NuxtLink to="/managers" class="back-link">← Managers</NuxtLink>
          <div style="display: flex; align-items: center; gap: 10px; margin-top: 4px;">
            <h1 class="page-title">
              <span v-if="personaEmoji" class="manager-emoji" style="margin-right: 6px;">{{ personaEmoji }}</span>
              {{ manager.name }}
            </h1>
            <span class="badge" :class="statusBadgeClass">{{ manager.status }}</span>
          </div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button v-if="manager.status !== 'running'" class="btn btn-success" :disabled="actionLoading" @click="doAction('start')">Start</button>
          <button v-if="manager.status === 'running'" class="btn btn-ghost" :disabled="actionLoading || !!doStatus?.deciding" @click="triggerDecision">Push decision</button>
          <button v-if="manager.status === 'running'" class="btn btn-ghost" :disabled="actionLoading" @click="doAction('stop')">Stop</button>
          <NuxtLink :to="`/managers/${manager.id}/edit`" class="btn btn-ghost">Edit</NuxtLink>
          <button class="btn btn-danger" :disabled="actionLoading" @click="showDeleteModal = true">Delete</button>
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
      <div class="stats-grid" style="grid-template-columns: repeat(6, 1fr); margin-bottom: 24px;">
        <div class="stat-card">
          <div class="stat-label">Model</div>
          <div class="stat-value" style="font-size: 13px; font-family: inherit;">{{ shortModel }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Interval</div>
          <div class="stat-value" style="font-size: 16px;">{{ doStatus?.decisionInterval ?? manager.config?.decisionInterval ?? '—' }}</div>
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
        <div class="stat-card">
          <div class="stat-label">LLM Tokens Used</div>
          <div class="stat-value" style="font-size: 16px; font-family: 'JetBrains Mono', monospace;">
            {{ totalTokensUsed.toLocaleString('en') }}
          </div>
        </div>
      </div>

      <!-- Two-column layout: Decision Log (left) + Agents (right) -->
      <div class="detail-columns">
        <!-- Decision Log (left) -->
        <div class="detail-col-left">
          <div class="col-header">
            <span>Decision Log</span>
            <button
              class="btn btn-ghost btn-sm"
              style="margin-left: auto; font-size: 11px;"
              @click="showMdPreview = !showMdPreview"
            >{{ showMdPreview ? 'MD ●' : 'MD ○' }}</button>
          </div>
          <div v-if="logs.length === 0" class="empty-state" style="padding: 32px 24px;">
            <div class="empty-title">No decisions logged yet</div>
            <p>Start the manager to begin generating decisions.</p>
          </div>
          <div v-else class="manager-log-feed">
            <div v-for="log in pagedLogs" :key="log.id" class="dec-entry">
              <div class="dec-main">
                <div class="dec-main-header">
                  <span class="badge" :class="actionBadgeClass(log.action)" style="font-size: 11px;">{{ log.action }}</span>
                  <span class="dec-meta">{{ new Date(log.createdAt).toLocaleString() }}</span>
                  <span
                    v-if="log.llmPromptTokens != null || log.llmCompletionTokens != null"
                    class="dec-meta mono"
                    style="margin-left: auto; white-space: nowrap;"
                  >
                    {{ log.llmPromptTokens ?? '—' }}↑ {{ log.llmCompletionTokens ?? '—' }}↓
                  </span>
                </div>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <div class="chat-reasoning" :class="{ 'chat-reasoning--md': showMdPreview }" v-html="sectionHtml(log.reasoning, showMdPreview)" />
                <p v-if="log.result?.detail" class="dec-meta">{{ log.result.detail }}</p>
                <p v-if="log.result?.error" class="dec-meta" style="color: var(--red);">{{ log.result.error }}</p>
              </div>

              <button class="dec-details-btn" @click="toggleSection(log.id, 'details')">
                Details {{ expandedSections[log.id]?.has('details') ? '▾' : '▸' }}
              </button>

              <div v-if="expandedSections[log.id]?.has('details')" class="dec-details">
                <div class="prompt-pills">
                  <button class="prompt-pill prompt-pill--system" @click="toggleSection(log.id, 'system')">
                    <span>[SYSTEM]</span>
                    <span class="pill-chevron">{{ expandedSections[log.id]?.has('system') ? '▾' : '▸' }}</span>
                  </button>
                  <div v-if="expandedSections[log.id]?.has('system')" class="pill-content">
                    <pre v-if="!showMdPreview" class="dec-code-block">{{ managerPrompt(log.result?.llmPromptText).system }}</pre>
                    <!-- eslint-disable-next-line vue/no-v-html -->
                    <div
                      v-else
                      class="dec-code-block chat-reasoning chat-reasoning--md"
                      v-html="sectionHtml(managerPrompt(log.result?.llmPromptText).system, true)"
                    />
                  </div>

                  <button class="prompt-pill prompt-pill--market" @click="toggleSection(log.id, 'context')">
                    <span>[PORTFOLIO CONTEXT]</span>
                    <span class="pill-chevron">{{ expandedSections[log.id]?.has('context') ? '▾' : '▸' }}</span>
                  </button>
                  <div v-if="expandedSections[log.id]?.has('context')" class="pill-content">
                    <pre v-if="!showMdPreview" class="dec-code-block">{{ managerPrompt(log.result?.llmPromptText).context }}</pre>
                    <!-- eslint-disable-next-line vue/no-v-html -->
                    <div
                      v-else
                      class="dec-code-block chat-reasoning chat-reasoning--md"
                      v-html="sectionHtml(managerPrompt(log.result?.llmPromptText).context, true)"
                    />
                  </div>

                  <button class="prompt-pill prompt-pill--setup" @click="toggleSection(log.id, 'setup')">
                    <span>[EDITABLE SETUP]</span>
                    <span class="pill-chevron">{{ expandedSections[log.id]?.has('setup') ? '▾' : '▸' }}</span>
                  </button>
                  <div v-if="expandedSections[log.id]?.has('setup')" class="pill-content">
                    <pre v-if="!showMdPreview" class="dec-code-block">{{ managerPrompt(log.result?.llmPromptText).editableSetup }}</pre>
                    <!-- eslint-disable-next-line vue/no-v-html -->
                    <div
                      v-else
                      class="dec-code-block chat-reasoning chat-reasoning--md"
                      v-html="sectionHtml(managerPrompt(log.result?.llmPromptText).editableSetup, true)"
                    />
                  </div>

                  <button class="prompt-pill prompt-pill--llm" @click="toggleSection(log.id, 'response')">
                    <span>[RESPONSE]</span>
                    <span class="pill-chevron">{{ expandedSections[log.id]?.has('response') ? '▾' : '▸' }}</span>
                  </button>
                  <div v-if="expandedSections[log.id]?.has('response')" class="pill-content">
                    <pre v-if="!showMdPreview" class="dec-code-block">{{ log.result?.llmRawResponse || '(no raw response stored)' }}</pre>
                    <!-- eslint-disable-next-line vue/no-v-html -->
                    <div
                      v-else
                      class="dec-code-block chat-reasoning chat-reasoning--md"
                      v-html="sectionHtml(log.result?.llmRawResponse || '(no raw response stored)', true)"
                    />
                  </div>
                </div>
              </div>
            </div>
            <!-- Pagination -->
            <div v-if="totalLogPages > 1" class="log-pagination">
              <button class="btn btn-ghost btn-sm" :disabled="logPage === 1" @click="logPage--">←</button>
              <span style="font-size: 12px; color: var(--text-muted);">{{ logPage }} / {{ totalLogPages }}</span>
              <button class="btn btn-ghost btn-sm" :disabled="logPage >= totalLogPages" @click="logPage++; maybeLoadMore()">→</button>
            </div>
          </div>
        </div>

        <!-- Agents (right) -->
        <div class="detail-col-right">
          <div class="col-header">Agents <span v-if="managedAgents.length" style="color: var(--text-muted); font-weight: 400;">{{ managedAgents.length }}</span></div>
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
      </div>
    </template>

    <div v-else class="alert alert-error">Manager not found.</div>

    <!-- Delete confirmation modal -->
    <div v-if="showDeleteModal" class="modal-overlay" @click.self="showDeleteModal = false">
      <div class="modal">
        <h2 class="modal-title">Delete manager?</h2>
        <p style="font-size: 14px; color: var(--text-dim); margin-bottom: 16px;">
          <strong style="color: var(--text);">{{ manager?.name }}</strong> will be permanently deleted along with its decision log.
        </p>
        <div v-if="managedAgents.length > 0" class="delete-agents-choice">
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 10px;">
            This manager has <strong style="color: var(--text);">{{ managedAgents.length }} agent{{ managedAgents.length !== 1 ? 's' : '' }}</strong>. What should happen to them?
          </p>
          <label class="radio-row">
            <input v-model="deleteAgentsChoice" type="radio" value="detach" />
            <span>Keep agents — detach them from this manager</span>
          </label>
          <label class="radio-row">
            <input v-model="deleteAgentsChoice" type="radio" value="delete" />
            <span style="color: var(--red);">Delete agents too</span>
          </label>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" @click="showDeleteModal = false">Cancel</button>
          <button class="btn btn-danger" :disabled="actionLoading" @click="doDelete">
            {{ actionLoading ? 'Deleting…' : 'Delete' }}
          </button>
        </div>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getManagerProfile, DEFAULT_MANAGER_PROFILE_ID } from '@something-in-loop/shared';
import { parse as markedParse } from 'marked';
import { splitManagerPromptSections } from '~/lib/manager-prompt';

type ManagerDoStatus = {
  deciding?: boolean;
  lastDecisionMs?: number | null;
  decisionInterval?: string;
  tickCount?: number;
  nextAlarmAt?: number | null;
};

type ManagerDetail = {
  id: string;
  name: string;
  status: 'running' | 'paused' | 'stopped' | string;
  profileId?: string | null;
  config?: {
    llmModel?: string;
    decisionInterval?: string;
    profileId?: string;
    riskParams?: {
      maxTotalDrawdown?: number;
      maxAgents?: number;
    };
  };
  doStatus?: ManagerDoStatus;
};

type ManagedAgent = {
  id: string;
  name: string;
  status: string;
  config?: {
    pairs?: string[];
  };
};

type ManagerLogResult = {
  detail?: string;
  error?: string;
  llmPromptText?: string;
  llmRawResponse?: string;
};

type ManagerLog = {
  id: string;
  action: string;
  reasoning: string;
  createdAt: string;
  result?: ManagerLogResult | null;
  llmPromptTokens?: number | null;
  llmCompletionTokens?: number | null;
};

const route = useRoute();
const router = useRouter();
const id = route.params.id as string;

const actionLoading = ref(false);
const showDeleteModal = ref(false);
const deleteAgentsChoice = ref<'detach' | 'delete'>('detach');

const { data: managerData, pending, refresh } = await useFetch<ManagerDetail>(`/api/managers/${id}`, {
  credentials: 'include',
});
const manager = computed(() => managerData.value ?? null);
const doStatus = computed(() => manager.value?.doStatus ?? null);

const personaEmoji = computed(() => {
  const m = manager.value;
  if (!m) return '';
  const configProfileId = m.config?.profileId;
  const profileId = m.profileId ?? configProfileId ?? DEFAULT_MANAGER_PROFILE_ID;
  const profile = getManagerProfile(profileId);
  return profile?.emoji ?? '';
});

const { data: agentsData, refresh: refreshAgents } = await useFetch<{ agents: ManagedAgent[] }>(`/api/managers/${id}/agents`, {
  credentials: 'include',
});
const managedAgents = computed(() => agentsData.value?.agents ?? []);

const { data: logsData, refresh: refreshLogs } = await useFetch<{ logs: ManagerLog[] }>(`/api/managers/${id}/logs`, {
  credentials: 'include',
});
const logs = ref<ManagerLog[]>(logsData.value?.logs ?? []);
const hasMoreLogs = ref((logsData.value?.logs?.length ?? 0) === 20);

const { data: tokenUsageData } = await useFetch<{ totalTokens: number }>(`/api/managers/${id}/token-usage`, {
  credentials: 'include',
});
const totalTokensUsed = computed(() => tokenUsageData.value?.totalTokens ?? 0);
const showMdPreview = ref(false);
const expandedSections = ref<Record<string, Set<string>>>({});

function toggleSection(logId: string, section: string) {
  const current = expandedSections.value[logId] ?? new Set<string>();
  const next = new Set(current);
  if (next.has(section)) next.delete(section);
  else next.add(section);
  expandedSections.value = { ...expandedSections.value, [logId]: next };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function renderMarkdown(text: string): string {
  try {
    return markedParse(text, { async: false }) as string;
  } catch {
    return escapeHtml(text);
  }
}

function sectionHtml(text: string, md: boolean): string {
  return md ? renderMarkdown(text) : escapeHtml(text);
}

function managerPrompt(promptText: string | undefined | null) {
  return splitManagerPromptSections(promptText);
}

const LOG_PAGE_SIZE = 10;
const logPage = ref(1);
const totalLogPages = computed(() => Math.max(1, Math.ceil(logs.value.length / LOG_PAGE_SIZE)));
const pagedLogs = computed(() => {
  const start = (logPage.value - 1) * LOG_PAGE_SIZE;
  return logs.value.slice(start, start + LOG_PAGE_SIZE);
});

async function maybeLoadMore() {
  // If we're on the last page and there may be more, fetch them
  if (logPage.value >= totalLogPages.value && hasMoreLogs.value) {
    await loadMoreLogs();
  }
}

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
    const fresh = await $fetch<{ logs: ManagerLog[] }>(`/api/managers/${id}/logs`, { credentials: 'include' });
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
  const effectiveInterval =
    (doStatus.value?.decisionInterval as string | undefined) ??
    (manager.value?.config?.decisionInterval as string | undefined) ??
    '1h';
  const intervalMs = INTERVAL_MS[effectiveInterval] ?? 3600_000;
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
    await refresh();
  } catch (err) {
    console.error(err);
  } finally {
    actionLoading.value = false;
  }
}

async function doDelete() {
  actionLoading.value = true;
  try {
    const deleteAgents = managedAgents.value.length > 0 && deleteAgentsChoice.value === 'delete';
    await $fetch(`/api/managers/${id}${deleteAgents ? '?deleteAgents=true' : ''}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    router.push('/managers');
  } catch (err) {
    console.error(err);
    showDeleteModal.value = false;
  } finally {
    actionLoading.value = false;
  }
}

async function doAction(action: 'start' | 'stop') {
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
  const next = await $fetch<{ logs: ManagerLog[] }>(`/api/managers/${id}/logs?page=${page}`, { credentials: 'include' });
  const newLogs = next.logs ?? [];
  logs.value.push(...newLogs);
  hasMoreLogs.value = newLogs.length === 20;
}

// Persona editing is handled in the manager edit screen; inline persona editor removed here.
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

/* Two-column layout */
.detail-columns {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
  gap: 20px;
  align-items: start;
}
.col-header {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.log-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 4px;
}

.manager-log-feed {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dec-entry {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 10px 12px;
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
}
.dec-main { display: flex; flex-direction: column; gap: 8px; }
.dec-main-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dec-meta {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
}
.dec-details-btn {
  background: transparent;
  border: none;
  padding: 0;
  margin-top: 6px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
}
.dec-details-btn:hover { color: var(--text); }
.dec-details {
  margin-top: 8px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.prompt-pills { display: flex; flex-direction: column; gap: 4px; }
.prompt-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  width: 100%;
  color: var(--text-muted);
}
.prompt-pill--market { color: #f59e0b; }
.prompt-pill--setup { color: #60a5fa; }
.prompt-pill--llm { color: #4ade80; }
.pill-chevron { flex-shrink: 0; font-size: 12px; }
.pill-content { padding-left: 10px; }
.dec-code-block {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary, #aaa);
  padding: 8px 10px;
  margin: 0;
  background: color-mix(in srgb, var(--border, #2a2a2a) 10%, transparent);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-reasoning {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
}
.chat-reasoning :deep(p) { margin: 0 0 6px; }
.chat-reasoning :deep(ul) { margin: 4px 0; padding-left: 16px; }

@media (max-width: 1080px) {
  .detail-columns { grid-template-columns: 1fr; }
}

/* Delete modal */
.delete-agents-choice {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 16px;
}
.radio-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-dim);
  cursor: pointer;
  padding: 4px 0;
}
.radio-row input { cursor: pointer; accent-color: var(--accent); }
</style>
