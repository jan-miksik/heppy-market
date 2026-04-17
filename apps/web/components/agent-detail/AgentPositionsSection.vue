<script setup lang="ts">
import { computed, ref, type PropType } from 'vue';
import type { Trade } from '~/composables/useTrades';
import { formatCompactPrice, formatRelativeTime } from '~/utils/formatting';

type AgentConfig = {
  paperBalance?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  slippageSimulation?: number;
  maxOpenPositions?: number;
};

type AgentRecord = {
  status: string;
  config: AgentConfig;
};

type AgentDecision = {
  marketDataSnapshot?: string;
};

type MarketDataEntry = {
  pair: string;
  pairAddress?: string;
  priceUsd: number;
};

const props = defineProps({
  agent: {
    type: Object as PropType<AgentRecord>,
    required: true,
  },
  closingTrades: {
    type: Object as PropType<Set<string>>,
    required: true,
  },
  closeTradeByUser: {
    type: Function as PropType<(tradeId: string) => Promise<void>>,
    required: true,
  },
  decisions: {
    type: Array as PropType<AgentDecision[]>,
    required: true,
  },
  isAnalyzing: {
    type: Boolean,
    required: true,
  },
  isNextAnalysisImminent: {
    type: Boolean,
    required: true,
  },
  livePrices: {
    type: Object as PropType<Record<string, number>>,
    required: true,
  },
  now: {
    type: Number,
    required: true,
  },
  pnlClass: {
    type: Function as PropType<(pct?: number) => string>,
    required: true,
  },
  secondsUntilNextAction: {
    type: Number as PropType<number | null>,
    default: null,
  },
  trades: {
    type: Array as PropType<Trade[]>,
    required: true,
  },
});

const expandedTrades = ref<Set<string>>(new Set());
const openTrades = computed(() => props.trades.filter((trade) => trade.status === 'open'));

const openTradesByPair = computed(() => {
  const map = new Map<string, Trade[]>();
  for (const trade of openTrades.value) {
    const existing = map.get(trade.pair) ?? [];
    existing.push(trade);
    map.set(trade.pair, existing);
  }
  return map;
});

function parseSnapshot(snapshot?: string): MarketDataEntry[] {
  if (!snapshot) return [];
  try {
    return JSON.parse(snapshot) as MarketDataEntry[];
  } catch {
    return [];
  }
}

function getPairAddress(pairName: string): string {
  if (pairName.toUpperCase() === 'INIT/USD') return '';
  for (const decision of props.decisions) {
    const snapshot = parseSnapshot(decision.marketDataSnapshot);
    const entry = snapshot.find((item) => item.pair === pairName);
    if (entry?.pairAddress) return entry.pairAddress;
  }
  return '';
}

