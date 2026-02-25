<template>
  <NuxtLink :to="`/managers/${manager.id}`" class="agent-card" style="display: block; text-decoration: none;">
    <div class="agent-card-header">
      <div>
        <div class="agent-name">{{ manager.name }}</div>
        <div class="agent-meta">{{ shortModel }}</div>
      </div>
      <span class="badge" :class="badgeClass">{{ manager.status }}</span>
    </div>
    <div class="agent-stats">
      <div>
        <div class="agent-stat-label">Interval</div>
        <div class="agent-stat-value">{{ manager.config?.decisionInterval ?? '—' }}</div>
      </div>
      <div v-if="agentCount !== undefined">
        <div class="agent-stat-label">Agents</div>
        <div class="agent-stat-value">{{ agentCount }}</div>
      </div>
      <div>
        <div class="agent-stat-label">Created</div>
        <div class="agent-stat-value" style="font-size: 11px; font-family: inherit; font-weight: 500;">{{ createdDate }}</div>
      </div>
    </div>
  </NuxtLink>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  manager: {
    id: string;
    name: string;
    status: string;
    config: { llmModel?: string; decisionInterval?: string } | null;
    createdAt: string;
  };
  agentCount?: number;
}>();

const badgeClass = computed(() => ({
  'badge-running': props.manager.status === 'running',
  'badge-paused': props.manager.status === 'paused',
  'badge-stopped': props.manager.status === 'stopped',
}));

const shortModel = computed(() => {
  const m = props.manager.config?.llmModel ?? '';
  return m.split('/').pop()?.replace(':free', '') ?? m;
});

const createdDate = computed(() =>
  new Date(props.manager.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
);
</script>
