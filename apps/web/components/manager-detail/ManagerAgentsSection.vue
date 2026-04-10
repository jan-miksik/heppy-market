<script setup lang="ts">
import type { ManagedAgent } from '~/features/managers/detail/useManagerDetailPage';

defineProps<{
  managedAgents: ManagedAgent[];
  agentBadgeClass: (status: string) => any;
}>();
</script>

<template>
  <div class="agents-section">
    <div class="col-header">
      Agents
      <span v-if="managedAgents.length" class="agent-count">{{ managedAgents.length }}</span>
    </div>

    <div v-if="managedAgents.length === 0" class="empty-state">
      <div class="empty-title">No agents yet</div>
      <p>The manager will create agents based on its strategy when started.</p>
    </div>

    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Pairs</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in managedAgents" :key="a.id">
            <td class="agent-name">{{ a.name }}</td>
            <td><span class="badge" :class="agentBadgeClass(a.status)">{{ a.status }}</span></td>
            <td class="mono font-sm">{{ a.config?.pairs?.join(', ') ?? '—' }}</td>
            <td><NuxtLink :to="`/agents/${a.id}`" class="btn btn-ghost btn-sm">View →</NuxtLink></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.col-header {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-count { color: var(--text-muted); font-weight: 400; }

.empty-state { padding: 32px 24px; text-align: center; }

.agent-name { color: var(--text); }
.font-sm { font-size: 11px; }

.table-wrap {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
</style>
