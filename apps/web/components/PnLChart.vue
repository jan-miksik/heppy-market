<script setup lang="ts">
import { Line } from 'vue-chartjs';
import type { TooltipItem } from 'chart.js';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler
);

const props = defineProps<{
  snapshots: Array<{
    balance: number;
    totalPnlPct: number;
    snapshotAt: string;
  }>;
  initialBalance: number;
}>();

const chartData = computed(() => {
  const data = props.snapshots.length > 0
    ? props.snapshots
    : [{ balance: props.initialBalance, totalPnlPct: 0, snapshotAt: new Date().toISOString() }];

  const labels = data.map((s) =>
    new Date(s.snapshotAt).toLocaleString('en', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  );

  const values = data.map((s) => s.totalPnlPct);
  const isPositive = (values.at(-1) ?? 0) >= 0;

  return {
    labels,
    datasets: [
      {
        data: values,
        borderColor: isPositive ? '#10b981' : '#ef4444',
        backgroundColor: isPositive
          ? 'rgba(16, 185, 129, 0.08)'
          : 'rgba(239, 68, 68, 0.08)',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.3,
      },
    ],
  };
});

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#111520',
      borderColor: '#1e2a42',
      borderWidth: 1,
      titleColor: '#94a3b8',
      bodyColor: '#e2e8f0',
      callbacks: {
        label: (ctx: TooltipItem<'line'>) => {
          const v = ctx.parsed.y;
          if (v == null) return '';
          return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
        },
      },
    },
  },
  scales: {
    x: {
      display: false,
    },
    y: {
      grid: { color: '#1e2a42' },
      ticks: {
        color: '#64748b',
        font: { size: 11 },
        callback: (value: unknown) => `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}%`,
      },
    },
  },
};
</script>

<template>
  <div class="chart-container">
    <Line :data="chartData" :options="chartOptions" />
  </div>
</template>
