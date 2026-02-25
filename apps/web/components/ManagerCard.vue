<template>
  <NuxtLink :to="`/managers/${manager.id}`" class="block">
    <div class="bg-gray-900 border border-gray-700 rounded-lg p-4 hover:border-green-700 transition-colors cursor-pointer">
      <div class="flex items-start justify-between mb-3">
        <h3 class="text-white font-semibold truncate">{{ manager.name }}</h3>
        <span :class="statusClass" class="text-xs px-2 py-0.5 rounded-full font-medium ml-2 shrink-0">
          {{ manager.status }}
        </span>
      </div>
      <div class="text-sm text-gray-400 space-y-1">
        <div>Model: <span class="text-gray-300">{{ shortModel }}</span></div>
        <div>Interval: <span class="text-gray-300">{{ manager.config?.decisionInterval ?? '—' }}</span></div>
        <div v-if="agentCount !== undefined">
          Agents: <span class="text-gray-300">{{ agentCount }}</span>
        </div>
      </div>
      <div class="mt-3 text-xs text-gray-600">
        Created {{ new Date(manager.createdAt).toLocaleDateString() }}
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

const statusClass = computed(() => ({
  'bg-green-900 text-green-300': props.manager.status === 'running',
  'bg-yellow-900 text-yellow-300': props.manager.status === 'paused',
  'bg-gray-800 text-gray-400': props.manager.status === 'stopped',
}));

const shortModel = computed(() => {
  const m = props.manager.config?.llmModel ?? '';
  return m.split('/').pop()?.replace(':free', '') ?? m;
});
</script>
