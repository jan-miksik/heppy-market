<script setup lang="ts">
import type { Trade } from '~/composables/useTrades';

const props = defineProps<{
  trades: Trade[];
  showAgent?: boolean;
  agentEmojis?: Record<string, string>;
}>();
const emit = defineEmits<{
  (e: 'trade-closed', trade: Trade): void;
}>();

const { request } = useApi();
const { pnlClass, closeTrade } = useTrades();
const expandedRows = ref<Set<string>>(new Set());
const closing = ref<Set<string>>(new Set());
const livePrices = ref<Record<string, number>>({});

type SortKey = 'pair' | 'amountUsd' | 'confidenceBefore' | 'pnlPct' | 'pnlUsd' | 'openedAt';
type SortDir = 'asc' | 'desc';

const sortKey = ref<SortKey | null>(null);
const sortDir = ref<SortDir>('desc');

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

let pricesReqId = 0;
const priceRefreshTick = ref(0);
const openPairsKey = computed(() =>
  Array.from(new Set(props.trades.filter((t) => t.status === 'open').map((t) => t.pair)))
    .filter(Boolean)
    .sort()
    .join('|')
);

// Refresh live prices every 30 s so unrealized P&L animations fire on price changes.
let priceTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { priceTimer = setInterval(() => { priceRefreshTick.value++; }, 30_000); });
onUnmounted(() => { if (priceTimer !== null) clearInterval(priceTimer); });

watch(
  [openPairsKey, priceRefreshTick],
  async () => {
    const pairs = openPairsKey.value ? openPairsKey.value.split('|') : [];
    const reqId = ++pricesReqId;
    if (pairs.length === 0) {
      livePrices.value = {};
      return;
    }

    try {
      const merged: Record<string, number> = {};
      for (const batch of chunk(pairs, 50)) {
        const res = await request<{ prices: Record<string, number> }>(`/api/pairs/prices`, {
          method: 'POST',
          body: { pairs: batch },
          timeout: 30_000,
        });
        Object.assign(merged, res.prices ?? {});
      }
      if (reqId !== pricesReqId) return;
      livePrices.value = merged;
    } catch {
      if (reqId !== pricesReqId) return;
      livePrices.value = {};
    }
  },
  { immediate: true }
);

function getUnrealizedPnl(trade: Trade): { pnlPct: number; pnlUsd: number } | null {
  const live = livePrices.value[trade.pair];
  if (!live || live <= 0) return null;
  const pnlPct =
    trade.side === 'buy'
      ? ((live - trade.entryPrice) / trade.entryPrice) * 100
      : ((trade.entryPrice - live) / trade.entryPrice) * 100;
  return { pnlPct, pnlUsd: (pnlPct / 100) * trade.amountUsd };
}

function toggleSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'desc';
  }
}

function sortIcon(key: SortKey) {
  if (sortKey.value !== key) return '↕';
  return sortDir.value === 'asc' ? '↑' : '↓';
}

function effectiveTradePnl(trade: Trade): { pnlPct: number; pnlUsd: number } {
  const unrealized = getUnrealizedPnl(trade);
  return {
    pnlPct: unrealized?.pnlPct ?? trade.pnlPct ?? Number.NEGATIVE_INFINITY,
    pnlUsd: unrealized?.pnlUsd ?? trade.pnlUsd ?? Number.NEGATIVE_INFINITY,
  };
}

function tradeSortValue(trade: Trade, key: SortKey): string | number {
  switch (key) {
    case 'pair':
      return trade.pair;
    case 'amountUsd':
      return trade.amountUsd;
    case 'confidenceBefore':
      return trade.confidenceBefore;
    case 'pnlPct':
      return effectiveTradePnl(trade).pnlPct;
    case 'pnlUsd':
      return effectiveTradePnl(trade).pnlUsd;
    case 'openedAt':
      return trade.openedAt;
  }
}

