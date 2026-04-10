<script setup lang="ts">
const props = defineProps<{
  agent: any;
  displayedBalance: number;
  realizedPnlUsd: number;
  totalPnlPct: number;
  unrealizedPnlUsd: number;
  winRate: number;
  closedTradesCount: number;
  isAnalyzing: boolean;
  isNextAnalysisImminent: boolean;
  secondsUntilNextAction: number | null;
  openTradesCount: number;
  inPositionsUsd: number;
}>();

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
</script>

<template>
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
      <div class="stat-change">{{ closedTradesCount }} closed trades</div>
    </div>
    <div class="stat-card" :class="{ 'stat-card-active': isAnalyzing }">
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
      <div class="stat-change">{{ openTradesCount }} of {{ agent.config.maxOpenPositions }} positions open</div>
    </div>
  </div>
</template>

<style scoped>
.stat-card-active {
  box-shadow: inset 0 0 0 1px var(--accent);
}

.stat-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-dim);
  margin-bottom: 4px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 4px;
}

.stat-change {
  font-size: 11px;
  color: var(--text-dim);
}

.stat-value.positive { color: var(--green); }
.stat-value.negative { color: var(--red); }
.stat-value.neutral { color: var(--text-dim); }

.accent {
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.next-analysis-imminent {
  animation: countdown-pulse 1s infinite;
}

@keyframes countdown-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

@keyframes analyze-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.analyze-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: analyze-blink 1.2s ease-in-out infinite;
  flex-shrink: 0;
}
</style>
