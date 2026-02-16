<script setup lang="ts">
import type { Trade } from '~/composables/useTrades';

defineProps<{
  trades: Trade[];
  showAgent?: boolean;
}>();

const { formatPnl, pnlClass } = useTrades();
const expandedRows = ref<Set<string>>(new Set());

function toggleRow(id: string) {
  if (expandedRows.value.has(id)) {
    expandedRows.value.delete(id);
  } else {
    expandedRows.value.add(id);
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
</script>

<template>
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
          <tr style="cursor: pointer;" @click="toggleRow(trade.id)">
            <td style="color: var(--text-muted); font-size: 11px; width: 16px;">
              {{ expandedRows.has(trade.id) ? '▼' : '▶' }}
            </td>
            <td class="mono">{{ trade.pair }}</td>
            <td>
              <span class="badge" :class="`badge-${trade.side}`">{{ trade.side }}</span>
            </td>
            <td class="mono">${{ formatPrice(trade.entryPrice) }}</td>
            <td class="mono">
              {{ trade.exitPrice ? '$' + formatPrice(trade.exitPrice) : '—' }}
            </td>
            <td class="mono">${{ trade.amountUsd.toLocaleString() }}</td>
            <td class="mono" :class="trade.confidenceBefore >= 0.7 ? 'positive' : 'neutral'" style="font-size: 12px;">
              {{ (trade.confidenceBefore * 100).toFixed(0) }}%
            </td>
            <td class="mono" :class="pnlClass(trade.pnlPct)">
              {{ formatPnl(trade.pnlPct) }}
            </td>
            <td style="color: var(--text-muted); font-size: 12px;">{{ trade.strategyUsed }}</td>
            <td>
              <span
                class="badge"
                :class="trade.status === 'open' ? 'badge-running' : trade.status === 'stopped_out' ? 'badge-paused' : 'badge-stopped'"
              >{{ trade.status }}</span>
            </td>
            <td style="color: var(--text-muted); font-size: 12px;">{{ formatDate(trade.openedAt) }}</td>
          </tr>
          <tr v-if="expandedRows.has(trade.id)">
            <td colspan="11" style="background: var(--bg-secondary, #1a1a2e); padding: 12px 16px;">
              <div style="font-size: 12px; color: var(--text-muted); line-height: 1.6; white-space: pre-wrap;">
                <strong style="color: var(--text-primary);">Reasoning:</strong> {{ trade.reasoning }}
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
