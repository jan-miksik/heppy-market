<script setup lang="ts">
definePageMeta({ ssr: false });
import type { Trade } from '~/composables/useTrades';
import { pollUntilFutureAlarm } from '~/utils/statusPolling';
import { getAgentProfile, DEFAULT_AGENT_PROFILE_ID } from '@something-in-loop/shared';
import { parseMarketPrices, splitAgentPromptSections } from '~/lib/agent-prompt';
import { sectionHtml } from '~/utils/markdown';

const route = useRoute();
const id = computed(() => route.params.id as string);
const { getAgent, startAgent, stopAgent, pauseAgent, deleteAgent, clearAgentHistory } = useAgents();
const { modifications, pendingModifications, modDecisionIds, fetchModifications, approve, reject } = useSelfModifications();
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

const closingTrades = ref<Set<string>>(new Set());

async function closeTradeByUser(tradeId: string) {
  if (closingTrades.value.has(tradeId)) return;
  closingTrades.value.add(tradeId);
  try {
    await closeTrade(tradeId);
    // Refresh trades so UI updates (open → closed) and openPositions grouping recalculates.
    trades.value = await fetchAgentTrades(id.value);
  } finally {
    closingTrades.value.delete(tradeId);
  }
}

interface MarketDataEntry {
  pair: string;
  pairAddress?: string;
  dexScreenerUrl?: string;
  priceUsd: number;
  priceChange?: Record<string, number | undefined>;
  volume24h?: number;
  liquidity?: number;
  indicators?: Record<string, unknown>;
}

interface AgentDecision {
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

interface PerformanceSnapshot {
  id: string;
  balance: number;
  totalPnlPct: number;
  winRate: number;
  totalTrades: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
  snapshotAt: string;
}

interface DoStatus {
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

const agent = ref<Awaited<ReturnType<typeof getAgent>> | null>(null);
const trades = ref<Trade[]>([]);
const decisions = ref<AgentDecision[]>([]);
const snapshots = ref<PerformanceSnapshot[]>([]);
const doStatus = ref<DoStatus | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const isAnalyzing = ref(false);
const analyzePhase = ref<'request' | 'polling' | 'refreshing'>('request');
const analyzeElapsed = ref(0);
let analyzeTimer: ReturnType<typeof setInterval> | null = null;

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

const livePrices = ref<Record<string, number>>({});
const livePricesLoading = ref(false);
const livePricesError = ref<string | null>(null);
/** Tracks which pill sections are open per decision id */
const expandedSections = ref<Record<string, Set<string>>>({});

const showMdPreview = ref(false);
const ANALYZE_REQUEST_TIMEOUT_MS = 10 * 60_000;
const ANALYZE_RESULT_WAIT_MS = 25_000;
const ANALYZE_RESULT_WAIT_ON_PENDING_MS = 90_000;
const ANALYZE_RESULT_POLL_MS = 1_500;
const ANALYZE_BACKGROUND_WAIT_MS = 3 * 60_000;
const ANALYZE_BACKGROUND_POLL_MS = 2_000;
let analyzeWatchToken = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function decisionHtml(text: string, md: boolean): string {
  return sectionHtml(text, md);
}

/** Returns a compact inline diff of market prices vs previous cycle, e.g. "WETH +0.6% · USDC -0.1%" */
function marketDiffSummary(dec: AgentDecision, prevDec: AgentDecision | undefined): string {
  if (!prevDec?.llmPromptText || !dec.llmPromptText) return '';
  const curr = parseMarketPrices(splitAgentPromptSections(dec.llmPromptText).marketData);
  const prev = parseMarketPrices(splitAgentPromptSections(prevDec.llmPromptText).marketData);
  const parts: string[] = [];
  for (const [pair, price] of Object.entries(curr)) {
    const p0 = prev[pair];
    if (p0 !== undefined && Math.abs(price - p0) / p0 > 0.0001) {
      const pct = (price - p0) / p0 * 100;
      parts.push(`${pair.split('/')[0]} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`);
    }
  }
  return parts.join(' · ');
}

function toggleSection(decId: string, section: string) {
  const current = expandedSections.value[decId] ?? new Set<string>();
  const next = new Set(current);
  if (next.has(section)) {
    next.delete(section);
  } else {
    next.add(section);
  }
  expandedSections.value = { ...expandedSections.value, [decId]: next };
}
const expandedTrades = ref<Set<string>>(new Set());
const analyzeError = ref<string | null>(null);
const personaMd = ref('');
const personaSaving = ref(false);
const clearingHistory = ref(false);
const autoSignBusy = ref<'enable' | 'disable' | null>(null);
const autoSignError = ref<string | null>(null);
const WALLET_STATE_TIMEOUT_MS = 30_000;
const WALLET_STATE_POLL_MS = 250;

const personaEmoji = computed(() => {
  if (!agent.value) return '';
  const configProfileId = (agent.value.config as { profileId?: string }).profileId;
  const profileId = agent.value.profileId ?? configProfileId ?? DEFAULT_AGENT_PROFILE_ID;
  const profile = getAgentProfile(profileId);
  return profile?.emoji ?? '';
});

const isInitiaAgent = computed(() => agent.value?.chain === 'initia');

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
  if (!linkedOnchainAgentId.value || !activeOnchainAgentId.value) return false;
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
    ? 'Disable auto-sign for executor transactions.'
    : 'Enable auto-sign for executor transactions.';
});

/** True when the analysis failed because the selected model is unavailable (no automatic fallback) */
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

// Countdown timer
const now = ref(Date.now());
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let cancelStatusPoll: (() => void) | null = null;

// Three-dot menu
const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    menuOpen.value = false;
  }
}

function logAnalyzeTrace(stage: string, payload?: Record<string, unknown>) {
  const logPayload = { at: new Date().toISOString(), stage, ...(payload ?? {}) };
  console.log('[analyze-trace]', logPayload);
}

function cancelBackgroundAnalyzeWatch() {
  analyzeWatchToken += 1;
}

onMounted(() => {
  countdownInterval = setInterval(() => { now.value = Date.now(); }, 1000);
  document.addEventListener('click', onDocClick);
});
onUnmounted(() => {
  cancelBackgroundAnalyzeWatch();
  if (countdownInterval) clearInterval(countdownInterval);
  if (cancelStatusPoll) cancelStatusPoll();
  stopAnalyzeTimer();
  document.removeEventListener('click', onDocClick);
});

