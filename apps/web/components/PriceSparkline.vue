<script setup lang="ts">
import { Line } from 'vue-chartjs';
import type { TooltipItem } from 'chart.js';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
} from 'chart.js';
import { formatCompactPrice } from '~/utils/formatting';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip);

const props = defineProps<{
  chain: string;
  pairAddress: string;
  pairName?: string;
  openTimestamps?: string[];
}>();

const { request } = useApi();

const timeframe = ref<'1h' | '4h' | '1d'>('1h');
const candles = ref<Array<{ t: number; o: number; h: number; l: number; c: number }>>([]);
const dataSource = ref<'coingecko' | 'coinpaprika' | 'geckoterminal' | 'demo' | 'none' | ''>('');
const loading = ref(false);
const error = ref(false);
const isDemoData = computed(() => dataSource.value === 'demo');

const currentPrice = computed(() => {
  if (candles.value.length === 0) return null;
  return candles.value[candles.value.length - 1]!.c;
});

const priceDirection = computed(() => {
  if (candles.value.length < 2) return 0;
  const first = candles.value[0]!.o;
  const last = candles.value[candles.value.length - 1]!.c;
  return last >= first ? 1 : -1;
});

const priceChangePct = computed(() => {
  if (candles.value.length < 2) return 0;
  const first = candles.value[0]!.o;
  const last = candles.value[candles.value.length - 1]!.c;
  return ((last - first) / first) * 100;
});

async function fetchOHLCV() {
  loading.value = true;
  error.value = false;
  try {
    const endpoint = props.pairAddress
      ? `/api/pairs/${props.chain}/${props.pairAddress}/ohlcv?timeframe=${timeframe.value}`
      : props.pairName
      ? `/api/pairs/ohlcv?pair=${encodeURIComponent(props.pairName)}&timeframe=${timeframe.value}`
      : '';
    if (!endpoint) {
      candles.value = [];
      return;
    }

    const data = await request<{
      candles: typeof candles.value;
      source?: 'coingecko' | 'coinpaprika' | 'geckoterminal' | 'demo' | 'none';
    }>(endpoint);
    candles.value = data.candles;
    dataSource.value = data.source ?? (props.pairAddress ? 'geckoterminal' : '');
  } catch {
    error.value = true;
    candles.value = [];
    dataSource.value = '';
  } finally {
    loading.value = false;
  }
}

watch([() => props.pairAddress, () => props.pairName, timeframe], () => fetchOHLCV(), { immediate: true });

function formatPrice(price: number): string {
  return formatCompactPrice(price);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  if (timeframe.value === '1d') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const lineColor = computed(() => priceDirection.value >= 0 ? '#6BCB77' : '#FF6B6B');
const fillColor = computed(() => priceDirection.value >= 0 ? 'rgba(107,203,119,0.08)' : 'rgba(255,107,107,0.08)');

const openMarkers = computed(() => {
  const markerData = Array<number | null>(candles.value.length).fill(null);
  const markerLabels: Record<number, string> = {};

  if (candles.value.length === 0 || !props.openTimestamps?.length) {
    return { markerData, markerLabels };
  }

  const rangeStart = candles.value[0]!.t;
  const rangeEnd = candles.value[candles.value.length - 1]!.t;
  const opensByIndex = new Map<number, number[]>();

  for (const openedAt of props.openTimestamps) {
    const ts = new Date(openedAt).getTime();
    if (!Number.isFinite(ts) || ts < rangeStart || ts > rangeEnd) continue;

    let nearestIdx = 0;
    let nearestDiff = Math.abs(candles.value[0]!.t - ts);
    for (let i = 1; i < candles.value.length; i++) {
      const diff = Math.abs(candles.value[i]!.t - ts);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearestIdx = i;
      }
    }

    const bucket = opensByIndex.get(nearestIdx) ?? [];
    bucket.push(ts);
    opensByIndex.set(nearestIdx, bucket);
  }

  for (const [idx, timestamps] of opensByIndex.entries()) {
    markerData[idx] = candles.value[idx]!.c;
    const firstOpened = new Date(Math.min(...timestamps)).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    markerLabels[idx] = timestamps.length === 1
      ? `Position opened ${firstOpened}`
      : `${timestamps.length} positions opened (first ${firstOpened})`;
  }

  return { markerData, markerLabels };
});

const chartData = computed(() => ({
  labels: candles.value.map((c) => formatTime(c.t)),
  datasets: [
    {
      label: 'Price',
      data: candles.value.map((c) => c.c),
      borderColor: lineColor.value,
      backgroundColor: fillColor.value,
      borderWidth: 1.5,
      pointRadius: 0,
      pointHitRadius: 8,
      fill: true,
      tension: 0.2,
    },
    {
      label: 'Position opens',
      data: openMarkers.value.markerData,
      showLine: false,
      pointRadius: 3.5,
      pointHoverRadius: 5,
      pointHitRadius: 10,
      pointBackgroundColor: '#F5A623',
      pointBorderColor: '#0F0F0F',
      pointBorderWidth: 1.2,
    },
  ],
}));

