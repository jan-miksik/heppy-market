<script setup lang="ts">
definePageMeta({ ssr: false });
import type { Trade } from '~/composables/useTrades';
import { pollUntilFutureAlarm } from '~/utils/statusPolling';
import { getAgentProfile, DEFAULT_AGENT_PROFILE_ID } from '@dex-agents/shared';

const route = useRoute();
const id = computed(() => route.params.id as string);
const { getAgent, startAgent, stopAgent, pauseAgent, deleteAgent, updateAgent } = useAgents();
const { fetchAgentTrades, closeTrade, formatPnl, pnlClass } = useTrades();
const { request } = useApi();
const { getAgentPersona, updateAgentPersona, resetAgentPersona } = useProfiles();
const router = useRouter();

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
}

const agent = ref<Awaited<ReturnType<typeof getAgent>> | null>(null);
const trades = ref<Trade[]>([]);
const decisions = ref<AgentDecision[]>([]);
const snapshots = ref<PerformanceSnapshot[]>([]);
const doStatus = ref<DoStatus | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const isAnalyzing = ref(false);
const showEditModal = ref(false);
const saving = ref(false);
const saveError = ref<string | null>(null);
const expandedDecisions = ref<Set<string>>(new Set());
const expandedTrades = ref<Set<string>>(new Set());
const decisionDetailTab = ref<Record<string, 'prompt' | 'response' | 'market'>>({});
const analyzeError = ref<string | null>(null);
const personaMd = ref('');
const personaSaving = ref(false);

const personaEmoji = computed(() => {
  if (!agent.value) return '';
  const configProfileId = (agent.value.config as { profileId?: string }).profileId;
  const profileId = agent.value.profileId ?? configProfileId ?? DEFAULT_AGENT_PROFILE_ID;
  const profile = getAgentProfile(profileId);
  return profile?.emoji ?? '';
});

/** True when the analysis failed because the selected model is unavailable (no automatic fallback) */
const isModelUnavailableError = computed(() => {
  const err = analyzeError.value?.toLowerCase() ?? '';
  return (
    err.includes('is unavailable') ||
    err.includes('unavailable for free') ||
    err.includes('free requests') ||
    err.includes('rate limit') ||
    err.includes('timed out') ||
    err.includes('402') ||
    err.includes('429') ||
    (err.includes('llm') && err.includes('failed'))
  );
});

// Countdown timer
const now = ref(Date.now());
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let cancelStatusPoll: (() => void) | null = null;