async function loadAll() {
  loading.value = true;
  loadError.value = null;
  try {
    const [a, t, d, p] = await Promise.all([
      getAgent(id.value),
      fetchAgentTrades(id.value),
      request<{ decisions: AgentDecision[] }>(`/api/agents/${id.value}/decisions`),
      request<{ snapshots: PerformanceSnapshot[] }>(`/api/agents/${id.value}/performance`),
    ]);
    agent.value = a;
    trades.value = t;
    decisions.value = d.decisions;
    snapshots.value = p.snapshots;
    await fetchLivePrices();
    // Load DO status for countdown
    await refreshDoStatus();
    try {
      const personaData = await getAgentPersona(id.value);
      personaMd.value = personaData.personaMd ?? '';
    } catch { /* ignore */ }
    if (a.chain === 'initia') {
      await refreshInitiaState();
    }
    fetchModifications(id.value).catch(() => { /* non-critical */ });
  } catch (err) {
    loadError.value = extractApiError(err);
  } finally {
    loading.value = false;
  }
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
  } catch (err) {
    livePricesError.value = extractApiError(err);
  } finally {
    livePricesLoading.value = false;
  }
}

async function refreshDoStatus() {
  try {
    doStatus.value = await request<DoStatus>(`/api/agents/${id.value}/status`, { fresh: true });
  } catch {
    // non-critical
  }
}

async function refreshAnalysisOutputs() {
  const [t, d, p] = await Promise.all([
    fetchAgentTrades(id.value),
    request<{ decisions: AgentDecision[] }>(`/api/agents/${id.value}/decisions`, { fresh: true }),
    request<{ snapshots: PerformanceSnapshot[] }>(`/api/agents/${id.value}/performance`, { fresh: true }),
  ]);
  trades.value = t;
  decisions.value = d.decisions;
  snapshots.value = p.snapshots;
}

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
        request<{ decisions: AgentDecision[] }>(`/api/agents/${id.value}/decisions`, {
          timeout: 30_000,
          silent: true,
          fresh: true,
        }),
        request<DoStatus>(`/api/agents/${id.value}/status`, {
          timeout: 30_000,
          silent: true,
          fresh: true,
        }),
      ]);
      decisions.value = res.decisions;
      doStatus.value = status;
      const hasAnyNewDecision = res.decisions.some((d) => !previousDecisionIds.has(d.id));
      const latest = res.decisions[0];
      logAnalyzeTrace('poll', {
        stage,
        polls,
        hasAnyNewDecision,
        decisionCount: res.decisions.length,
        latestDecisionId: latest?.id ?? null,
        latestDecisionAt: latest?.createdAt ?? null,
        analysisState: status.analysisState ?? 'idle',
        pendingLlmAgeMs: status.pendingLlmAgeMs ?? null,
      });
      if (hasAnyNewDecision) {
        logAnalyzeTrace('poll_new_decision_detected', {
          stage,
          polls,
          latestDecisionId: latest?.id ?? null,
          latestDecisionAt: latest?.createdAt ?? null,
        });
        return true;
      }
    } catch (err) {
      logAnalyzeTrace('poll_error', {
        stage,
        polls,
        error: extractApiError(err),
      });
      // Keep polling; this is best-effort and should not interrupt analyze flow.
    }
    await sleep(pollMs);
  }
  logAnalyzeTrace('poll_timeout', { stage, polls, timeoutMs });
  return false;
}

async function startBackgroundDecisionWatch(previousDecisionIds: Set<string>) {
  const watchToken = ++analyzeWatchToken;
  logAnalyzeTrace('background_watch_start', {
    watchToken,
    waitMs: ANALYZE_BACKGROUND_WAIT_MS,
    pollMs: ANALYZE_BACKGROUND_POLL_MS,
  });

  const hasNewDecision = await waitForDecisionChange(previousDecisionIds, ANALYZE_BACKGROUND_WAIT_MS, {
    stage: 'background',
    pollMs: ANALYZE_BACKGROUND_POLL_MS,
    shouldStop: () => watchToken !== analyzeWatchToken,
  });

  if (watchToken !== analyzeWatchToken) {
    return;
  }

  if (!hasNewDecision) {
    logAnalyzeTrace('background_watch_end_no_new_decision', { watchToken });
    return;
  }

  try {
    await refreshAnalysisOutputs();
    await Promise.all([refreshDoStatus(), fetchLivePrices()]);
    if (
      analyzeError.value?.includes('No new decision yet') ||
      analyzeError.value?.includes('still running in the background')
    ) {
      analyzeError.value = null;
    }
    const latest = decisions.value[0];
    logAnalyzeTrace('background_watch_applied', {
      watchToken,
      latestDecisionId: latest?.id ?? null,
      latestDecisionAt: latest?.createdAt ?? null,
    });
  } catch (err) {
    logAnalyzeTrace('background_watch_apply_error', {
      watchToken,
      error: extractApiError(err),
    });
  }
}

function extractAnalyzeError(err: unknown): string {
  return (
    (err as { data?: { error?: string }; message?: string })?.data?.error ??
    (err as { message?: string })?.message ??
    'Analysis failed — check that OPENROUTER_API_KEY is configured.'
  );
}

onMounted(loadAll);

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
    const pnl = getUnrealizedPnl(t);
    return pnl ? sum + (pnl.pnlPct / 100) * t.amountUsd : sum;
  }, 0)
);
const totalPnlUsd = computed(() => realizedPnlUsd.value + unrealizedPnlUsd.value);
const totalPnlPct = computed(() => {
  const initial = agent.value?.config.paperBalance ?? 0;
  if (!initial) return 0;
  return (totalPnlUsd.value / initial) * 100;
});
const inPositionsUsd = computed(() =>
  openTrades.value.reduce((sum, t) => sum + (t.amountUsd ?? 0), 0)
);
const displayedBalance = computed(() => {
  const initial = agent.value?.config.paperBalance ?? 0;
  if (!initial) return 0;
  // Available balance excludes open positions and reflects only realized P&L.
  return initial + realizedPnlUsd.value;
});

const totalTokensUsed = computed(
  () => decisions.value.reduce((sum, d) => sum + (d.llmTokensUsed ?? 0), 0),
);

const totalPromptTokens = computed(
  () => decisions.value.reduce((sum, d) => sum + (d.llmPromptTokens ?? 0), 0),
);

const totalCompletionTokens = computed(
  () => decisions.value.reduce((sum, d) => sum + (d.llmCompletionTokens ?? 0), 0),
);

/** Seconds until next agent analysis cycle */
const secondsUntilNextAction = computed(() => {
  if (!doStatus.value?.nextAlarmAt) return null;
  const diff = Math.floor((doStatus.value.nextAlarmAt - now.value) / 1000);
  return diff > 0 ? diff : 0;
});

// When the countdown hits 0 while running, poll the DO every 5s until a future
// alarm is confirmed (the loop has finished and rescheduled).
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
          fetchAgentTrades(id.value),
          request<{ decisions: AgentDecision[] }>(`/api/agents/${id.value}/decisions`, { fresh: true }),
        ]);
        trades.value = t;
        decisions.value = d.decisions;
      },
    );
  }
});

function formatCountdown(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds <= 0) return 'any moment…';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

/** True when countdown shows "any moment…" — used for animation */
const isNextAnalysisImminent = computed(
  () =>
    agent.value?.status === 'running' &&
    secondsUntilNextAction.value !== null &&
    secondsUntilNextAction.value <= 0,
);