const chartOptions = computed(() => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 0 },
  interaction: {
    mode: 'index' as const,
    intersect: false,
  },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: '#161616',
      borderColor: '#2A2A2A',
      borderWidth: 1,
      titleColor: '#8A8580',
      bodyColor: '#E8E4DF',
      titleFont: { family: "'Space Mono', monospace", size: 10 },
      bodyFont: { family: "'Space Mono', monospace", size: 11 },
      padding: 8,
      displayColors: false,
      callbacks: {
        title: (items: TooltipItem<'line'>[]) => {
          if (items.length === 0) return '';
          const idx = items[0]!.dataIndex;
          const candle = candles.value[idx];
          return candle ? formatTime(candle.t) : '';
        },
        label: (ctx: TooltipItem<'line'>) => {
          if (ctx.dataset.label === 'Position opens') {
            const markerLabel = openMarkers.value.markerLabels[ctx.dataIndex] ?? 'Position opened';
            const price = ctx.parsed.y == null ? '' : ` @ $${formatPrice(ctx.parsed.y)}`;
            return `${markerLabel}${price}`;
          }
          return `$${formatPrice(ctx.parsed.y ?? 0)}`;
        },
      },
    },
  },
  scales: {
    x: {
      display: true,
      grid: { display: false },
      ticks: {
        color: '#8A8580',
        font: { family: "'Space Mono', monospace", size: 9 },
        autoSkip: true,
        maxTicksLimit: 4,
      },
    },
    y: {
      display: true,
      position: 'right' as const,
      grid: { color: 'rgba(138, 133, 128, 0.16)' },
      ticks: {
        color: '#8A8580',
        font: { family: "'Space Mono', monospace", size: 9 },
        maxTicksLimit: 4,
        callback: (value: string | number) => `$${formatPrice(Number(value))}`,
      },
    },
  },
}));

const tfLabels: Record<string, string> = { '1h': '1H', '4h': '4H', '1d': '1D' };
</script>

<template>
  <div class="sparkline">
    <!-- Header: current price + timeframe toggle -->
    <div class="sparkline-header">
      <div class="sparkline-price-group">
        <span v-if="currentPrice" class="sparkline-price mono">${{ formatPrice(currentPrice) }}</span>
        <span v-else class="sparkline-price mono" style="color: var(--text-muted);">--</span>
        <span
          v-if="candles.length >= 2"
          class="sparkline-change mono"
          :class="priceDirection >= 0 ? 'positive' : 'negative'"
        >
          {{ priceChangePct >= 0 ? '+' : '' }}{{ priceChangePct.toFixed(2) }}%
        </span>
      </div>
      <div class="sparkline-tf-group">
        <button
          v-for="tf in (['1h', '4h', '1d'] as const)"
          :key="tf"
          class="sparkline-tf-btn"
          :class="{ active: timeframe === tf }"
          @click="timeframe = tf"
        >
          {{ tfLabels[tf] }}
        </button>
      </div>
    </div>

    <!-- Chart -->
    <div class="sparkline-chart" :class="{ 'sparkline-loading': loading }">
      <div v-if="candles.length > 0 && isDemoData" class="sparkline-source-badge mono" title="Using fallback demo price series">
        Demo data
      </div>
      <Line v-if="candles.length > 0" :data="chartData" :options="chartOptions" />
      <div v-else-if="error" class="sparkline-empty">Failed to load</div>
      <div v-else-if="loading" class="sparkline-empty">Loading...</div>
      <div v-else class="sparkline-empty">No data</div>
    </div>
  </div>
</template>

<style scoped>
.sparkline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 16px 8px;
}

.sparkline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sparkline-price-group {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.sparkline-price {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}

.sparkline-change {
  font-size: 12px;
  font-weight: 600;
}

.sparkline-tf-group {
  display: flex;
  gap: 2px;
}

.sparkline-tf-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  cursor: pointer;
  border-radius: var(--radius);
  transition: all var(--t-snap);
}

.sparkline-tf-btn:hover {
  color: var(--text-dim);
}

.sparkline-tf-btn.active {
  color: var(--text);
  border-color: var(--border-light);
  background: var(--bg-hover);
}

.sparkline-chart {
  height: 120px;
  position: relative;
  transition: opacity var(--t-data);
}

.sparkline-loading {
  opacity: 0.5;
}

.sparkline-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.sparkline-source-badge {
  position: absolute;
  top: 6px;
  left: 8px;
  z-index: 2;
  font-size: 10px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 999px;
  color: #a36c10;
  background: rgba(245, 166, 35, 0.18);
  border: 1px solid rgba(245, 166, 35, 0.4);
  letter-spacing: 0.03em;
}
</style>
