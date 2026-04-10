<script setup lang="ts">
import type { ManagerDetail } from '~/features/managers/detail/useManagerDetailPage';

defineProps<{
  manager: ManagerDetail;
  personaEmoji: string;
  statusBadgeClass: any;
  actionLoading: boolean;
  deciding: boolean;
  lastDecisionMs?: number;
}>();

defineEmits<{
  (e: 'action', action: 'start' | 'stop'): void;
  (e: 'trigger'): void;
  (e: 'delete'): void;
}>();
</script>

<template>
  <div>
    <!-- Header -->
    <div class="page-header">
      <div>
        <NuxtLink to="/managers" class="back-link">← Managers</NuxtLink>
        <div style="display: flex; align-items: center; gap: 10px; margin-top: 4px;">
          <h1 class="page-title">
            <span v-if="personaEmoji" class="manager-emoji" style="margin-right: 6px;">{{ personaEmoji }}</span>
            {{ manager.name }}
          </h1>
          <span class="badge" :class="statusBadgeClass">{{ manager.status }}</span>
        </div>
      </div>
      <div style="display: flex; gap: 8px;">
        <button v-if="manager.status !== 'running'" class="btn btn-success" :disabled="actionLoading" @click="$emit('action', 'start')">Start</button>
        <button v-if="manager.status === 'running'" class="btn btn-ghost" :disabled="actionLoading || deciding" @click="$emit('trigger')">Push decision</button>
        <button v-if="manager.status === 'running'" class="btn btn-ghost" :disabled="actionLoading" @click="$emit('action', 'stop')">Stop</button>
        <NuxtLink :to="`/managers/${manager.id}/edit`" class="btn btn-ghost">Edit</NuxtLink>
        <button class="btn btn-danger" :disabled="actionLoading" @click="$emit('delete')">Delete</button>
      </div>
    </div>

    <!-- Deciding banner -->
    <div v-if="deciding" class="deciding-banner">
      <span class="deciding-dot" />
      <span class="deciding-text">Analyzing portfolio &amp; making decisions…</span>
      <span v-if="lastDecisionMs" class="deciding-hint">last cycle took {{ (lastDecisionMs / 1000).toFixed(1) }}s</span>
    </div>
  </div>
</template>

<style scoped>
.back-link { font-size: 13px; color: var(--text-muted); }
.back-link:hover { color: var(--text-dim); }

.deciding-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  margin-bottom: 20px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-radius: var(--radius);
  font-size: 13px;
}
.deciding-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  animation: deciding-pulse 1.2s ease-in-out infinite;
}
@keyframes deciding-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}
.deciding-text { color: var(--text); font-weight: 500; }
.deciding-hint { margin-left: auto; font-size: 12px; color: var(--text-muted); }
</style>
