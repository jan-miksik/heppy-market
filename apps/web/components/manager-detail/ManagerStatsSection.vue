<script setup lang="ts">
import type { ManagerDetail } from '~/features/managers/detail/useManagerDetailPage';

defineProps<{
  manager: ManagerDetail;
  shortModel: string;
  doStatus: any;
  maxDrawdownLabel: string;
  totalTokensUsed: number;
  nextDecisionLabel: string | null;
  progressPct: number;
}>();
</script>

<template>
  <div class="stats-container">
    <!-- Next decision countdown (only when running and not deciding) -->
    <div v-if="manager.status === 'running' && nextDecisionLabel && !doStatus?.deciding" class="next-decision-bar">
      <div class="next-decision-progress" :style="{ width: progressPct + '%' }" />
      <span class="next-decision-label">Next decision {{ nextDecisionLabel }}</span>
    </div>

    <!-- Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Model</div>
        <div class="stat-value model-value">{{ shortModel }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Interval</div>
        <div class="stat-value">{{ doStatus?.decisionInterval ?? manager.config?.decisionInterval ?? '—' }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Cycles</div>
        <div class="stat-value cycles-value">{{ doStatus?.tickCount ?? 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Max Drawdown</div>
        <div class="stat-value">{{ maxDrawdownLabel }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Max Agents</div>
        <div class="stat-value">{{ manager.config?.riskParams?.maxAgents ?? '—' }}</div>
      </div>
    </div>

    <!-- LLM Tokens Used — below the stats bars -->
    <div class="token-row">
      <span class="token-label">LLM tokens used</span>
      <span class="token-count">{{ totalTokensUsed.toLocaleString('en') }}</span>
    </div>
  </div>
</template>

<style scoped>
.stats-container { margin-bottom: 24px; }

/* Next decision countdown bar */
.next-decision-bar {
  position: relative;
  height: 28px;
  margin-bottom: 20px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  display: flex;
  align-items: center;
}
.next-decision-progress {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--green) 12%, transparent);
  transition: width 1s linear;
}
.next-decision-label {
  position: relative;
  padding: 0 12px;
  font-size: 12px;
  color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
}

.token-row {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  margin-top: -16px;
}

.token-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.token-count {
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-muted);
}

.stat-card {
  padding: 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.stat-label {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.stat-value {
  font-size: 16px;
  font-weight: 500;
  color: var(--text);
}

.model-value { font-size: 13px; font-family: inherit; }
.cycles-value { font-size: 20px; }
.token-value { font-family: 'JetBrains Mono', monospace; }

@media (max-width: 1080px) {
  .stats-grid { grid-template-columns: repeat(3, 1fr); }
  .token-row { margin-top: 6px; }
}

@media (max-width: 640px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
