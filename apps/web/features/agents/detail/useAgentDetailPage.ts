import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getAgentProfile, DEFAULT_AGENT_PROFILE_ID } from '@something-in-loop/shared';
import { pollUntilFutureAlarm } from '~/utils/statusPolling';
import { remainingAnalyzeBannerDelayMs } from '~/utils/formatting';

export interface AgentDecision {
  id: string;
  decision: string;
  confidence: number;
  reasoning: string;
  llmModel: string;
  llmLatencyMs: number;
  llmTokensUsed?: number;
  llmPromptTokens?: number;
  llmCompletionTokens?: number;
  marketDataSnapshot?: string;
  llmPromptText?: string;
  llmRawResponse?: string;
  createdAt: string;
}

export interface PerformanceSnapshot {
  id: string;
  balance: number;
  totalPnlPct: number;
  winRate: number;
  totalTrades: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
  snapshotAt: string;
}

export interface DoStatus {
  agentId: string | null;
  status: string;
  balance: number | null;
  nextAlarmAt: number | null;
  analysisState?: 'idle' | 'running' | 'awaiting_llm';
  isLoopRunning?: boolean;
  loopRunningAt?: number | null;
  pendingLlmJobId?: string | null;
  pendingLlmJobAt?: number | null;
  pendingLlmAgeMs?: number | null;
}

