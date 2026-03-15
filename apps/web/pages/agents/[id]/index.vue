<script setup lang="ts">
definePageMeta({ ssr: false });
import { parse as markedParse } from 'marked';
import type { Trade } from '~/composables/useTrades';
import { pollUntilFutureAlarm } from '~/utils/statusPolling';
import { getAgentProfile, DEFAULT_AGENT_PROFILE_ID } from '@dex-agents/shared';

const route = useRoute();
const id = computed(() => route.params.id as string);
const { getAgent, startAgent, stopAgent, pauseAgent, deleteAgent } = useAgents();
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
/** Tracks which pill sections are open per decision id */
const expandedSections = ref<Record<string, Set<string>>>({});

const showMdPreview = ref(false);

function formatJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
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
    return markedParse(text, { async: false });
  } catch {
    return escapeHtml(text);
  }
}

function decisionHtml(text: string, md: boolean): string {
  return md ? renderMarkdown(text) : escapeHtml(text);
}

/** Extract pair → price map from a MARKET DATA section */
function parseMarketPrices(marketData: string): Record<string, number> {
  const prices: Record<string, number> = {};
  let currentPair = '';
  for (const line of marketData.split('\n')) {
    const pairMatch = line.match(/^### (.+)$/);
    if (pairMatch) currentPair = pairMatch[1]?.trim() ?? '';
    const priceMatch = line.match(/^Price: \$([0-9.]+)/);
    if (priceMatch && currentPair) prices[currentPair] = parseFloat(priceMatch[1] ?? '0');
  }
  return prices;
}

/** Returns a compact inline diff of market prices vs previous cycle, e.g. "WETH +0.6% · USDC -0.1%" */
function marketDiffSummary(dec: AgentDecision, prevDec: AgentDecision | undefined): string {
  if (!prevDec?.llmPromptText || !dec.llmPromptText) return '';
  const curr = parseMarketPrices(parsePromptSections(dec.llmPromptText).marketData);
  const prev = parseMarketPrices(parsePromptSections(prevDec.llmPromptText).marketData);
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

/** Split a stored llmPromptText into the three logical sections */
function parsePromptSections(promptText: string | undefined): {
  system: string;
  marketData: string;
  editableSetup: string;
} {
  if (!promptText) return { system: '', marketData: '', editableSetup: '' };

  const portfolioIdx = promptText.indexOf('## Portfolio State');
  const behaviorIdx  = promptText.indexOf('## Your Behavior Profile');
  const personaIdx   = promptText.indexOf('## Your Persona');

  // SYSTEM: everything before ## Portfolio State
  const system = portfolioIdx >= 0 ? promptText.slice(0, portfolioIdx).trim() : promptText.trim();

  // EDITABLE SETUP: ## Your Behavior Profile and/or ## Your Persona onwards
  const editableStart = behaviorIdx >= 0 ? behaviorIdx : (personaIdx >= 0 ? personaIdx : -1);
  const editableSetup = editableStart >= 0 ? promptText.slice(editableStart).trim() : '';

  // MARKET DATA: between system and editableSetup
  const marketEnd = editableStart >= 0 ? editableStart : promptText.length;
  const marketData = portfolioIdx >= 0 ? promptText.slice(portfolioIdx, marketEnd).trim() : '';

  return { system, marketData, editableSetup };
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
  const curr = parsePromptSections(dec.llmPromptText).editableSetup;
  const prev = parsePromptSections(prevDec.llmPromptText).editableSetup;
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
          <NuxtLink :to="`/agents/${id}/edit`" class="btn btn-ghost btn-sm">✎ Edit</NuxtLink>
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
              </div>
            </div>

            <!-- Details toggle -->
            <button class="dec-details-btn" @click="toggleSection(dec.id, 'details')">
              Details {{ expandedSections[dec.id]?.has('details') ? '▾' : '▸' }}
            </button>

            <!-- Details: prompt sections + raw response -->
            <div v-if="expandedSections[dec.id]?.has('details')" class="dec-details">
              <!-- PROMPT group -->
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
{{ parsePromptSections(dec.llmPromptText).system }}
                  </pre>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-else
                    class="dec-code-block chat-reasoning chat-reasoning--md"
                    v-html="decisionHtml(parsePromptSections(dec.llmPromptText).system, true)"
                  />
                </div>

                <button class="prompt-pill prompt-pill--market" @click="toggleSection(dec.id, 'market')">
                  <span>[MARKET DATA]</span>
                  <span class="pill-chevron">{{ expandedSections[dec.id]?.has('market') ? '▾' : '▸' }}</span>
                </button>
                <div v-if="expandedSections[dec.id]?.has('market')" class="pill-content">
                  <pre v-if="!showMdPreview" class="dec-code-block">
{{ parsePromptSections(dec.llmPromptText).marketData }}
                  </pre>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-else
                    class="dec-code-block chat-reasoning chat-reasoning--md"
                    v-html="decisionHtml(parsePromptSections(dec.llmPromptText).marketData, true)"
                  />
                </div>

                <button class="prompt-pill prompt-pill--setup" @click="toggleSection(dec.id, 'setup')">
                  <span>[EDITABLE SETUP]</span>
                  <span class="pill-chevron">{{ expandedSections[dec.id]?.has('setup') ? '▾' : '▸' }}</span>
                </button>
                <div v-if="expandedSections[dec.id]?.has('setup')" class="pill-content">
                  <pre v-if="!showMdPreview" class="dec-code-block">
{{ parsePromptSections(dec.llmPromptText).editableSetup }}
                  </pre>
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-else
                    class="dec-code-block chat-reasoning chat-reasoning--md"
                    v-html="decisionHtml(parsePromptSections(dec.llmPromptText).editableSetup, true)"
                  />
                </div>
              </div>

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

  </main>
</template>

<style scoped>
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
  font-size: 12px;
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
</style>