function getExitBounds(trade: Trade): { target: number; stop: number } {
  const tp = props.agent.config.takeProfitPct ?? 10;
  const sl = props.agent.config.stopLossPct ?? 5;
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

function getUnrealizedPnl(trade: Trade): { pnlPct: number; currentPrice: number } | null {
  const live = props.livePrices[trade.pair];
  if (live && live > 0) {
    const slippage = props.agent.config.slippageSimulation ?? 0.3;
    const effectiveEntry = trade.side === 'buy'
      ? trade.entryPrice * (1 + slippage / 100)
      : trade.entryPrice * (1 - slippage / 100);
    const pnlPct = trade.side === 'buy'
      ? ((live - effectiveEntry) / effectiveEntry) * 100
      : ((effectiveEntry - live) / effectiveEntry) * 100;
    return { pnlPct, currentPrice: live };
  }

  for (const decision of props.decisions) {
    const snapshot = parseSnapshot(decision.marketDataSnapshot);
    const entry = snapshot.find((item) => item.pair === trade.pair);
    if (entry && entry.priceUsd > 0) {
      const slippage = props.agent.config.slippageSimulation ?? 0.3;
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

function toggleTrade(tradeId: string) {
  if (expandedTrades.value.has(tradeId)) {
    expandedTrades.value.delete(tradeId);
  } else {
    expandedTrades.value.add(tradeId);
  }
}

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

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPrice(price: number) {
  return formatCompactPrice(price);
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

function timeAgo(iso: string) {
  return formatRelativeTime(iso, props.now);
}
</script>

<template>
  <div>
    <div v-if="openTrades.length > 0" class="positions-section">
      <div class="dec-section-header section-header-spaced">
        <span class="dec-section-title">Open Positions</span>
        <span class="dec-section-count">{{ openTrades.length }}</span>
      </div>
      <div class="positions-grid">
        <div v-for="[pair, pairTrades] in openTradesByPair" :key="pair" class="card pair-card">
          <div class="pair-shell">
            <div class="pair-topbar">
              <div class="pair-meta">
                <span class="mono pair-name">{{ pair }}</span>
                <span class="pair-count">{{ pairTrades.length }} position{{ pairTrades.length > 1 ? 's' : '' }}</span>
              </div>
              <div class="next-analysis-row">
                <span class="next-analysis-label">Next analysis:</span>
                <span
                  class="mono next-analysis-value"
                  :class="[
                    isAnalyzing ? 'accent' : agent.status === 'running' ? 'positive' : 'neutral',
                    { 'next-analysis-imminent': !isAnalyzing && isNextAnalysisImminent },
                  ]"
                >
                  {{ isAnalyzing ? 'running now' : agent.status === 'running' ? formatCountdown(secondsUntilNextAction) : 'stopped' }}
                </span>
              </div>
            </div>

            <PriceSparkline
              chain="base"
              :pair-address="getPairAddress(pair)"
              :pair-name="pair"
              :open-timestamps="pairTrades.map((trade) => trade.openedAt)"
            />

            <div v-if="getPairAddress(pair)" class="pair-link-row">
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

          <div v-for="trade in pairTrades" :key="trade.id" class="position-row">
            <div class="position-summary">
              <span class="badge" :class="`badge-${trade.side}`">{{ trade.side === 'buy' ? 'LONG' : 'SHORT' }}</span>

              <div class="position-metrics">
                <div>
                  <div class="position-label">Entry</div>
                  <div class="mono position-value">${{ formatPrice(trade.entryPrice) }}</div>
                </div>
                <div>
                  <div class="position-label">Size</div>
                  <div class="mono position-value">${{ formatAmountUsd(trade.amountUsd) }}</div>
                </div>
                <div>
                  <div class="position-label">Opened</div>
                  <div class="position-muted">{{ timeAgo(trade.openedAt) }}</div>
                </div>
                <div>
                  <div class="position-label">Strategy</div>
                  <div class="position-muted">{{ trade.strategyUsed }}</div>
                </div>
                <div>
                  <div class="position-label">Target</div>
                  <div class="mono position-value positive">${{ formatPrice(getExitBounds(trade).target) }}</div>
                </div>
                <div>
                  <div class="position-label">Stop</div>
                  <div class="mono position-value negative">${{ formatPrice(getExitBounds(trade).stop) }}</div>
                </div>
                <div>
                  <div class="position-label">Confidence</div>
                  <div class="mono position-value">{{ (trade.confidenceBefore * 100).toFixed(0) }}%</div>
                </div>
                <div>
                  <div class="position-label">P&amp;L</div>
                  <template v-for="pnl in [getUnrealizedPnl(trade)]" :key="trade.id + '-summary-pnl'">
                    <div
                      v-if="pnl"
                      class="mono position-value position-pnl-inline"
                      :class="pnl.pnlPct >= 0 ? 'positive' : 'negative'"
                    >
                      {{ pnl.pnlPct >= 0 ? '+' : '' }}{{ pnl.pnlPct.toFixed(2) }}%
                      /
                      {{ pnl.pnlPct >= 0 ? '+' : '' }}${{ ((pnl.pnlPct / 100) * trade.amountUsd).toFixed(2) }}
                    </div>
                    <div v-else class="mono position-muted">—</div>
                  </template>
                </div>
              </div>

              <div class="position-pnl-box">
                <template v-for="pnl in [getUnrealizedPnl(trade)]" :key="trade.id + '-pnl'">
                  <template v-if="pnl">
                    <div class="mono position-pnl-value" :class="pnl.pnlPct >= 0 ? 'positive' : 'negative'">
                      {{ pnl.pnlPct >= 0 ? '+' : '' }}{{ pnl.pnlPct.toFixed(2) }}%
                    </div>
                  </template>
                  <div v-else class="position-muted">P&amp;L: —</div>
                </template>
              </div>

              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="closingTrades.has(trade.id)"
                @click.stop="closeTradeByUser(trade.id)"
              >
                {{ closingTrades.has(trade.id) ? 'Closing…' : 'Close' }}
              </button>
            </div>

            <div class="position-reasoning" @click="toggleTrade(trade.id)">
              <span class="position-reasoning-chevron">{{ expandedTrades.has(trade.id) ? '▼' : '▶' }}</span>
              <span v-if="!expandedTrades.has(trade.id)" class="position-reasoning-preview">{{ trade.reasoning }}</span>
              <span v-else class="position-reasoning-full">{{ trade.reasoning }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

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
              <td colspan="11" class="trades-empty">No trades yet</td>
            </tr>
            <template v-for="trade in trades" :key="trade.id">
              <tr class="trade-row" @click="toggleTrade(trade.id)">
                <td class="trade-chevron">{{ expandedTrades.has(trade.id) ? '▼' : '▶' }}</td>
                <td class="mono">{{ trade.pair }}</td>
                <td>
                  <span class="badge" :class="`badge-${trade.side}`">{{ trade.side }}</span>
                </td>
                <td class="mono">${{ formatPrice(trade.entryPrice) }}</td>
                <td class="mono" :style="trade.status === 'open' ? { color: 'var(--text-muted)' } : undefined">
                  {{ trade.exitPrice ? '$' + formatPrice(trade.exitPrice) : '—' }}
                </td>
                <td class="mono">${{ formatAmountUsd(trade.amountUsd) }}</td>
                <td class="mono trade-confidence" :class="trade.confidenceBefore >= 0.7 ? 'positive' : 'neutral'">
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
                  <span v-else :class="pnlClass(trade.pnlPct ?? undefined)">{{ formatPnlInline(trade.pnlUsd, trade.pnlPct) }}</span>
                </td>
                <td class="trade-muted">{{ trade.strategyUsed }}</td>
                <td>
                  <span class="badge" :class="trade.status === 'open' ? 'badge-running' : 'badge-stopped'">
                    {{ trade.status === 'closed' ? 'closed' : trade.status }}<span v-if="trade.closeReason" class="trade-close-reason">({{ trade.closeReason.replace('_', ' ') }})</span>
                  </span>
                </td>
                <td class="trade-muted">{{ formatDate(trade.openedAt) }}</td>
              </tr>
              <tr v-if="expandedTrades.has(trade.id)">
                <td colspan="11" class="trade-reasoning-cell">
                  <div class="trade-reasoning">
                    <strong class="trade-reasoning-label">Reasoning:</strong> {{ trade.reasoning }}
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.positions-section { margin-bottom: 24px; }
.section-header-spaced { margin-bottom: 12px; }
.positions-grid { display: flex; flex-direction: column; gap: 16px; }
.pair-card { padding: 0; overflow: hidden; width: 100%; }
.pair-shell { display: flex; flex-direction: column; }
.pair-topbar { padding: 14px 16px 8px; display: flex; justify-content: space-between; align-items: center; }
.pair-meta { display: flex; align-items: center; gap: 10px; }
.pair-name { font-size: 17px; font-weight: 700; }
.pair-count, .next-analysis-label, .position-label, .position-muted, .trade-muted { color: var(--text-muted); }
.pair-count { font-size: 12px; }
.next-analysis-row { display: flex; align-items: center; gap: 8px; }
.next-analysis-label { font-size: 11px; }
.next-analysis-value { font-size: 12px; font-weight: 600; }
.pair-link-row { padding: 0 16px 8px; text-align: right; }
.position-row { border-top: 1px solid var(--border); }
.position-summary { padding: 12px 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.position-metrics { display: flex; gap: 20px; flex: 1; min-width: 0; flex-wrap: wrap; }
.position-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
.position-value, .position-muted { font-size: 13px; }
.position-pnl-inline { font-weight: 600; }
.position-pnl-box { text-align: right; min-width: 90px; }
.position-pnl-value { font-size: 18px; font-weight: 700; }
.position-reasoning { padding: 8px 16px 10px; cursor: pointer; font-size: 12px; color: var(--text-muted); border-top: 1px solid var(--border); }
.position-reasoning-chevron { margin-right: 6px; }
.position-reasoning-preview { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical; }
.position-reasoning-full { white-space: pre-wrap; display: block; margin-top: 4px; line-height: 1.5; }
.trades-empty { text-align: center; padding: 32px; color: var(--text-muted); }
.trade-row { cursor: pointer; }
.trade-chevron { color: var(--text-muted); font-size: 11px; width: 16px; }
.trade-confidence { font-size: 12px; }
.trade-close-reason { font-size: 10px; opacity: 0.7; margin-left: 4px; }
.trade-reasoning-cell { background: var(--bg-card); padding: 12px 16px; }
.trade-reasoning { font-size: 12px; color: var(--text-muted); line-height: 1.6; white-space: pre-wrap; }
.trade-reasoning-label { color: var(--text); }
.pnl-dimmed { opacity: 0.65; }
.dex-link { font-size: 11px; font-family: var(--font-mono, monospace); color: var(--text-muted); text-decoration: none; letter-spacing: 0.02em; transition: color var(--t-snap); }
.dex-link:hover { color: var(--text); }
</style>
