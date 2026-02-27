<script setup lang="ts">
defineProps<{
  chain: string;
  pairAddress: string;
  height?: number;
}>();
</script>

<template>
  <div v-if="pairAddress" class="dex-chart">
    <iframe
      :src="`https://dexscreener.com/${chain}/${pairAddress}?embed=1&theme=dark&trades=0&info=0&chartType=usd&loadChartSettings=0`"
      :style="{ height: `${height ?? 380}px`, width: '100%', border: 'none', borderRadius: '6px' }"
      frameborder="0"
      title="DexScreener chart"
    />
  </div>
  <div v-else class="chart-placeholder" style="display: flex; align-items: center; justify-content: center; height: 120px; color: var(--text-muted); font-size: 13px; background: var(--bg-secondary, #1a1a2e); border-radius: 6px;">
    No chart available
  </div>
</template>
