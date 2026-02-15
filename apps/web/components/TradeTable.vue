<script setup lang="ts">
import type { Trade } from '~/composables/useTrades';

defineProps<{
  trades: Trade[];
  showAgent?: boolean;
}>();

const { formatPnl, pnlClass } = useTrades();

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
          <th>Pair</th>
          <th>Side</th>
          <th>Entry</th>
          <th>Exit</th>
          <th>Amount</th>
          <th>P&amp;L</th>
          <th>Strategy</th>
          <th>Status</th>
          <th>Opened</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="trades.length === 0">
          <td colspan="9" style="text-align: center; padding: 32px; color: var(--text-muted);">
            No trades yet
          </td>
        </tr>
        <tr v-for="trade in trades" :key="trade.id">
          <td class="mono">{{ trade.pair }}</td>
          <td>
            <span class="badge" :class="`badge-${trade.side}`">{{ trade.side }}</span>
          </td>
          <td class="mono">${{ formatPrice(trade.entryPrice) }}</td>
          <td class="mono">
            {{ trade.exitPrice ? '$' + formatPrice(trade.exitPrice) : '—' }}
          </td>
          <td class="mono">${{ trade.amountUsd.toLocaleString() }}</td>
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
      </tbody>
    </table>
  </div>
</template>
