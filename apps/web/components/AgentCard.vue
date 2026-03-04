<script setup lang="ts">
import type { Agent } from '~/composables/useAgents';
import { getAgentProfile, DEFAULT_AGENT_PROFILE_ID } from '@dex-agents/shared';

const props = defineProps<{
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

const personaEmoji = computed(() => {
  const configProfileId = (props.agent.config as { profileId?: string }).profileId;
  const profileId = props.agent.profileId ?? configProfileId ?? DEFAULT_AGENT_PROFILE_ID;
  return getAgentProfile(profileId)?.emoji ?? '🤖';
});
</script>

<template>
  <div class="agent-card" @click="$emit('click')">
    <div class="agent-card-header">
      <div>
        <div class="agent-name"><span class="agent-persona-emoji">{{ personaEmoji }}</span> {{ agent.name }}</div>
        <div class="agent-meta">
          {{ agent.autonomyLevel }} · {{ formatInterval(agent.config.analysisInterval) }} interval
        </div>
      </div>
      <span
        class="badge"
        :class="`badge-${agent.status}`"
      >
        {{ statusDot(agent.status) }} {{ agent.status }}
      </span>
    </div>

    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
      <span style="font-size: 11px; color: var(--text-muted);">{{ agent.config.pairs.join(', ') }}</span>
      <span v-if="agent.managerId" class="managed-tag">🧠 managed</span>
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

<style scoped>
.agent-persona-emoji {
  font-size: 1.1em;
  margin-right: 4px;
}
.managed-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  background: var(--accent-dim);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
  letter-spacing: 0.02em;
}
</style>