/** Group open trades by pair for merged display */
const openTradesByPair = computed(() => {
  const map = new Map<string, Trade[]>();
  for (const t of openTrades.value) {
    const existing = map.get(t.pair) ?? [];
    existing.push(t);
    map.set(t.pair, existing);
  }
  return map;
});

/** Parse marketDataSnapshot string → MarketDataEntry[] */
function parseSnapshot(snapshot?: string): MarketDataEntry[] {
  if (!snapshot) return [];
  try {
    return JSON.parse(snapshot) as MarketDataEntry[];
  } catch {
    return [];
  }
}

/** Find pair address for an open trade from latest decisions */
function getPairAddress(pairName: string): string {
  for (const dec of decisions.value) {
    const snap = parseSnapshot(dec.marketDataSnapshot);
    const entry = snap.find((e) => e.pair === pairName);
    if (entry?.pairAddress) return entry.pairAddress;
  }
  return '';
}

/** Calculate exit bounds (Target & Stop) from agent config */
function getExitBounds(trade: Trade): { target: number; stop: number } {
  const tp = agent.value?.config.takeProfitPct ?? 10;
  const sl = agent.value?.config.stopLossPct ?? 5;
  if (trade.side === 'buy') {
    return {
      target: trade.entryPrice * (1 + tp / 100),
      stop: trade.entryPrice * (1 - sl / 100),
    };
  }
  return {
    target: trade.entryPrice * (1 - tp / 100),
    stop: trade.entryPrice * (1 + sl / 100),
  };
}

/** Estimate unrealized P&L for an open position using latest known price */
function getUnrealizedPnl(trade: Trade): { pnlPct: number; currentPrice: number } | null {
  const live = livePrices.value[trade.pair];
  if (live && live > 0) {
    const slippage = agent.value?.config.slippageSimulation ?? 0.3;
    const effectiveEntry = trade.side === 'buy'
      ? trade.entryPrice * (1 + slippage / 100)
      : trade.entryPrice * (1 - slippage / 100);
    const pnlPct = trade.side === 'buy'
      ? ((live - effectiveEntry) / effectiveEntry) * 100
      : ((effectiveEntry - live) / effectiveEntry) * 100;
    return { pnlPct, currentPrice: live };
  }

  for (const dec of decisions.value) {
    const snap = parseSnapshot(dec.marketDataSnapshot);
    const entry = snap.find((e) => e.pair === trade.pair);
    if (entry && entry.priceUsd > 0) {
      const slippage = agent.value?.config.slippageSimulation ?? 0.3;
      const effectiveEntry = trade.side === 'buy'
        ? trade.entryPrice * (1 + slippage / 100)
        : trade.entryPrice * (1 - slippage / 100);
      const pnlPct = trade.side === 'buy'
        ? ((entry.priceUsd - effectiveEntry) / effectiveEntry) * 100
        : ((effectiveEntry - entry.priceUsd) / effectiveEntry) * 100;
      return { pnlPct, currentPrice: entry.priceUsd };
    }
  }
  return null;
}

async function handleStart() {
  if (!agent.value) return;
  await startAgent(id.value);
  agent.value.status = 'running';
  await refreshDoStatus();
}
async function handleStop() {
  if (!agent.value) return;
  await stopAgent(id.value);
  agent.value.status = 'stopped';
  doStatus.value = null;
}

async function syncInitiaStateToApi(trigger: string) {
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
    walletShowcaseTokenBalanceWei: initiaState.value.walletShowcaseTokenBalanceWei ?? undefined,
    showcaseTokenBalanceWei: initiaState.value.showcaseTokenBalanceWei ?? undefined,
    lastTxHash: initiaState.value.lastTxHash ?? undefined,
    syncTrigger: trigger,
  };

  try {
    await request(`/api/agents/${id.value}/initia/sync`, {
      method: 'POST',
      body: { state: mergedState },
      silent: true,
    });
  } catch (err) {
    console.warn('[agent-detail] failed to sync initia state', err);
  } finally {
    (agent.value as { initiaSyncState?: Record<string, unknown> | null }).initiaSyncState = mergedState;
  }
}

async function ensureInitiaWalletConnected() {
  await refreshInitiaState();
  if (initiaState.value.initiaAddress) return;

  await openConnect();
  const startedAt = Date.now();
  while (Date.now() - startedAt < WALLET_STATE_TIMEOUT_MS) {
    await refreshInitiaState();
    if (initiaState.value.initiaAddress) return;
    await sleep(WALLET_STATE_POLL_MS);
  }

  throw new Error('Wallet connection was not detected. Finish wallet connect and try again.');
}

