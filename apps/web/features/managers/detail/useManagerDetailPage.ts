import { ref, computed, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { DEFAULT_MANAGER_PROFILE_ID, getManagerProfile, intervalToMs } from '@something-in-loop/shared';
import { splitManagerPromptSections } from '~/lib/manager-prompt';
import { sectionHtml } from '~/utils/markdown';

type ManagerLogResult = {
  detail?: string;
  error?: string;
  llmPromptText?: string;
  llmRawResponse?: string;
};

export type ManagerLog = import('~/composables/useManagers').ManagerLogEntry & {
  result?: ManagerLogResult | null;
};
export type ManagerDetail = import('~/composables/useManagers').ManagerDetail;
export type ManagedAgent = import('~/composables/useManagers').ManagedAgentSummary;

export function useManagerDetailPage(id: string) {
  const router = useRouter();
  const {
    deleteManager,
    getManager,
    getManagerAgents,
    getManagerLogs,
    getManagerTokenUsage,
    startManager,
    stopManager,
    triggerManager,
  } = useManagers();

  const actionLoading = ref(false);
  const showDeleteModal = ref(false);
  const deleteAgentsChoice = ref<'detach' | 'delete'>('detach');

  const pending = ref(true);
  const manager = ref<ManagerDetail | null>(null);
  const doStatus = computed(() => manager.value?.doStatus ?? null);

  async function refreshManager() {
    manager.value = await getManager(id, { force: true });
  }

  const personaEmoji = computed(() => {
    const m = manager.value;
    if (!m) return '';
    const configProfileId = m.config?.profileId;
    const profileId = m.profileId ?? configProfileId ?? DEFAULT_MANAGER_PROFILE_ID;
    const profile = getManagerProfile(profileId);
    return profile?.emoji ?? '';
  });

  const managedAgents = ref<ManagedAgent[]>([]);
  async function refreshAgents() {
    managedAgents.value = await getManagerAgents(id, { force: true });
  }

  const logs = ref<ManagerLog[]>([]);
  const hasMoreLogs = ref(false);
  async function refreshLogsPage(page = 1, limit = 20) {
    const next = await getManagerLogs(id, { page, limit, force: true });
    if (page === 1) {
      logs.value = (next.logs ?? []) as ManagerLog[];
    } else {
      logs.value.push(...((next.logs ?? []) as ManagerLog[]));
    }
    hasMoreLogs.value = (next.logs?.length ?? 0) === limit;
  }

  const totalTokensUsed = ref(0);
  async function refreshTokenUsage() {
    totalTokensUsed.value = await getManagerTokenUsage(id, { force: true });
  }

  const showMdPreview = ref(false);
  const expandedSections = ref<Record<string, Set<string>>>({});

  function toggleSection(logId: string, section: string) {
    const current = expandedSections.value[logId] ?? new Set<string>();
    const next = new Set(current);
    if (next.has(section)) next.delete(section);
    else next.add(section);
    expandedSections.value = { ...expandedSections.value, [logId]: next };
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
    if (logPage.value >= totalLogPages.value && hasMoreLogs.value) {
      await loadMoreLogs();
    }
  }

  async function loadMoreLogs() {
    const page = Math.ceil(logs.value.length / 20) + 1;
    await refreshLogsPage(page, 20);
  }

  // Polling logic
  let prevDeciding = doStatus.value?.deciding ?? false;
  let prevLastDecisionAt = doStatus.value?.lastDecisionAt ?? null;

  const pollTimer = setInterval(async () => {
    if (manager.value?.status !== 'running') return;
    await refreshManager();
    const nowDeciding = doStatus.value?.deciding ?? false;
    const nowLastDecisionAt = doStatus.value?.lastDecisionAt ?? null;
    const cycleCompleted = (prevDeciding && !nowDeciding) || (
      nowLastDecisionAt !== null
      && nowLastDecisionAt !== prevLastDecisionAt
    );
    if (cycleCompleted) {
      await Promise.all([refreshLogsPage(1, 20), refreshAgents(), refreshTokenUsage()]);
    }
    prevDeciding = nowDeciding;
    prevLastDecisionAt = nowLastDecisionAt;
  }, 2000);

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
    const intervalMs = intervalToMs(effectiveInterval, '1h');
    const remaining = Math.max(0, nextAt - Date.now());
    const elapsed = intervalMs - remaining;
    progressPct.value = Math.min(100, Math.max(0, (elapsed / intervalMs) * 100));
  }

  const clockTimer = setInterval(updateCountdown, 1000);

  onUnmounted(() => {
    clearInterval(pollTimer);
    clearInterval(clockTimer);
  });

  // Actions
  async function triggerDecision() {
    actionLoading.value = true;
    try {
      await triggerManager(id);
      await refreshManager();
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
      await deleteManager(id, { deleteAgents });
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
      if (action === 'start') {
        await startManager(id);
      } else {
        await stopManager(id);
      }
      await refreshManager();
      if (action === 'start') await refreshAgents();
    } catch (err) {
      console.error(err);
    } finally {
      actionLoading.value = false;
    }
  }

  // Initial load
  const init = async () => {
    await Promise.all([
      refreshManager(),
      refreshAgents(),
      refreshLogsPage(1, 20),
      refreshTokenUsage(),
    ]);
    pending.value = false;
  };

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

  return {
    pending,
    manager,
    doStatus,
    managedAgents,
    logs,
    totalTokensUsed,
    actionLoading,
    showDeleteModal,
    deleteAgentsChoice,
    nextDecisionLabel,
    progressPct,
    showMdPreview,
    expandedSections,
    logPage,
    totalLogPages,
    pagedLogs,
    personaEmoji,
    statusBadgeClass,
    shortModel,
    maxDrawdownLabel,
    init,
    refreshManager,
    refreshAgents,
    refreshLogsPage,
    refreshTokenUsage,
    triggerDecision,
    doDelete,
    doAction,
    toggleSection,
    maybeLoadMore,
    managerPrompt,
    agentBadgeClass,
    actionBadgeClass,
    sectionHtml,
  };
}