export function useAgentDetailPage(id: string) {
  const { getAgent, startAgent, stopAgent, pauseAgent, deleteAgent, clearAgentHistory } = useAgents();
  const { pendingModifications, modDecisionIds, fetchModifications, approve, reject } = useSelfModifications();
  const { fetchAgentTrades, closeTrade, pnlClass } = useTrades();
  const { request } = useApi();
  const { getAgentPersona, updateAgentPersona, resetAgentPersona } = useProfiles();
  const router = useRouter();
  const {
    state: initiaState,
    openConnect,
    refresh: refreshInitiaState,
    enableAutoSign,
    disableAutoSign,
  } = useInitiaBridge();

  const agent = ref<any>(null); // Type accurately if possible from composable
  const trades = ref<any[]>([]);
  const decisions = ref<AgentDecision[]>([]);
  const snapshots = ref<PerformanceSnapshot[]>([]);
  const doStatus = ref<DoStatus | null>(null);
  const loading = ref(true);
  const loadError = ref<string | null>(null);
  const isAnalyzing = ref(false);
  const analyzePhase = ref<'request' | 'polling' | 'refreshing'>('request');
  const analyzeElapsed = ref(0);
  let analyzeTimer: any = null;

  const livePrices = ref<Record<string, number>>({});
  const livePricesLoading = ref(false);
  const livePricesError = ref<string | null>(null);
  const analyzeError = ref<string | null>(null);
  const personaMd = ref('');
  const personaSaving = ref(false);
  const clearingHistory = ref(false);
  const autoSignBusy = ref<'enable' | 'disable' | null>(null);
  const autoSignError = ref<string | null>(null);
  const now = ref(Date.now());
  const menuOpen = ref(false);

  const ANALYZE_REQUEST_TIMEOUT_MS = 10 * 60_000;
  const ANALYZE_RESULT_WAIT_MS = 25_000;
  const ANALYZE_RESULT_WAIT_ON_PENDING_MS = 90_000;
  const ANALYZE_RESULT_POLL_MS = 1_500;
  const ANALYZE_ERROR_BANNER_DELAY_MS = 3 * 60_000;
  const ANALYZE_BACKGROUND_WAIT_MS = 3 * 60_000;
  const ANALYZE_BACKGROUND_POLL_MS = 2_000;
  const WALLET_STATE_TIMEOUT_MS = 30_000;
  const WALLET_STATE_POLL_MS = 250;
  let analyzeWatchToken = 0;

  // Timers
  let countdownInterval: any = null;
  let cancelStatusPoll: (() => void) | null = null;

  function startAnalyzeTimer() {
    analyzeElapsed.value = 0;
    analyzeTimer = setInterval(() => { analyzeElapsed.value++; }, 1000);
  }
  function stopAnalyzeTimer() {
    if (analyzeTimer) { clearInterval(analyzeTimer); analyzeTimer = null; }
  }

  const analyzeStatusText = computed(() => {
    if (!isAnalyzing.value) return '';
    const s = analyzeElapsed.value;
    const elapsed = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    const phaseText: Record<string, string> = {
      request: s < 5 ? 'Sending request…' : s < 15 ? 'Fetching market data…' : 'LLM reasoning…',
      polling: 'Waiting for decision…',
      refreshing: 'Loading results…',
    };
    return `${phaseText[analyzePhase.value]} (${elapsed})`;
  });


  const isInitiaAgent = computed(() => agent.value?.chain === 'initia');

  // Initia specific logic
  const persistedInitiaState = computed<Record<string, unknown> | null>(() => {
    const raw = (agent.value as { initiaSyncState?: unknown } | null)?.initiaSyncState;
    return raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  });

  const linkedOnchainAgentId = computed(() => {
    const raw = persistedInitiaState.value?.onchainAgentId;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
  });

  const activeOnchainAgentId = computed(() => initiaState.value.onchainAgentId);

  const autoSignMismatch = computed(() => {
    if (!linkedOnchainAgentId.value || !initiaState.value.initiaAddress) return false;
    if (!activeOnchainAgentId.value) return true;
    return linkedOnchainAgentId.value !== activeOnchainAgentId.value;
  });

  const autoSignEnabled = computed(() => {
    if (initiaState.value.initiaAddress) return initiaState.value.autoSignEnabled;
    const persisted = persistedInitiaState.value?.autoSignEnabled;
    return typeof persisted === 'boolean' ? persisted : initiaState.value.autoSignEnabled;
  });

  const autoSignButtonLabel = computed(() => {
    if (autoSignBusy.value === 'enable') return 'Enabling…';
    if (autoSignBusy.value === 'disable') return 'Disabling…';
    return autoSignEnabled.value ? 'Auto-Sign ON' : 'Auto-Sign OFF';
  });

  const autoSignButtonTitle = computed(() => {
    if (autoSignMismatch.value) {
      return `Connected wallet points to onchain agent ${activeOnchainAgentId.value}, but this page is linked to ${linkedOnchainAgentId.value}.`;
    }
    return autoSignEnabled.value
      ? 'Disable auto-sign for all supported on-chain actions.'
      : 'Enable auto-sign for all supported on-chain actions.';
  });

  const isModelUnavailableError = computed(() => {
    const err = analyzeError.value?.toLowerCase() ?? '';
    return (
      err.includes('is unavailable') ||
      err.includes('unavailable for free') ||
      err.includes('free requests') ||
      err.includes('rate limit') ||
      err.includes('402') ||
      err.includes('429') ||
      (err.includes('llm') && err.includes('failed'))
    );
  });

  // Helpers
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function logAnalyzeTrace(stage: string, payload?: Record<string, unknown>) {
    const logPayload = { at: new Date().toISOString(), stage, ...(payload ?? {}) };
    console.log('[analyze-trace]', logPayload);
  }

  function cancelBackgroundAnalyzeWatch() {
    analyzeWatchToken += 1;
  }

  // Data Loading
  async function refreshDoStatus() {
    try {
      doStatus.value = await request<DoStatus>(`/api/agents/${id}/status`, { fresh: true });
    } catch { /* ignore */ }
  }

  async function fetchLivePrices() {
    livePricesLoading.value = true;
    livePricesError.value = null;
    try {
      const cfgPairs = (agent.value?.config?.pairs as string[] | undefined) ?? [];
      const tradePairs = trades.value.map((t) => t.pair);
      const pairs = Array.from(new Set([...cfgPairs, ...tradePairs])).filter(Boolean);
      if (pairs.length === 0) {
        livePrices.value = {};
        return;
      }

      const res = await request<{ prices: Record<string, number> }>(`/api/pairs/prices`, {
        method: 'POST',
        body: { pairs },
        timeout: 30_000,
      });
      livePrices.value = res.prices ?? {};
    } catch (err: any) {
      livePricesError.value = extractApiError(err);
    } finally {
      livePricesLoading.value = false;
    }
  }

  async function refreshAnalysisOutputs() {
    const [t, d, p] = await Promise.all([
      fetchAgentTrades(id),
      request<{ decisions: AgentDecision[] }>(`/api/agents/${id}/decisions`, { fresh: true }),
      request<{ snapshots: PerformanceSnapshot[] }>(`/api/agents/${id}/performance`, { fresh: true }),
    ]);
    trades.value = t;
    decisions.value = d.decisions;
    snapshots.value = p.snapshots;
  }

  async function loadAll() {
    loading.value = true;
    loadError.value = null;
    try {
      const [a, t, d, p] = await Promise.all([
        getAgent(id),
        fetchAgentTrades(id),
        request<{ decisions: AgentDecision[] }>(`/api/agents/${id}/decisions`),
        request<{ snapshots: PerformanceSnapshot[] }>(`/api/agents/${id}/performance`),
      ]);
      agent.value = a;
      trades.value = t;
      decisions.value = d.decisions;
      snapshots.value = p.snapshots;
      await fetchLivePrices();
      await refreshDoStatus();
      try {
        const personaData = await getAgentPersona(id);
        personaMd.value = personaData.personaMd ?? '';
      } catch { /* ignore */ }
      if (a.chain === 'initia') {
        await refreshInitiaState();
      }
      fetchModifications(id).catch(() => { /* non-critical */ });
    } catch (err: any) {
      loadError.value = extractApiError(err);
    } finally {
      loading.value = false;
    }
  }

  // Polling logic
  async function waitForDecisionChange(
    previousDecisionIds: Set<string>,
    timeoutMs: number,
    options?: {
      pollMs?: number;
      stage?: 'foreground' | 'background';
      shouldStop?: () => boolean;
    },
  ): Promise<boolean> {
    const stage = options?.stage ?? 'foreground';
    const pollMs = options?.pollMs ?? ANALYZE_RESULT_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    while (Date.now() < deadline) {
      if (options?.shouldStop?.()) {
        logAnalyzeTrace('poll_canceled', { stage, polls });
        return false;
      }
      polls += 1;
      try {
        const [res, status] = await Promise.all([
          request<{ decisions: AgentDecision[] }>(`/api/agents/${id}/decisions`, {
            timeout: 30_000,
            silent: true,
            fresh: true,
          }),
          request<DoStatus>(`/api/agents/${id}/status`, {
            timeout: 30_000,
            silent: true,
            fresh: true,
          }),
        ]);
        decisions.value = res.decisions;
        doStatus.value = status;
        const hasAnyNewDecision = res.decisions.some((d) => !previousDecisionIds.has(d.id));
        if (hasAnyNewDecision) return true;
      } catch { /* ignore */ }
      await sleep(pollMs);
    }
    return false;
  }

  async function startBackgroundDecisionWatch(previousDecisionIds: Set<string>) {
    const watchToken = ++analyzeWatchToken;
    const hasNewDecision = await waitForDecisionChange(previousDecisionIds, ANALYZE_BACKGROUND_WAIT_MS, {
      stage: 'background',
      pollMs: ANALYZE_BACKGROUND_POLL_MS,
      shouldStop: () => watchToken !== analyzeWatchToken,
    });
    if (watchToken !== analyzeWatchToken) return;
    if (!hasNewDecision) return;
    try {
      await refreshAnalysisOutputs();
      await Promise.all([refreshDoStatus(), fetchLivePrices()]);
      if (analyzeError.value?.includes('No new decision yet') || analyzeError.value?.includes('still running')) {
        analyzeError.value = null;
      }
    } catch { /* ignore */ }
  }

  // Lifecycle
  onMounted(loadAll);
  onMounted(() => {
    countdownInterval = setInterval(() => { now.value = Date.now(); }, 1000);
  });
  onUnmounted(() => {
    cancelBackgroundAnalyzeWatch();
    if (countdownInterval) clearInterval(countdownInterval);
    if (cancelStatusPoll) cancelStatusPoll();
    stopAnalyzeTimer();
  });

  // Watchers
  const secondsUntilNextAction = computed(() => {
    if (!doStatus.value?.nextAlarmAt) return null;
    const diff = Math.floor((doStatus.value.nextAlarmAt - now.value) / 1000);
    return diff > 0 ? diff : 0;
  });

  watch(secondsUntilNextAction, (val) => {
    if (val === 0 && agent.value?.status === 'running') {
      if (cancelStatusPoll) cancelStatusPoll();
      cancelStatusPoll = pollUntilFutureAlarm(
        () => secondsUntilNextAction.value,
        () => agent.value?.status === 'running',
        refreshDoStatus,
        5_000,
        async () => {
          const [t, d] = await Promise.all([
            fetchAgentTrades(id),
            request<{ decisions: AgentDecision[] }>(`/api/agents/${id}/decisions`, { fresh: true }),
          ]);
          trades.value = t;
          decisions.value = d.decisions;
        },
      );
    }
  });

  // Actions
  async function handleStart() {
    if (!agent.value) return;
    await startAgent(id);
    agent.value.status = 'running';
    await refreshDoStatus();
  }
  async function handleStop() {
    if (!agent.value) return;
    await stopAgent(id);
    agent.value.status = 'stopped';
    doStatus.value = null;
  }
  async function handleDeleteAgent() {
    if (!confirm('Delete this agent?')) return;
    await deleteAgent(id);
    router.push('/agents');
  }
  async function handleClearHistory() {
    if (!agent.value) return;
    if (!confirm('Clear all trades, decisions, and P&L snapshots for this agent? This cannot be undone.')) return;
    clearingHistory.value = true;
    try {
      await clearAgentHistory(id);
      trades.value = [];
      decisions.value = [];
      snapshots.value = [];
      doStatus.value = {
        agentId: id,
        status: agent.value.status,
        balance: agent.value.config.paperBalance,
        nextAlarmAt: doStatus.value?.nextAlarmAt ?? null,
      };
      await refreshDoStatus();
    } finally {
      clearingHistory.value = false;
    }
  }

  async function handleAnalyze() {
    if (isAnalyzing.value) return;
    cancelBackgroundAnalyzeWatch();
    isAnalyzing.value = true;
    analyzePhase.value = 'request';
    analyzeError.value = null;
    startAnalyzeTimer();
    const previousDecisionIds = new Set(decisions.value.map((d) => d.id));
    const analyzeStartedAt = Date.now();
    let pendingRun = false;

    try {
      try {
        await request(`/api/agents/${id}/analyze`, {
          method: 'POST',
          timeout: ANALYZE_REQUEST_TIMEOUT_MS,
        });
      } catch (err: any) {
        const msg = (err.data?.error || err.message || '').toLowerCase();
        if (msg.includes('already in progress') || msg.includes('timed out')) {
          pendingRun = true;
        } else {
          throw err;
        }
      }

      analyzePhase.value = 'polling';
      const hasNewDecision = await waitForDecisionChange(
        previousDecisionIds,
        pendingRun ? ANALYZE_RESULT_WAIT_ON_PENDING_MS : ANALYZE_RESULT_WAIT_MS,
      );

      analyzePhase.value = 'refreshing';
      await refreshAnalysisOutputs();
      await Promise.all([refreshDoStatus(), fetchLivePrices()]);

      if (!hasNewDecision) {
        const graceMs = remainingAnalyzeBannerDelayMs(
          analyzeStartedAt,
          Date.now(),
          ANALYZE_ERROR_BANNER_DELAY_MS,
        );

        if (graceMs > 0) {
          analyzePhase.value = 'polling';
          const resolvedDuringGrace = await waitForDecisionChange(previousDecisionIds, graceMs, {
            stage: 'background',
            pollMs: ANALYZE_BACKGROUND_POLL_MS,
          });

          analyzePhase.value = 'refreshing';
          await refreshAnalysisOutputs();
          await Promise.all([refreshDoStatus(), fetchLivePrices()]);

          if (resolvedDuringGrace) return;
        }

        analyzeError.value = pendingRun
          ? 'Analysis is still running in the background. No new decision yet — try again shortly.'
          : 'No new decision yet — analysis may still be running. Try again shortly.';
        void startBackgroundDecisionWatch(previousDecisionIds);
      }
    } catch (err: any) {
      analyzeError.value = err.data?.error || err.message || 'Analysis failed.';
    } finally {
      stopAnalyzeTimer();
      isAnalyzing.value = false;
    }
  }

  async function handleSyncInitia() {
    if (!isInitiaAgent.value || !agent.value || !initiaState.value.initiaAddress) return;
    const mergedState = {
      ...(persistedInitiaState.value ?? {}),
      walletAddress: initiaState.value.initiaAddress,
      evmAddress: initiaState.value.evmAddress ?? undefined,
      onchainAgentId: initiaState.value.onchainAgentId ?? undefined,
      chainOk: initiaState.value.chainOk,
      existsOnchain: initiaState.value.agentExists,
      autoSignEnabled: initiaState.value.autoSignEnabled,
      executorAuthorized: initiaState.value.executorAuthorized,
      walletBalanceWei: initiaState.value.walletBalanceWei ?? undefined,
      vaultBalanceWei: initiaState.value.vaultBalanceWei ?? undefined,
      lastTxHash: initiaState.value.lastTxHash ?? undefined,
    };
    try {
      await request(`/api/agents/${id}/initia/sync`, {
        method: 'POST',
        body: { state: mergedState },
        silent: true,
      });
      agent.value.initiaSyncState = mergedState;
    } catch (err) {
      console.warn('[agent-detail] failed to sync initia state', err);
    }
  }

  async function handleToggleAutoSign() {
    if (!isInitiaAgent.value) return;
    autoSignError.value = null;
    const enabling = !autoSignEnabled.value;
    autoSignBusy.value = enabling ? 'enable' : 'disable';
    try {
      await refreshInitiaState();
      if (!initiaState.value.initiaAddress) {
        await openConnect();
        const start = Date.now();
        while (Date.now() - start < WALLET_STATE_TIMEOUT_MS && !initiaState.value.initiaAddress) {
          await refreshInitiaState();
          await sleep(WALLET_STATE_POLL_MS);
        }
      }
      if (!initiaState.value.initiaAddress) throw new Error('Wallet not connected');
      if (autoSignMismatch.value) throw new Error('Wallet mismatch');
      const targetAgentId = linkedOnchainAgentId.value ?? activeOnchainAgentId.value ?? undefined;
      if (enabling) await enableAutoSign({ configureOnchain: true, agentId: targetAgentId });
      else await disableAutoSign({ configureOnchain: true, agentId: targetAgentId });
      await refreshInitiaState();
      await handleSyncInitia();
    } catch (err: any) {
      autoSignError.value = err.message || 'Auto-sign toggle failed';
    } finally {
      autoSignBusy.value = null;
    }
  }

  async function savePersona(md: string) {
    personaSaving.value = true;
    try {
      await updateAgentPersona(id, md);
      personaMd.value = md;
    } finally {
      personaSaving.value = false;
    }
  }

  async function doResetPersona() {
    personaSaving.value = true;
    try {
      const res = await resetAgentPersona(id);
      personaMd.value = res.personaMd;
    } finally {
      personaSaving.value = false;
    }
  }

  async function closeTradeByUser(tradeId: string) {
    await closeTrade(tradeId);
    trades.value = await fetchAgentTrades(id);
  }

  // Display Computeds
  const openTrades = computed(() => trades.value.filter((t) => t.status === 'open'));
  const closedTrades = computed(() => trades.value.filter((t) => t.status !== 'open'));

  const winRate = computed(() => {
    if (closedTrades.value.length === 0) return 0;
    const wins = closedTrades.value.filter((t) => (t.pnlPct ?? 0) > 0).length;
    return (wins / closedTrades.value.length) * 100;
  });

  const realizedPnlUsd = computed(() =>
    closedTrades.value.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0)
  );

  const unrealizedPnlUsd = computed(() =>
    openTrades.value.reduce((sum, t) => {
      const live = livePrices.value[t.pair];
      if (!live) return sum;
      const slippage = agent.value?.config.slippageSimulation ?? 0.3;
      const effectiveEntry = t.side === 'buy' ? t.entryPrice * (1 + slippage / 100) : t.entryPrice * (1 - slippage / 100);
      const pnlPct = t.side === 'buy' ? ((live - effectiveEntry) / effectiveEntry) * 100 : ((effectiveEntry - live) / effectiveEntry) * 100;
      return sum + (pnlPct / 100) * t.amountUsd;
    }, 0)
  );

  const totalPnlUsd = computed(() => realizedPnlUsd.value + unrealizedPnlUsd.value);
  const totalPnlPct = computed(() => {
    const initial = agent.value?.config.paperBalance ?? 0;
    if (!initial) return 0;
    return (totalPnlUsd.value / initial) * 100;
  });

  const inPositionsUsd = computed(() => openTrades.value.reduce((sum, t) => sum + (t.amountUsd ?? 0), 0));
  const displayedBalance = computed(() => (agent.value?.config.paperBalance ?? 0) + realizedPnlUsd.value);

  const totalTokensUsed = computed(() => decisions.value.reduce((sum, d) => sum + (d.llmTokensUsed ?? 0), 0));
  const totalPromptTokens = computed(() => decisions.value.reduce((sum, d) => sum + (d.llmPromptTokens ?? 0), 0));
  const totalCompletionTokens = computed(() => decisions.value.reduce((sum, d) => sum + (d.llmCompletionTokens ?? 0), 0));

  const isNextAnalysisImminent = computed(() =>
    agent.value?.status === 'running' && secondsUntilNextAction.value !== null && secondsUntilNextAction.value <= 0
  );

  return {
    id,
    agent,
    trades,
    decisions,
    snapshots,
    doStatus,
    loading,
    loadError,
    isAnalyzing,
    analyzeStatusText,
    analyzeError,
    livePrices,
    livePricesLoading,
    livePricesError,
    personaMd,
    personaSaving,
    clearingHistory,
    autoSignBusy,
    autoSignError,
    menuOpen,
    now,
    isInitiaAgent,
    autoSignEnabled,
    autoSignButtonLabel,
    autoSignButtonTitle,
    autoSignMismatch,
    isModelUnavailableError,
    openTrades,
    closedTrades,
    winRate,
    realizedPnlUsd,
    unrealizedPnlUsd,
    totalPnlUsd,
    totalPnlPct,
    inPositionsUsd,
    displayedBalance,
    totalTokensUsed,
    totalPromptTokens,
    totalCompletionTokens,
    secondsUntilNextAction,
    isNextAnalysisImminent,
    pendingModifications,
    modDecisionIds,
    loadAll,
    handleStart,
    handleStop,
    handleAnalyze,
    handleDeleteAgent,
    handleClearHistory,
    handleToggleAutoSign,
    savePersona,
    doResetPersona,
    closeTradeByUser,
    approve,
    reject,
    pnlClass,
  };
}