async function handleToggleAutoSign() {
  if (!isInitiaAgent.value) return;
  autoSignError.value = null;
  const enabling = !autoSignEnabled.value;
  autoSignBusy.value = enabling ? 'enable' : 'disable';

  try {
    await ensureInitiaWalletConnected();
    await refreshInitiaState();

    if (!initiaState.value.chainOk) {
      throw new Error('Local rollup chain is not reachable. Ensure the chain is running at the configured RPC endpoint.');
    }
    if (autoSignMismatch.value) {
      throw new Error(`Connected wallet is focused on onchain agent ${activeOnchainAgentId.value}, but this page is linked to ${linkedOnchainAgentId.value}.`);
    }
    if (!initiaState.value.agentExists) {
      throw new Error('No onchain agent found for the connected wallet.');
    }

    if (enabling) {
      await enableAutoSign();
    } else {
      await disableAutoSign();
    }
    await refreshInitiaState();
    await syncInitiaStateToApi(enabling ? 'detail-enable-autosign' : 'detail-disable-autosign');
  } catch (err) {
    autoSignError.value = extractApiError(err);
  } finally {
    autoSignBusy.value = null;
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
  logAnalyzeTrace('analyze_start', {
    previousDecisionCount: previousDecisionIds.size,
    currentLatestDecisionId: decisions.value[0]?.id ?? null,
    currentLatestDecisionAt: decisions.value[0]?.createdAt ?? null,
  });

  try {
    try {
      await request(`/api/agents/${id.value}/analyze`, {
        method: 'POST',
        timeout: ANALYZE_REQUEST_TIMEOUT_MS,
      });
      logAnalyzeTrace('analyze_request_ok', { elapsedMs: Date.now() - analyzeStartedAt });
    } catch (err: unknown) {
      const msg = extractAnalyzeError(err).toLowerCase();
      const isAlreadyRunning = msg.includes('already in progress');
      const isTimeout = msg.includes('request timed out') || msg.includes('timed out') || msg.includes('aborted');
      if (isAlreadyRunning || isTimeout) {
        pendingRun = true;
        logAnalyzeTrace('analyze_request_pending', {
          reason: isAlreadyRunning ? 'already_in_progress' : 'request_timeout',
          elapsedMs: Date.now() - analyzeStartedAt,
        });
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
    logAnalyzeTrace('analyze_refresh_done', {
      elapsedMs: Date.now() - analyzeStartedAt,
      hasNewDecision,
      latestDecisionId: decisions.value[0]?.id ?? null,
      latestDecisionAt: decisions.value[0]?.createdAt ?? null,
      analysisState: doStatus.value?.analysisState ?? 'idle',
      pendingLlmAgeMs: doStatus.value?.pendingLlmAgeMs ?? null,
    });

    if (!hasNewDecision) {
      analyzeError.value = pendingRun
        ? 'Analysis is still running in the background. No new decision yet — try again in a few seconds.'
        : 'No new decision yet — analysis may still be running. Try again in a few seconds.';
      void startBackgroundDecisionWatch(previousDecisionIds);
    }

    const latest = decisions.value[0];
    if (latest) {
      const level = latest.confidence === 0 ? 'warn' : 'log';
      console[level](`[analyze] decision=${latest.decision} confidence=${latest.confidence} model=${latest.llmModel}\n${latest.reasoning}`);
    }
  } catch (err: unknown) {
    const msg = extractAnalyzeError(err);
    analyzeError.value = msg;
    console.error('[analyze] failed:', msg, err);
    logAnalyzeTrace('analyze_failed', {
      elapsedMs: Date.now() - analyzeStartedAt,
      error: msg,
    });
  } finally {
    stopAnalyzeTimer();
    isAnalyzing.value = false;
    logAnalyzeTrace('analyze_end', {
      elapsedMs: Date.now() - analyzeStartedAt,
      errorShown: analyzeError.value ?? null,
    });
  }
}
async function handleDelete() {
  if (!confirm('Delete this agent?')) return;
  await deleteAgent(id.value);
  router.push('/agents');
}

async function handleClearHistory() {
  if (!agent.value) return;
  if (!confirm('Clear all trades, decisions, and P&L snapshots for this agent? This cannot be undone.')) return;
  clearingHistory.value = true;
  try {
    await clearAgentHistory(id.value);
    trades.value = [];
    decisions.value = [];
    snapshots.value = [];
    // Keep UI in sync with cleared DO state immediately.
    doStatus.value = {
      agentId: id.value,
      status: agent.value.status,
      balance: agent.value.config.paperBalance,
      nextAlarmAt: doStatus.value?.nextAlarmAt ?? null,
    };
    await refreshDoStatus();
  } finally {
    clearingHistory.value = false;
  }
}

async function savePersona(md: string) {
  personaSaving.value = true;
  try {
    await updateAgentPersona(id.value, md);
    personaMd.value = md;
  } finally {
    personaSaving.value = false;
  }
}

async function doResetPersona() {
  personaSaving.value = true;
  try {
    const res = await resetAgentPersona(id.value);
    personaMd.value = res.personaMd;
  } finally {
    personaSaving.value = false;
  }
}



/** Rough token estimate: 1 token ≈ 4 characters */
function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Returns true when the EDITABLE SETUP section of `dec` differs from `prevDec`.
 * `prevDec` is the entry that came *before* this one in the decisions array
 * (i.e. decisions[idx + 1], because the array is newest-first).
 */
function hasEditedSetup(dec: AgentDecision, prevDec: AgentDecision | undefined): boolean {
  if (!prevDec || !dec.llmPromptText || !prevDec.llmPromptText) return false;
  const curr = splitAgentPromptSections(dec.llmPromptText).editableSetup;
  const prev = splitAgentPromptSections(prevDec.llmPromptText).editableSetup;
  return curr.length > 0 && prev.length > 0 && curr !== prev;
}

function toggleTrade(tradeId: string) {
  if (expandedTrades.value.has(tradeId)) {
    expandedTrades.value.delete(tradeId);
  } else {
    expandedTrades.value.add(tradeId);
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
function formatPrice(p: number) {
  return p >= 1 ? p.toLocaleString('en', { maximumFractionDigits: 4 }) : p.toPrecision(5);
}
function decisionColor(d: string) {
  if (d === 'buy') return 'positive';
  if (d === 'sell') return 'negative';
  return 'neutral';
}
function winRateClass(rate: number): 'positive' | 'negative' | 'neutral' {
  if (rate === 0) return 'neutral';
  return rate >= 50 ? 'positive' : 'negative';
}
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

function formatAmountUsd(amountUsd: number): string {
  return amountUsd.toLocaleString('en', { maximumFractionDigits: 2 });
}
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
function formatLatency(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return `${seconds.toFixed(2)}s`;
  return `${seconds.toFixed(1)}s`;
}
</script>

<template>
  <main class="page">
    <div v-if="loading" class="page-loader">
      <div class="page-loader-track">
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
        <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
      </div>
      <span class="page-loader-label">Loading agent</span>
    </div>

    <div v-else-if="loadError" style="text-align: center; padding: 64px;">
      <div class="api-error-banner" style="display: inline-flex; max-width: 500px;">
        <span class="error-icon">!</span>
        <span>{{ loadError }}</span>
        <button class="btn btn-ghost btn-sm" @click="loadAll">Retry</button>
      </div>
    </div>

    <template v-else-if="agent">
      <!-- Header -->
      <div class="page-header">
        <div>
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
            <button class="btn btn-ghost btn-sm" @click="$router.back()">← Back</button>
            <h1 class="page-title">
              <span v-if="personaEmoji" class="agent-emoji" style="margin-right: 6px;">{{ personaEmoji }}</span>
              {{ agent.name }}
            </h1>
            <span class="badge" :class="`badge-${agent.status}`">{{ agent.status }}</span>
          </div>
          <p class="page-subtitle">
            {{ agent.llmModel.split('/')[1] ?? agent.llmModel }} · {{ formatInterval(agent.config.analysisInterval) }} interval · temp {{ (agent.config.temperature ?? 0.7).toFixed(1) }}
            <span v-if="livePricesLoading" class="mono" style="opacity: 0.7;"> · fetching live prices…</span>
            <span v-else-if="livePricesError" class="mono" style="opacity: 0.7;"> · live price unavailable</span>
          </p>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <AgentFundPanel :agent-id="agent.id" :current-balance="agent.config.paperBalance" @done="(bal) => { if (agent) agent.config.paperBalance = bal; }" />
          <button
            class="btn btn-sm"
            :class="isAnalyzing ? 'btn-analyze-active' : 'btn-ghost'"
            :disabled="isAnalyzing"
            @click="handleAnalyze"
            title="Run one analysis cycle immediately — fetches market data, computes indicators, calls LLM for decision"
          >
            <span v-if="isAnalyzing" class="analyze-pulse" />
            <span v-if="isAnalyzing" class="analyze-status-text">{{ analyzeStatusText }}</span>
            <template v-else>⚡ Run Analysis</template>
          </button>
          <button v-if="agent.status !== 'running'" class="btn btn-success btn-sm" @click="handleStart">
            ▶ Start
          </button>
          <div ref="menuRef" style="position: relative;">
            <button class="btn btn-ghost btn-sm" @click.stop="menuOpen = !menuOpen" title="More actions">•••</button>
            <div v-if="menuOpen" class="agent-dot-menu">
              <NuxtLink :to="`/agents/${id}/edit`" class="agent-dot-menu-item" @click="menuOpen = false">✎ Edit</NuxtLink>
              <button v-if="agent.status === 'running'" class="agent-dot-menu-item" @click="handleStop(); menuOpen = false">■ Stop</button>
              <button class="agent-dot-menu-item" :disabled="clearingHistory" @click="handleClearHistory(); menuOpen = false">{{ clearingHistory ? 'Clearing…' : 'Clear history' }}</button>
              <div class="agent-dot-menu-sep" />
              <button class="agent-dot-menu-item agent-dot-menu-item--danger" @click="handleDelete(); menuOpen = false">Delete</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Analysis error banner -->
      <div v-if="analyzeError" class="api-error-banner" style="margin-bottom: 16px; align-items: flex-start;">
        <span class="error-icon" style="margin-top: 1px;">!</span>
        <div style="flex: 1; min-width: 0;">
          <span v-if="isModelUnavailableError">
            This model is currently unavailable. Choose another model in agent settings, or enable "Try fallback model" if you've set one.
          </span>
          <span v-else>{{ analyzeError }}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
          <NuxtLink
            v-if="isModelUnavailableError"
            :to="`/agents/${id}/edit`"
            class="btn btn-ghost btn-sm"
            @click="analyzeError = null"
          >
            Select other model
          </NuxtLink>
          <button class="btn btn-ghost btn-sm" @click="analyzeError = null" aria-label="Dismiss">✕</button>
        </div>
      </div>

      <!-- Stats row -->
      <div class="stats-grid" style="margin-bottom: 8px;">
        <div class="stat-card">
          <div class="stat-label">Balance</div>
          <div class="stat-value">
            ${{ displayedBalance.toLocaleString('en', { maximumFractionDigits: 0 }) }}
          </div>
          <div class="stat-change">
            started at ${{ agent.config.paperBalance.toLocaleString() }}
            · in positions {{ formatUsdNoNegativeZero(inPositionsUsd, 0) }}
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total P&amp;L</div>
          <div class="stat-value" :class="realizedPnlUsd > 0 ? 'positive' : realizedPnlUsd < 0 ? 'negative' : 'neutral'">
            {{ formatUsdNoNegativeZero(realizedPnlUsd, 0) }}
          </div>
          <div class="stat-change">
            {{ (Object.is(totalPnlPct, -0) || Math.abs(totalPnlPct) < 0.005 ? 0 : totalPnlPct).toFixed(1) + '% total' }}
            · <span :class="unrealizedPnlUsd > 0 ? 'positive' : unrealizedPnlUsd < 0 ? 'negative' : 'neutral'">{{ formatUsdNoNegativeZero(unrealizedPnlUsd, 0) }} unrealized</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Win Rate</div>
          <div class="stat-value" :class="winRateClass(winRate)">
            {{ winRate.toFixed(1) }}%
          </div>
          <div class="stat-change">{{ closedTrades.length }} closed trades</div>
        </div>
        <div class="stat-card" :class="{ 'stat-card-active': isAnalyzing }" style="cursor: pointer;" @click="handleAnalyze">
          <div class="stat-label">Next Analysis</div>
          <div
            class="stat-value mono"
            :class="[
              isAnalyzing ? 'accent' : agent.status === 'running' ? 'positive' : 'neutral',
              { 'next-analysis-imminent': !isAnalyzing && isNextAnalysisImminent },
            ]"
          >
            <template v-if="isAnalyzing">
              <span class="analyze-pulse" style="width: 6px; height: 6px;" />
              running now
            </template>
            <template v-else>
              {{ agent.status === 'running' ? formatCountdown(secondsUntilNextAction) : '—' }}
            </template>
          </div>
          <div class="stat-change">{{ openTrades.length }} of {{ agent.config.maxOpenPositions }} positions open</div>
        </div>
      </div>

      <div class="tokens-summary-row">
        <div class="tokens-summary-label">LLM tokens used</div>
        <div class="tokens-summary-values mono">
          <span class="tokens-summary-total">
            {{ totalTokensUsed.toLocaleString('en') }} total
          </span>
          <span class="tokens-summary-split">
            ({{ totalPromptTokens.toLocaleString('en') }} ↑ / {{ totalCompletionTokens.toLocaleString('en') }} ↓)
          </span>
          <span class="tokens-summary-scope">· All analysis cycles</span>
        </div>
      </div>

      <!-- ── Pending Self-Modifications ──────────────────────────── -->
      <div v-if="pendingModifications.length > 0" class="dec-section" style="margin-bottom: 16px;">
        <div class="dec-section-header">
          <span class="dec-section-title">Pending Self-Modifications</span>
          <span class="dec-section-count">{{ pendingModifications.length }}</span>
        </div>
        <div class="self-mod-list">
          <div v-for="mod in pendingModifications" :key="mod.id" class="self-mod-item">
            <div class="self-mod-reason">{{ mod.reason }}</div>
            <pre class="self-mod-changes">{{ JSON.stringify(mod.changes, null, 2) }}</pre>
            <div class="self-mod-actions">
              <button class="btn btn-success btn-sm" @click="approve(id, mod.id)">✓ Apply</button>
              <button class="btn btn-ghost btn-sm" @click="reject(id, mod.id)">✕ Reject</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Analysis Log ───────────────────────────────────────────── -->
      <div class="dec-section">
        <div class="dec-section-header">
          <span class="dec-section-title">Decisions Log</span>
          <span class="dec-section-count">{{ decisions.length }}</span>
          <button
            class="btn btn-ghost btn-sm"
            style="margin-left: auto; font-size: 11px;"
            @click="showMdPreview = !showMdPreview"
          >{{ showMdPreview ? 'MD ●' : 'MD ○' }}</button>
        </div>

        <div v-if="decisions.length === 0" class="dec-empty">
          No decisions yet — click <strong>⚡ Run Analysis</strong> to fetch market data and get the LLM&apos;s reasoning
        </div>

        <div v-else class="chat-feed">
          <!-- ── Ghost: next analysis preview ── -->
          <!-- <div class="dec-entry dec-entry--ghost">
            <div class="dec-main">
              <div class="ghost-awaiting">
                <span v-if="agent.status === 'running'" :class="{ 'ghost-pulse': isNextAnalysisImminent }">
                  {{ isNextAnalysisImminent ? '● analyzing…' : `— next in ${formatCountdown(secondsUntilNextAction)} —` }}
                </span>
                <span v-else style="opacity: 0.5;">— stopped —</span>
              </div>
            </div>
          </div> -->

          <!-- ── Past decisions ── -->
          <div v-for="(dec, idx) in decisions" :key="dec.id" class="dec-entry">
            <!-- Always-visible main content -->
            <div class="dec-main">
              <div class="dec-main-header">
                <span class="dec-action-badge" :class="`dec-action--${dec.decision}`">{{ dec.decision.toUpperCase() }}</span>
                <span class="dec-conf-num">{{ (dec.confidence * 100).toFixed(0) }}%</span>
                <div class="dec-conf-track">
                  <div class="dec-conf-fill" :class="`dec-conf-fill--${dec.decision}`" :style="{ width: (dec.confidence * 100) + '%' }" />
                </div>
              </div>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div class="chat-reasoning" :class="{ 'chat-reasoning--md': showMdPreview }" v-html="decisionHtml(dec.reasoning, showMdPreview)" />
              <div class="dec-meta">
                {{ dec.llmModel.split('/').pop() }} · {{ timeAgo(dec.createdAt) }}
                <span v-if="modDecisionIds.has(dec.id)" class="badge-self-mod">✎ self-modified</span>
              </div>
            </div>

            <!-- Details toggle -->
            <button v-if="dec.llmPromptText || dec.llmRawResponse" class="dec-details-btn" @click="toggleSection(dec.id, 'details')">
              Details {{ expandedSections[dec.id]?.has('details') ? '▾' : '▸' }}
            </button>

            <!-- Details: prompt sections + raw response -->
            <div v-if="expandedSections[dec.id]?.has('details')" class="dec-details">
              <!-- PROMPT group -->
              <template v-if="dec.llmPromptText">
                <div class="dec-details-section-label">
                  PROMPT →
                  <span v-if="hasEditedSetup(dec, decisions[idx + 1])" class="pill-edited-tag">setup edited</span>
                </div>
                <div class="prompt-pills">
                <button class="prompt-pill prompt-pill--system" @click="toggleSection(dec.id, 'system')">
                  <span>[SYSTEM]</span>
                  <span class="pill-chevron">{{ expandedSections[dec.id]?.has('system') ? '▾' : '▸' }}</span>
                </button>
                <div v-if="expandedSections[dec.id]?.has('system')" class="pill-content">
                  <pre v-if="!showMdPreview" class="dec-code-block">
{{ splitAgentPromptSections(dec.llmPromptText).system }}
                  </pre>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-else
                    class="dec-code-block chat-reasoning chat-reasoning--md"
                    v-html="decisionHtml(splitAgentPromptSections(dec.llmPromptText).system, true)"
                  />
                </div>

                <button class="prompt-pill prompt-pill--market" @click="toggleSection(dec.id, 'market')">
                  <span>[MARKET DATA]</span>
                  <span class="pill-chevron">{{ expandedSections[dec.id]?.has('market') ? '▾' : '▸' }}</span>
                </button>
                <div v-if="expandedSections[dec.id]?.has('market')" class="pill-content">
                  <pre v-if="!showMdPreview" class="dec-code-block">
{{ splitAgentPromptSections(dec.llmPromptText).marketData }}
                  </pre>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-else
                    class="dec-code-block chat-reasoning chat-reasoning--md"
                    v-html="decisionHtml(splitAgentPromptSections(dec.llmPromptText).marketData, true)"
                  />
                </div>

                <button class="prompt-pill prompt-pill--setup" @click="toggleSection(dec.id, 'setup')">
                  <span>[EDITABLE SETUP]</span>
                  <span class="pill-chevron">{{ expandedSections[dec.id]?.has('setup') ? '▾' : '▸' }}</span>
                </button>
                <div v-if="expandedSections[dec.id]?.has('setup')" class="pill-content">
                  <pre v-if="!showMdPreview" class="dec-code-block">
{{ splitAgentPromptSections(dec.llmPromptText).editableSetup }}
                  </pre>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-else
                    class="dec-code-block chat-reasoning chat-reasoning--md"
                    v-html="decisionHtml(splitAgentPromptSections(dec.llmPromptText).editableSetup, true)"
                  />
                </div>
              </div>
              </template>

              <!-- LLM RESPONSE group -->
              <template v-if="dec.llmRawResponse">
                <div class="dec-details-section-label dec-details-section-label--llm">
                  ← LLM
                  <span class="dec-details-tokens">{{ (dec.llmPromptTokens ?? 0).toLocaleString() }}↑ {{ (dec.llmCompletionTokens ?? 0).toLocaleString() }}↓</span>
                </div>
                <button class="prompt-pill prompt-pill--llm-response" @click="toggleSection(dec.id, 'response')">
                  <span>[RESPONSE]</span>
                  <span class="pill-chevron">{{ expandedSections[dec.id]?.has('response') ? '▾' : '▸' }}</span>
                </button>
                <div v-if="expandedSections[dec.id]?.has('response')" class="pill-content">
                  <pre v-if="!showMdPreview" class="dec-code-block">
{{ formatJson(dec.llmRawResponse) }}
                  </pre>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-else
                    class="dec-code-block chat-reasoning chat-reasoning--md"
                    v-html="decisionHtml(dec.llmRawResponse, true)"
                  />
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Open Positions section — full width, grouped by pair -->
      <div v-if="openTrades.length > 0" style="margin-bottom: 24px;">
        <div class="dec-section-header" style="margin-bottom: 12px;">
          <span class="dec-section-title">Open Positions</span>
          <span class="dec-section-count">{{ openTrades.length }}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 16px;">
          <div
            v-for="[pair, pairTrades] in openTradesByPair"
            :key="pair"
            class="card"
            style="padding: 0; overflow: hidden; width: 100%;"
          >
            <!-- Pair header with chart -->
            <div style="display: flex; flex-direction: column;">
              <!-- Top bar: pair name + next analysis countdown -->
              <div style="padding: 14px 16px 8px; display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span class="mono" style="font-size: 17px; font-weight: 700;">{{ pair }}</span>
                  <span style="font-size: 12px; color: var(--text-muted);">{{ pairTrades.length }} position{{ pairTrades.length > 1 ? 's' : '' }}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 11px; color: var(--text-muted);">Next analysis:</span>
                  <span
                    class="mono"
                    style="font-size: 12px; font-weight: 600;"
                    :class="[
                      isAnalyzing ? 'accent' : agent.status === 'running' ? 'positive' : 'neutral',
                      { 'next-analysis-imminent': !isAnalyzing && isNextAnalysisImminent },
                    ]"
                  >
                    {{ isAnalyzing ? 'running now' : agent.status === 'running' ? formatCountdown(secondsUntilNextAction) : 'stopped' }}
                  </span>
                </div>
              </div>

              <!-- Price sparkline -->
              <PriceSparkline
                chain="base"
                :pair-address="getPairAddress(pair)"
                :open-timestamps="pairTrades.map((t) => t.openedAt)"
              />

              <!-- DexScreener link -->
              <div v-if="getPairAddress(pair)" style="padding: 0 16px 8px; text-align: right;">
                <a
                  :href="`https://dexscreener.com/base/${getPairAddress(pair)}`"
                  target="_blank"
                  rel="noopener"
                  class="dex-link"
                >
                  Full chart &rarr;
                </a>
              </div>
            </div>

            <!-- Position rows -->
            <div
              v-for="trade in pairTrades"
              :key="trade.id"
              style="border-top: 1px solid var(--border);"
            >
              <!-- Position details row -->
              <div style="padding: 12px 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;">
                <span class="badge" :class="`badge-${trade.side}`">{{ trade.side === 'buy' ? 'LONG' : 'SHORT' }}</span>

                <div style="display: flex; gap: 20px; flex: 1; min-width: 0; flex-wrap: wrap;">
                  <div>
                    <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Entry</div>
                    <div class="mono" style="font-size: 13px;">${{ formatPrice(trade.entryPrice) }}</div>
                  </div>
                  <div>
                    <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Size</div>
                    <div class="mono" style="font-size: 13px;">${{ formatAmountUsd(trade.amountUsd) }}</div>
                  </div>
                  <div>
                    <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Opened</div>
                    <div style="font-size: 13px; color: var(--text-muted);">{{ timeAgo(trade.openedAt) }}</div>
                  </div>
                  <div>
                    <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Strategy</div>
                    <div style="font-size: 13px; color: var(--text-muted);">{{ trade.strategyUsed }}</div>
                  </div>
                  <div>
                    <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Target</div>
                    <div class="mono positive" style="font-size: 13px;">${{ formatPrice(getExitBounds(trade).target) }}</div>
                  </div>
                  <div>
                    <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Stop</div>
                    <div class="mono negative" style="font-size: 13px;">${{ formatPrice(getExitBounds(trade).stop) }}</div>
                  </div>
                  <div>
                    <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">Confidence</div>
                    <div class="mono" style="font-size: 13px;">{{ (trade.confidenceBefore * 100).toFixed(0) }}%</div>
                  </div>
                  <div>
                    <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">P&amp;L</div>
	                    <template v-for="pnl in [getUnrealizedPnl(trade)]" :key="trade.id + '-summary-pnl'">
	                      <div
	                        v-if="pnl"
	                        class="mono"
	                        style="font-size: 13px; font-weight: 600;"
	                        :class="pnl.pnlPct >= 0 ? 'positive' : 'negative'"
	                      >
	                        {{ pnl.pnlPct >= 0 ? '+' : '' }}{{ pnl.pnlPct.toFixed(2) }}%
	                        /
	                        {{ pnl.pnlPct >= 0 ? '+' : '' }}${{ ((pnl.pnlPct / 100) * trade.amountUsd).toFixed(2) }}
	                      </div>
                      <div v-else class="mono" style="font-size: 13px; color: var(--text-muted);">
                        —
                      </div>
                    </template>
                  </div>
                </div>

                <!-- Unrealized P&L -->
                <div style="text-align: right; min-width: 90px;">
	                  <template v-for="pnl in [getUnrealizedPnl(trade)]" :key="trade.id + '-pnl'">
	                    <template v-if="pnl">
	                      <div
	                        class="mono"
	                        style="font-size: 18px; font-weight: 700;"
	                        :class="pnl.pnlPct >= 0 ? 'positive' : 'negative'"
	                      >
	                        {{ pnl.pnlPct >= 0 ? '+' : '' }}{{ pnl.pnlPct.toFixed(2) }}%
	                      </div>
                      <!-- <div style="font-size: 11px; color: var(--text-muted);">
                        now ${{ formatPrice(pnl.currentPrice) }}
                      </div> -->
                    </template>
                    <div v-else style="font-size: 12px; color: var(--text-muted);">P&L: —</div>
                  </template>
                </div>

                <!-- Manual close -->
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="closingTrades.has(trade.id)"
                  @click.stop="closeTradeByUser(trade.id)"
                  style="min-width: 96px;"
                >
                  {{ closingTrades.has(trade.id) ? 'Closing…' : 'Close' }}
                </button>
              </div>

              <!-- Reasoning (collapsed) -->
              <div
                style="padding: 8px 16px 10px; cursor: pointer; font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--border);"
                @click="toggleTrade(trade.id)"
              >
                <span style="margin-right: 6px;">{{ expandedTrades.has(trade.id) ? '▼' : '▶' }}</span>
                <span v-if="!expandedTrades.has(trade.id)" style="overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical;">
                  {{ trade.reasoning }}
                </span>
                <span v-else style="white-space: pre-wrap; display: block; margin-top: 4px; line-height: 1.5;">{{ trade.reasoning }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- PnL Chart temporarily disabled -->
      <div v-if="false && snapshots.length > 1" class="card" style="margin-bottom: 24px;">
        <div class="card-header">P&amp;L History</div>
        <PnLChart :snapshots="snapshots" :initialBalance="agent?.config?.paperBalance ?? 0" />
      </div>

      <!-- Trades -->
      <div class="card">
        <div class="card-header">Trades</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Pair</th>
                <th>Side</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>Amount</th>
                <th>Conf</th>
                <th>P&amp;L</th>
                <th>Strategy</th>
                <th>Status</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="trades.length === 0">
                <td colspan="11" style="text-align: center; padding: 32px; color: var(--text-muted);">
                  No trades yet
                </td>
              </tr>
              <template v-for="trade in trades" :key="trade.id">
                <tr style="cursor: pointer;" @click="toggleTrade(trade.id)">
                  <td style="color: var(--text-muted); font-size: 11px; width: 16px;">
                    {{ expandedTrades.has(trade.id) ? '▼' : '▶' }}
                  </td>
                  <td class="mono">{{ trade.pair }}</td>
                  <td>
                    <span class="badge" :class="`badge-${trade.side}`">{{ trade.side }}</span>
	                  </td>
	                  <td class="mono">${{ formatPrice(trade.entryPrice) }}</td>
	                  <td class="mono" :style="trade.status === 'open' ? { color: 'var(--text-muted)' } : undefined">
	                    {{ trade.exitPrice ? '$' + formatPrice(trade.exitPrice) : '—' }}
	                  </td>
	                  <td class="mono">${{ formatAmountUsd(trade.amountUsd) }}</td>
	                  <td class="mono" :class="trade.confidenceBefore >= 0.7 ? 'positive' : 'neutral'" style="font-size: 12px;">
	                    {{ (trade.confidenceBefore * 100).toFixed(0) }}%
	                  </td>
	                  <td class="mono">
	                    <template v-if="trade.status === 'open'">
	                      <template v-for="pnl in [getUnrealizedPnl(trade)]" :key="trade.id + '-trades-pnl'">
	                        <span v-if="pnl" class="pnl-dimmed" :class="pnl.pnlPct >= 0 ? 'positive' : 'negative'">
	                          {{ formatPnlInline((pnl.pnlPct / 100) * trade.amountUsd, pnl.pnlPct) }}
	                        </span>
	                        <span v-else class="neutral">—</span>
	                      </template>
	                    </template>
	                    <span v-else :class="pnlClass(trade.pnlPct)">{{ formatPnlInline(trade.pnlUsd, trade.pnlPct) }}</span>
	                  </td>
	                  <td style="color: var(--text-muted); font-size: 12px;">{{ trade.strategyUsed }}</td>
	                  <td>
	                    <span class="badge" :class="trade.status === 'open' ? 'badge-running' : 'badge-stopped'">
	                      {{ trade.status === 'closed' ? 'closed' : trade.status }}<span v-if="trade.closeReason" style="font-size: 10px; opacity: 0.7; margin-left: 4px;">({{ trade.closeReason.replace('_', ' ') }})</span>
                    </span>
                  </td>
                  <td style="color: var(--text-muted); font-size: 12px;">{{ formatDate(trade.openedAt) }}</td>
                </tr>
                <tr v-if="expandedTrades.has(trade.id)">
                  <td colspan="11" style="background: var(--bg-card); padding: 12px 16px;">
                    <div style="font-size: 12px; color: var(--text-muted); line-height: 1.6; white-space: pre-wrap;">
                      <strong style="color: var(--text);">Reasoning:</strong> {{ trade.reasoning }}
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>


    </template>

  </main>
</template>

<style scoped>
/* ── Three-dot menu ─────────────────────────────────────────────── */

.agent-dot-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 200;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  min-width: 148px;
  padding: 4px 0;
  display: flex;
  flex-direction: column;
}

.agent-dot-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 7px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  text-decoration: none;
  transition: background var(--t-snap), color var(--t-snap);
}

.agent-dot-menu-item:hover:not(:disabled) {
  background: var(--border);
  color: var(--text);
}

.agent-dot-menu-item:disabled {
  opacity: 0.5;
  cursor: default;
}

.agent-dot-menu-item--danger {
  color: var(--red);
}

.agent-dot-menu-item--danger:hover:not(:disabled) {
  background: var(--red-dim);
  color: var(--red);
}

.agent-dot-menu-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

/* ── Analyze button active state ────────────────────────────────── */

.btn-analyze-active {
  background: var(--surface-2, #1a1a2e);
  border: 1px solid var(--accent, #6366f1);
  color: var(--text, #e2e8f0);
  cursor: wait;
  gap: 6px;
  min-width: 180px;
}

.analyze-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent, #6366f1);
  animation: analyze-blink 1.2s ease-in-out infinite;
  flex-shrink: 0;
}

.analyze-status-text {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  letter-spacing: 0.01em;
}

@keyframes analyze-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* ── Stat card active (during analysis) ─────────────────────────── */

.stat-card-active {
  border-color: var(--accent, #6366f1);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent, #6366f1) 30%, transparent);
}

.accent {
  color: var(--accent, #6366f1);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.btn-autosign-on {
  border-color: color-mix(in srgb, var(--accent) 65%, transparent);
  color: var(--accent);
}

/* ── Analysis Log ───────────────────────────────────────────────── */

.chat-feed {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.dec-entry {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding-left: 12px;
  margin-bottom: 16px;
  background: #1b1c1c;
  min-height: fit-content;
}

.dec-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0;
}

.dec-main-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dec-meta {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
}

.dec-details-btn {
  display: block;
  background: transparent;
  border: none;
  padding: 0;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
  letter-spacing: 0.04em;
  margin-bottom: 2px;
}

.dec-details-btn:hover {
  color: var(--text);
}

.dec-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 0 4px;
  border-top: 1px solid var(--border);
  margin-top: 2px;
}

.dec-details-section-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  margin-top: 8px;
  margin-bottom: 2px;
}

.dec-details-section-label:first-child {
  margin-top: 0;
}

.dec-details-section-label--llm {
  color: #4ade80;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.dec-details-tokens {
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
  text-transform: none;
  letter-spacing: 0;
}

/* ── Prompt pills ── */

.prompt-pills {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.prompt-pill {
  display: flex;
  justify-content: flex-start;
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
  transition: opacity 0.1s;
}

.prompt-pill:hover {
  opacity: 0.75;
}

/* span-only pills in the ghost row have no interactivity */
span.prompt-pill {
  cursor: default;
}
span.prompt-pill:hover {
  opacity: 1;
}

.prompt-pill--system        { color: var(--text-muted); }
.prompt-pill--market        { color: #f59e0b; }
.prompt-pill--setup         { color: #60a5fa; }
.prompt-pill--llm-response  { color: #4ade80; }

.pill-chevron {
  flex-shrink: 0;
  font-size: 12px;
}

.pill-edited-tag {
  font-size: 10px;
  color: #f59e0b;
  border: 1px solid #f59e0b;
  padding: 0 4px;
  margin-left: 4px;
  flex-shrink: 0;
}

.pill-content {
  padding-left: 10px;
}

/* ── Response bubble internals ── */

.chat-decision-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.chat-reasoning {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
}

.chat-reasoning :deep(p)    { margin: 0 0 6px; }
.chat-reasoning :deep(ul)   { margin: 4px 0; padding-left: 16px; }
.chat-reasoning :deep(li)   { margin-bottom: 2px; }
.chat-reasoning :deep(h1),
.chat-reasoning :deep(h2),
.chat-reasoning :deep(h3)   { margin: 6px 0 2px; font-size: 12px; font-weight: 700; }
.chat-reasoning :deep(strong) { font-weight: 700; }
.chat-reasoning :deep(em)     { font-style: italic; }
.chat-reasoning :deep(code)   { font-family: var(--font-mono, monospace); font-size: 11px; }

.market-diff {
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: #f59e0b;
  letter-spacing: 0.02em;
}

/* ── Ghost entry ── */

.dec-entry--ghost {
  opacity: 0.35;
  pointer-events: none;
}

.ghost-awaiting {
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
  padding: 8px 0;
}

@keyframes ghost-blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.3; }
}

.ghost-pulse {
  animation: ghost-blink 1s ease-in-out infinite;
  color: #4ade80;
}

/* ── Self-modifications ─────────────────────────────────────────── */

.badge-self-mod {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 600;
  color: #a78bfa;
  background: color-mix(in srgb, #a78bfa 12%, transparent);
  border: 1px solid color-mix(in srgb, #a78bfa 30%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
  margin-left: 6px;
}

.self-mod-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.self-mod-item {
  background: var(--surface, #141414);
  border: 1px solid color-mix(in srgb, #a78bfa 25%, transparent);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.self-mod-reason {
  font-size: 13px;
  color: var(--text, #e0e0e0);
  line-height: 1.5;
}

.self-mod-changes {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--text-secondary, #aaa);
  background: color-mix(in srgb, var(--border, #2a2a2a) 15%, transparent);
  border-radius: 4px;
  padding: 8px 10px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: 180px;
  overflow-y: auto;
}

.self-mod-actions {
  display: flex;
  gap: 8px;
}

.pnl-dimmed { opacity: 0.65; }

/* ── DexScreener link ──────────────────────────────────────────── */

.dex-link {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--text-muted);
  text-decoration: none;
  letter-spacing: 0.02em;
  transition: color var(--t-snap);
}

.dex-link:hover {
  color: var(--text);
}
</style>