const sortedTrades = computed(() => {
  const key = sortKey.value;
  if (!key) return props.trades;
  return [...props.trades].sort((a, b) => {
    const av = tradeSortValue(a, key);
    const bv = tradeSortValue(b, key);
    const dir = sortDir.value === 'asc' ? 1 : -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
});

function toggleRow(id: string) {
  if (expandedRows.value.has(id)) {
    expandedRows.value.delete(id);
  } else {
    expandedRows.value.add(id);
  }
}

async function onCloseClick(ev: MouseEvent, trade: Trade) {
  ev.stopPropagation();
  ev.preventDefault();
  if (trade.status !== 'open') return;
  if (closing.value.has(trade.id)) return;
  closing.value.add(trade.id);
  try {
    const updatedTrade = await closeTrade(trade.id);
    emit('trade-closed', updatedTrade);
  } finally {
    closing.value.delete(trade.id);
  }
}

function formatPrice(p: number) {
  return p >= 1 ? p.toLocaleString('en', { maximumFractionDigits: 4 }) : p.toPrecision(5);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

function formatPnlInline(pnlUsd?: number, pnlPct?: number): string {
  if (pnlUsd === undefined || pnlUsd === null || pnlPct === undefined || pnlPct === null) return '—';
  const normalizedPct = Object.is(pnlPct, -0) || Math.abs(pnlPct) < 0.05 ? 0 : pnlPct;
  return `${formatUsdNoNegativeZero(pnlUsd, 0)} (${normalizedPct.toFixed(1)}%)`;
}

function formatAmountUsd(amountUsd: number): string {
  return amountUsd.toLocaleString('en', { maximumFractionDigits: 2 });
}
</script>

<template>
  <div class="table-wrap">
    <table class="tt">
      <thead>
        <tr>
          <th class="tt-col-expand"></th>
          <th v-if="showAgent" class="tt-col-agent">Agent</th>
          <th class="sortable" @click="toggleSort('pair')">Pair <span class="sort-icon">{{ sortIcon('pair') }}</span></th>
          <th>Side</th>
          <th>Entry</th>
          <th>Exit</th>
          <th class="sortable" @click="toggleSort('amountUsd')">Amt <span class="sort-icon">{{ sortIcon('amountUsd') }}</span></th>
          <th class="sortable" @click="toggleSort('confidenceBefore')">Conf <span class="sort-icon">{{ sortIcon('confidenceBefore') }}</span></th>
          <th class="sortable" @click="toggleSort('pnlUsd')">P&amp;L <span class="sort-icon">{{ sortIcon('pnlUsd') }}</span></th>
          <th>Status</th>
          <th class="sortable" @click="toggleSort('openedAt')">Opened <span class="sort-icon">{{ sortIcon('openedAt') }}</span></th>
          <th class="tt-col-actions">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="sortedTrades.length === 0">
          <td :colspan="showAgent ? 12 : 11" style="text-align: center; padding: 32px; color: var(--text-muted);">
            No trades yet
          </td>
        </tr>
        <template v-for="trade in sortedTrades" :key="trade.id">
          <tr
            class="tt-row"
            :class="{ 'row--paper': trade.isPaper }"
            @click="toggleRow(trade.id)"
          >
            <td class="tt-cell-expand">
              {{ expandedRows.has(trade.id) ? '▼' : '▶' }}
            </td>
            <td v-if="showAgent" class="tt-cell-agent">
              <NuxtLink
                :to="`/agents/${trade.agentId}`"
                class="agent-link mono tt-agent-name"
                :title="trade.agentName ?? trade.agentId"
                @click.stop
              >
                <span v-if="agentEmojis?.[trade.agentId]" class="tt-agent-emoji">{{ agentEmojis[trade.agentId] }}</span>{{ trade.agentName ?? trade.agentId }}
                <span v-if="trade.isPaper" class="tt-paper-tag">PAPER</span>
              </NuxtLink>
            </td>
            <td class="mono">{{ trade.pair }}</td>
            <td>
              <span class="badge" :class="`badge-${trade.side}`">{{ trade.side }}</span>
            </td>
            <td class="mono">${{ formatPrice(trade.entryPrice) }}</td>
            <td class="mono" :class="trade.status === 'open' ? 'tt-open-exit' : ''">
              {{ trade.exitPrice ? '$' + formatPrice(trade.exitPrice) : '—' }}
            </td>
            <td class="mono">${{ formatAmountUsd(trade.amountUsd) }}</td>
            <td class="mono" :class="trade.confidenceBefore >= 0.7 ? 'positive' : 'neutral'" style="font-size: 12px;">
              {{ (trade.confidenceBefore * 100).toFixed(0) }}%
            </td>
            <td class="mono">
              <template v-if="trade.status === 'open'">
                <template v-for="pnl in [getUnrealizedPnl(trade)]" :key="trade.id + '-pnl'">
                  <TransitionGroup v-if="pnl" tag="span" name="pnl" mode="out-in">
                    <span
                      :key="formatPnlInline(pnl.pnlUsd, pnl.pnlPct)"
                      class="tt-open-pnl"
                      :class="pnl.pnlPct >= 0 ? 'positive' : 'negative'"
                    >{{ formatPnlInline(pnl.pnlUsd, pnl.pnlPct) }}</span>
                  </TransitionGroup>
                  <span v-else class="tt-open-pnl" style="color: var(--text-muted);">—</span>
                </template>
              </template>
              <Transition v-else name="pnl" mode="out-in">
                <span
                  :key="formatPnlInline(trade.pnlUsd, trade.pnlPct)"
                  :class="pnlClass(trade.pnlPct)"
                >{{ formatPnlInline(trade.pnlUsd, trade.pnlPct) }}</span>
              </Transition>
            </td>
            <td>
              <span
                class="badge"
                :class="trade.status === 'open' ? 'badge-running' : 'badge-stopped'"
              >
                {{ trade.status === 'open' ? 'OPEN' : 'CLOSED' }}
              </span>
            </td>
            <td class="tt-cell-date">{{ formatDate(trade.openedAt) }}</td>
            <td class="tt-cell-actions">
              <button
                v-if="trade.status === 'open'"
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="closing.has(trade.id)"
                @click.stop.prevent="(ev) => onCloseClick(ev, trade)"
              >
                {{ closing.has(trade.id) ? 'Closing…' : 'Close' }}
              </button>
              <span v-else style="color: var(--text-muted); font-size: 12px;">—</span>
            </td>
          </tr>
          <tr v-if="expandedRows.has(trade.id)" class="tt-detail-row">
            <td :colspan="showAgent ? 12 : 11">
              <div class="tt-detail">
                <div class="tt-detail-meta">
                  <span v-if="trade.strategyUsed" class="tt-meta-tag">{{ trade.strategyUsed }}</span>
                  <span v-if="trade.closeReason" class="tt-meta-tag tt-meta-tag--reason">{{ trade.closeReason.replace(/_/g, ' ') }}</span>
                  <span v-if="trade.dex" class="tt-meta-tag">{{ trade.dex }}</span>
                </div>
                <div class="tt-detail-reasoning">
                  <span class="tt-detail-label">Reasoning</span>
                  {{ trade.reasoning }}
                </div>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
/* ── Table structure ─────────────────────────────────── */
.tt { table-layout: fixed; }

.tt-col-expand { width: 24px; }
.tt-col-agent  { width: 140px; }
.tt-col-actions { width: 80px; text-align: right; }

.tt-row { cursor: pointer; }

.tt-cell-expand {
  color: var(--text-muted);
  font-size: 10px;
  width: 24px;
  padding-left: 8px;
  padding-right: 0;
}

/* ── Agent name truncation ───────────────────────────── */
.tt-cell-agent { max-width: 0; }

.tt-agent-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  font-size: 11px;
}

.tt-agent-emoji {
  font-style: normal;
  flex-shrink: 0;
}

.tt-paper-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, #d97706 30%, transparent);
  border-radius: var(--radius);
  color: #d97706;
  background: color-mix(in srgb, #d97706 10%, transparent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}

.tt-cell-date {
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.tt-cell-actions { text-align: right; }

.tt-open-exit { color: var(--text-muted); }
.tt-open-pnl { opacity: 0.65; }

/* ── Sorting ─────────────────────────────────────────── */
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

/* ── Agent link ──────────────────────────────────────── */
.agent-link {
  color: var(--accent);
  text-decoration: none;
}
.agent-link:hover { text-decoration: underline; }

/* ── Expanded detail row ─────────────────────────────── */
.tt-detail-row td {
  background: var(--bg-secondary, #1a1a2e);
  padding: 0;
  border-bottom: 1px solid var(--border);
}

.tt-detail {
  padding: 10px 16px 12px;
}

.tt-detail-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.tt-meta-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border: 1px solid var(--border);
  color: var(--text-muted);
}

.tt-meta-tag--reason {
  border-color: var(--accent-dim);
  color: var(--accent);
}

.tt-detail-reasoning {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  white-space: pre-wrap;
}

.tt-detail-label {
  display: block;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  margin-bottom: 4px;
}
</style>