onMounted(() => {
  countdownInterval = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => {
  if (countdownInterval) clearInterval(countdownInterval);
  if (cancelStatusPoll) cancelStatusPoll();
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
    // Load DO status for countdown
    await refreshDoStatus();
    try {
      const personaData = await getAgentPersona(id.value);
      personaMd.value = personaData.personaMd ?? '';
    } catch { /* ignore */ }
  } catch (err) {
    loadError.value = extractApiError(err);
  } finally {
    loading.value = false;
  }
}

async function refreshDoStatus() {
  try {
    doStatus.value = await request<DoStatus>(`/api/agents/${id.value}/status`);
  } catch {
    // non-critical
  }
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
const latestSnapshot = computed(() => snapshots.value[0] ?? null);

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
          request<{ decisions: AgentDecision[] }>(`/api/agents/${id.value}/decisions`),
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
async function handleAnalyze() {
  isAnalyzing.value = true;
  analyzeError.value = null;
  try {
    await request(`/api/agents/${id.value}/analyze`, { method: 'POST', timeout: 200_000 });
    // Refresh data after a short delay for the loop to write to D1
    await new Promise((r) => setTimeout(r, 2000));
    const [t, d] = await Promise.all([
      fetchAgentTrades(id.value),
      request<{ decisions: AgentDecision[] }>(`/api/agents/${id.value}/decisions`),
    ]);
    trades.value = t;
    decisions.value = d.decisions;
    await refreshDoStatus();
    // Log the latest decision so silent failures are visible in the browser console
    const latest = decisions.value[0];
    if (latest) {
      const level = latest.confidence === 0 ? 'warn' : 'log';
      console[level](`[analyze] decision=${latest.decision} confidence=${latest.confidence} model=${latest.llmModel}\n${latest.reasoning}`);
    }
  } catch (err: unknown) {
    const msg =
      (err as { data?: { error?: string }; message?: string })?.data?.error ??
      (err as { message?: string })?.message ??
      'Analysis failed — check that OPENROUTER_API_KEY is configured.';
    analyzeError.value = msg;
    console.error('[analyze] failed:', msg, err);
  } finally {
    isAnalyzing.value = false;
  }
}
async function handleDelete() {
  if (!confirm('Delete this agent?')) return;
  await deleteAgent(id.value);
  router.push('/agents');
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

const VALID_ANALYSIS_INTERVALS = ['15m', '1h', '4h', '1d'] as const;
const VALID_STRATEGIES = ['ema_crossover', 'rsi_oversold', 'macd_signal', 'bollinger_bounce', 'volume_breakout', 'llm_sentiment', 'combined'] as const;

/** Build a PATCH body that matches UpdateAgentRequestSchema (partial, valid enums and types). */
function normalizeAgentUpdatePayload(p: Partial<Parameters<typeof updateAgent>[1]>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (p.name !== undefined && typeof p.name === 'string' && p.name.trim().length > 0) body.name = p.name.trim();
  if (p.autonomyLevel !== undefined && ['full', 'guided', 'strict'].includes(p.autonomyLevel)) body.autonomyLevel = p.autonomyLevel;
  if (p.llmModel !== undefined && typeof p.llmModel === 'string') body.llmModel = p.llmModel;
  if (p.allowFallback !== undefined && typeof p.allowFallback === 'boolean') body.allowFallback = p.allowFallback;
  if (p.temperature !== undefined && typeof p.temperature === 'number' && p.temperature >= 0 && p.temperature <= 2) body.temperature = p.temperature;
  if (p.pairs !== undefined && Array.isArray(p.pairs) && p.pairs.length >= 1 && p.pairs.length <= 10) {
    const pairs = p.pairs.filter((s): s is string => typeof s === 'string');
    body.pairs = pairs.length >= 1 ? pairs : [agent.value?.config?.pairs?.[0] ?? 'WETH/USDC'];
  }
  if (p.paperBalance !== undefined && typeof p.paperBalance === 'number' && p.paperBalance >= 100 && p.paperBalance <= 1_000_000) body.paperBalance = p.paperBalance;
  if (p.maxPositionSizePct !== undefined && typeof p.maxPositionSizePct === 'number' && p.maxPositionSizePct >= 1 && p.maxPositionSizePct <= 100) body.maxPositionSizePct = p.maxPositionSizePct;
  if (p.stopLossPct !== undefined && typeof p.stopLossPct === 'number' && p.stopLossPct >= 0.5 && p.stopLossPct <= 50) body.stopLossPct = p.stopLossPct;
  if (p.takeProfitPct !== undefined && typeof p.takeProfitPct === 'number' && p.takeProfitPct >= 0.5 && p.takeProfitPct <= 100) body.takeProfitPct = p.takeProfitPct;
  if (p.maxOpenPositions !== undefined && typeof p.maxOpenPositions === 'number' && p.maxOpenPositions >= 1 && p.maxOpenPositions <= 10) body.maxOpenPositions = p.maxOpenPositions;
  if (p.analysisInterval !== undefined && VALID_ANALYSIS_INTERVALS.includes(p.analysisInterval as typeof VALID_ANALYSIS_INTERVALS[number])) body.analysisInterval = p.analysisInterval;
  if (p.strategies !== undefined) {
    const arr = Array.isArray(p.strategies) ? p.strategies : [p.strategies].filter(Boolean);
    const valid = arr.filter((s): s is (typeof VALID_STRATEGIES)[number] => typeof s === 'string' && (VALID_STRATEGIES as readonly string[]).includes(s));
    if (valid.length > 0) body.strategies = valid;
  }
  if (p.profileId !== undefined && (p.profileId === null || typeof p.profileId === 'string')) body.profileId = p.profileId;
  if (p.personaMd !== undefined && typeof p.personaMd === 'string') body.personaMd = p.personaMd;
  return body;
}

async function handleEdit(payload: Parameters<typeof updateAgent>[1]) {
  if (!agent.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    const normalized = normalizeAgentUpdatePayload(payload);
    const updated = await updateAgent(id.value, normalized as Parameters<typeof updateAgent>[1]);
    agent.value = updated;
    if (payload.personaMd !== undefined) personaMd.value = payload.personaMd;
    showEditModal.value = false;
  } catch (e) {
    saveError.value = extractApiError(e);
  } finally {
    saving.value = false;
  }
}

/** Build initialValues for the edit form from the current agent config */
const editInitialValues = computed(() => {
  if (!agent.value) return undefined;
  const profileId = agent.value.profileId ?? (agent.value.config as { profileId?: string })?.profileId;
  return {
    name: agent.value.name,
    autonomyLevel: agent.value.autonomyLevel,
    llmModel: agent.value.llmModel,
    pairs: agent.value.config.pairs,
    paperBalance: agent.value.config.paperBalance,
    strategies: agent.value.config.strategies,
    analysisInterval: agent.value.config.analysisInterval,
    maxPositionSizePct: agent.value.config.maxPositionSizePct,
    stopLossPct: agent.value.config.stopLossPct,
    takeProfitPct: agent.value.config.takeProfitPct,
    maxOpenPositions: agent.value.config.maxOpenPositions,
    temperature: agent.value.config.temperature ?? 0.7,
    allowFallback: agent.value.config.allowFallback ?? false,
    profileId: profileId ?? undefined,
    personaMd: personaMd.value || undefined,
  };
});

function toggleDecision(decId: string) {
  if (expandedDecisions.value.has(decId)) {
    expandedDecisions.value.delete(decId);
    const next = { ...decisionDetailTab.value };
    delete next[decId];
    decisionDetailTab.value = next;
  } else {
    expandedDecisions.value.add(decId);
  }
}

function setDecisionTab(decId: string, tab: 'prompt' | 'response' | 'market') {
  if (decisionDetailTab.value[decId] === tab) {
    const next = { ...decisionDetailTab.value };
    delete next[decId];
    decisionDetailTab.value = next;
  } else {
    decisionDetailTab.value = { ...decisionDetailTab.value, [decId]: tab };
  }
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
    <div v-if="loading" style="text-align: center; padding: 64px;">
      <span class="spinner" style="width: 32px; height: 32px;" />
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
            {{ agent.autonomyLevel }} · {{ agent.llmModel.split('/')[1] ?? agent.llmModel }} · {{ formatInterval(agent.config.analysisInterval) }} interval · temp {{ (agent.config.temperature ?? 0.7).toFixed(1) }}
          </p>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button
            class="btn btn-ghost btn-sm"
            :disabled="isAnalyzing"
            @click="handleAnalyze"
            title="Run one analysis cycle immediately — fetches market data, computes indicators, calls LLM for decision"
          >
            <span v-if="isAnalyzing" class="spinner" style="width: 14px; height: 14px; margin-right: 4px;" />
            {{ isAnalyzing ? 'Fetching data & reasoning…' : '⚡ Run Analysis' }}
          </button>
          <button class="btn btn-ghost btn-sm" @click="showEditModal = true">✎ Edit</button>
          <button v-if="agent.status !== 'running'" class="btn btn-success" @click="handleStart">
            ▶ Start
          </button>
          <button v-else class="btn btn-ghost" @click="handleStop">■ Stop</button>
          <button class="btn btn-danger btn-sm" @click="handleDelete">Delete</button>
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
          <button
            v-if="isModelUnavailableError"
            type="button"
            class="btn btn-ghost btn-sm"
            @click="showEditModal = true; analyzeError = null"
          >
            Select other model
          </button>
          <button class="btn btn-ghost btn-sm" @click="analyzeError = null" aria-label="Dismiss">✕</button>
        </div>
      </div>

      <!-- Stats row -->
      <div class="stats-grid" style="margin-bottom: 8px;">
        <div class="stat-card">
          <div class="stat-label">Balance</div>
          <div class="stat-value">${{ (latestSnapshot?.balance ?? agent.config.paperBalance).toLocaleString('en', { maximumFractionDigits: 0 }) }}</div>
          <div class="stat-change">started at ${{ agent.config.paperBalance.toLocaleString() }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total P&amp;L</div>
          <div class="stat-value" :class="totalPnlUsd >= 0 ? 'positive' : 'negative'">
            {{ totalPnlUsd >= 0 ? '+' : '' }}${{ totalPnlUsd.toFixed(0) }}
          </div>
          <div class="stat-change">
            {{ (totalPnlPct >= 0 ? '+' : '') + totalPnlPct.toFixed(2) + '%' }}
            <template v-if="openTrades.length > 0">
              · <span :class="realizedPnlUsd >= 0 ? 'positive' : 'negative'">{{ realizedPnlUsd >= 0 ? '+' : '' }}${{ realizedPnlUsd.toFixed(0) }} realized</span>
            </template>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Win Rate</div>
          <div class="stat-value" :class="winRate >= 50 ? 'positive' : 'negative'">
            {{ winRate.toFixed(1) }}%
          </div>
          <div class="stat-change">{{ closedTrades.length }} closed trades</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Next Analysis</div>
          <div
            class="stat-value mono"
            :class="[
              agent.status === 'running' ? 'positive' : 'neutral',
              { 'next-analysis-imminent': isNextAnalysisImminent },
            ]"
          >
            {{ agent.status === 'running' ? formatCountdown(secondsUntilNextAction) : '—' }}
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
            ({{ totalPromptTokens.toLocaleString('en') }} in / {{ totalCompletionTokens.toLocaleString('en') }} out)
          </span>
          <span class="tokens-summary-scope">· All analysis cycles</span>
        </div>
      </div>

      <!-- ── Decisions Log ───────────────────────────────────────────── -->
      <div class="dec-section">
        <div class="dec-section-header">
          <span class="dec-section-title">Decision Log</span>
          <span class="dec-section-count">{{ decisions.length }}</span>
        </div>

        <div v-if="decisions.length === 0" class="dec-empty">
          No decisions yet — click <strong>⚡ Run Analysis</strong> to fetch market data and get the LLM's reasoning
        </div>

        <div v-else class="dec-feed">
          <div
            v-for="dec in decisions"
            :key="dec.id"
            class="dec-card"
            :class="`dec-card--${dec.decision}`"
          >
            <!-- ── Meta row ── -->
            <div class="dec-meta" @click="toggleDecision(dec.id)" style="cursor: pointer;">
              <span class="dec-action-badge" :class="`dec-action--${dec.decision}`">{{ dec.decision.toUpperCase() }}</span>

              <div class="dec-conf">
                <span class="dec-conf-label">Confidence</span>
                <span class="dec-conf-num">{{ (dec.confidence * 100).toFixed(0) }}%</span>
                <div class="dec-conf-track">
                  <div class="dec-conf-fill" :class="`dec-conf-fill--${dec.decision}`" :style="{ width: (dec.confidence * 100) + '%' }" />
                </div>
              </div>

              <div class="dec-meta-right">
                <span class="dec-time">{{ timeAgo(dec.createdAt) }}</span>
                <span class="dec-meta-dot">·</span>
                <span class="dec-model" :title="dec.llmModel">{{ dec.llmModel.split('/').pop() }}</span>
                <span class="dec-meta-dot">·</span>
                <span class="dec-latency">{{ formatLatency(dec.llmLatencyMs) }}</span>
                <template v-if="dec.llmPromptTokens != null || dec.llmCompletionTokens != null">
                  <span class="dec-meta-dot">·</span>
                  <span class="dec-tokens">{{ (dec.llmPromptTokens ?? 0).toLocaleString() }}↑ {{ (dec.llmCompletionTokens ?? 0).toLocaleString() }}↓</span>
                </template>
                <span class="dec-chevron" :class="{ 'dec-chevron--open': expandedDecisions.has(dec.id) }">›</span>
              </div>
            </div>

            <!-- ── Reasoning — the hero ── -->
            <div
              class="dec-reasoning"
              :class="{ 'dec-reasoning--clamped': !expandedDecisions.has(dec.id) }"
              @click="toggleDecision(dec.id)"
              style="cursor: pointer;"
            >{{ dec.reasoning }}</div>

            <!-- ── Detail tabs (only when expanded) ── -->
            <template v-if="expandedDecisions.has(dec.id)">
              <div class="dec-detail-tabs">
                <button
                  v-if="parseSnapshot(dec.marketDataSnapshot).length > 0"
                  class="dec-detail-tab"
                  :class="{ 'dec-detail-tab--active': decisionDetailTab[dec.id] === 'market' }"
                  @click="setDecisionTab(dec.id, 'market')"
                >Market Data</button>
                <button
                  v-if="dec.llmPromptText"
                  class="dec-detail-tab"
                  :class="{ 'dec-detail-tab--active': decisionDetailTab[dec.id] === 'prompt' }"
                  @click="setDecisionTab(dec.id, 'prompt')"
                >Prompt</button>
                <button
                  v-if="dec.llmRawResponse"
                  class="dec-detail-tab"
                  :class="{ 'dec-detail-tab--active': decisionDetailTab[dec.id] === 'response' }"
                  @click="setDecisionTab(dec.id, 'response')"
                >Response</button>
              </div>

              <!-- Market data panel -->
              <div v-if="decisionDetailTab[dec.id] === 'market'" class="dec-detail-panel">
                <div class="dec-market-grid">
                  <div
                    v-for="entry in parseSnapshot(dec.marketDataSnapshot)"
                    :key="entry.pair"
                    class="dec-market-card"
                  >
                    <div class="dec-market-pair">{{ entry.pair }}</div>
                    <div class="dec-market-price">${{ formatPrice(entry.priceUsd) }}</div>
                    <div v-if="entry.priceChange" class="dec-market-changes">
                      <span v-if="entry.priceChange.h1 !== undefined" :class="(entry.priceChange.h1 ?? 0) >= 0 ? 'positive' : 'negative'">1h {{ (entry.priceChange.h1 ?? 0).toFixed(2) }}%</span>
                      <span v-if="entry.priceChange.h24 !== undefined" :class="(entry.priceChange.h24 ?? 0) >= 0 ? 'positive' : 'negative'">24h {{ (entry.priceChange.h24 ?? 0).toFixed(2) }}%</span>
                    </div>
                    <div v-if="entry.indicators" class="dec-market-indicators">
                      <span v-if="entry.indicators.rsi">RSI <strong>{{ entry.indicators.rsi }}</strong></span>
                      <span v-if="entry.indicators.emaTrend" :class="entry.indicators.emaTrend === 'bullish' ? 'positive' : 'negative'">EMA {{ entry.indicators.emaTrend }}</span>
                      <span v-if="entry.indicators.macdHistogram">MACD <strong>{{ entry.indicators.macdHistogram }}</strong></span>
                    </div>
                    <a v-if="entry.dexScreenerUrl" :href="entry.dexScreenerUrl" target="_blank" rel="noopener" class="dec-market-link">DexScreener ↗</a>
                  </div>
                </div>
              </div>

              <!-- Prompt panel -->
              <div v-if="decisionDetailTab[dec.id] === 'prompt'" class="dec-detail-panel">
                <pre class="dec-code-block">{{ dec.llmPromptText }}</pre>
              </div>

              <!-- Response panel -->
              <div v-if="decisionDetailTab[dec.id] === 'response'" class="dec-detail-panel">
                <pre class="dec-code-block">{{ dec.llmRawResponse }}</pre>
              </div>
            </template>
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
                      agent.status === 'running' ? 'positive' : 'neutral',
                      { 'next-analysis-imminent': isNextAnalysisImminent },
                    ]"
                  >
                    {{ agent.status === 'running' ? formatCountdown(secondsUntilNextAction) : 'stopped' }}
                  </span>
                </div>
              </div>

              <!-- DexScreener chart — full width -->
              <DexChart chain="base" :pair-address="getPairAddress(pair)" :height="350" />
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
                    <div class="mono" style="font-size: 13px;">${{ trade.amountUsd.toLocaleString() }}</div>
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

      <!-- PnL Chart (if snapshots available) -->
      <div v-if="snapshots.length > 1" class="card" style="margin-bottom: 24px;">
        <div class="card-header">P&amp;L History</div>
        <PnLChart :snapshots="snapshots" :initialBalance="agent.config.paperBalance" />
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
                  <td class="mono">{{ trade.exitPrice ? '$' + formatPrice(trade.exitPrice) : '—' }}</td>
                  <td class="mono">${{ trade.amountUsd.toLocaleString() }}</td>
                  <td class="mono" :class="trade.confidenceBefore >= 0.7 ? 'positive' : 'neutral'" style="font-size: 12px;">
                    {{ (trade.confidenceBefore * 100).toFixed(0) }}%
                  </td>
                  <td class="mono" :class="pnlClass(trade.pnlPct)">{{ formatPnl(trade.pnlPct) }}</td>
                  <td style="color: var(--text-muted); font-size: 12px;">{{ trade.strategyUsed }}</td>
                  <td>
                    <span class="badge" :class="trade.status === 'open' ? 'badge-running' : trade.status === 'stopped_out' ? 'badge-paused' : 'badge-stopped'">
                      {{ trade.status }}
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

    <!-- Edit Modal -->
    <Teleport to="body">
      <div v-if="showEditModal" class="modal-overlay" @click.self="showEditModal = false">
        <div class="modal modal--wide">
          <div class="modal-header">
            <span class="modal-title">Edit Agent</span>
            <button class="btn btn-ghost btn-sm" @click="showEditModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div v-if="saveError" class="alert alert-error">{{ saveError }}</div>
            <AgentConfigForm
              v-if="editInitialValues"
              :initialValues="editInitialValues"
              @submit="handleEdit"
              @cancel="showEditModal = false"
            />
          </div>
          <div v-if="agent?.status === 'running'" class="modal-bottom-warning">Agent is running — changes take effect on the next analysis cycle.</div>
        </div>
      </div>
    </Teleport>
  </main>
</template>
