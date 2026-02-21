<script setup lang="ts">
import type { Agent } from '~/composables/useAgents';

defineProps<{
  agent: Agent;
}>();

defineEmits<{
  click: [];
  start: [id: string];
  stop: [id: string];
  delete: [id: string];
  edit: [id: string];
}>();

function statusDot(status: string) {
  return status === 'running' ? '●' : status === 'paused' ? '◐' : '○';
}
</script>

<template>
  <div class="agent-card" @click="$emit('click')">
    <div class="agent-card-header">
      <div>
        <div class="agent-name">{{ agent.name }}</div>
        <div class="agent-meta">
          {{ agent.autonomyLevel }} · {{ agent.config.analysisInterval }} interval
        </div>
      </div>
      <span
        class="badge"
        :class="`badge-${agent.status}`"
      >
        {{ statusDot(agent.status) }} {{ agent.status }}
      </span>
    </div>

    <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">
      {{ agent.config.pairs.join(', ') }}
    </div>
    <div style="font-size: 11px; color: var(--text-muted);">
      {{ agent.llmModel.split('/')[1] ?? agent.llmModel }}
    </div>

    <div class="agent-stats">
      <div>
        <div class="agent-stat-label">Balance</div>
        <div class="agent-stat-value">${{ agent.config.paperBalance.toLocaleString() }}</div>
      </div>
      <div>
        <div class="agent-stat-label">Max Pos</div>
        <div class="agent-stat-value">{{ agent.config.maxPositionSizePct }}%</div>
      </div>
      <div>
        <div class="agent-stat-label">SL / TP</div>
        <div class="agent-stat-value">{{ agent.config.stopLossPct }}% / {{ agent.config.takeProfitPct }}%</div>
      </div>
    </div>

    <div style="display: flex; gap: 6px; margin-top: 14px;" @click.stop>
      <button
        v-if="agent.status !== 'running'"
        class="btn btn-success btn-sm"
        @click="$emit('start', agent.id)"
      >
        ▶ Start
      </button>
      <button
        v-else
        class="btn btn-ghost btn-sm"
        @click="$emit('stop', agent.id)"
      >
        ■ Stop
      </button>
      <button
        class="btn btn-ghost btn-sm"
        @click="$emit('edit', agent.id)"
      >
        ✎ Edit
      </button>
      <button
        class="btn btn-danger btn-sm"
        @click="$emit('delete', agent.id)"
      >
        Delete
      </button>
    </div>
  </div>
</template>
