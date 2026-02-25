<template>
  <main class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">Agent Managers</h1>
        <p class="page-subtitle">{{ managers.length }} managers · {{ managers.filter(m => m.status === 'running').length }} running</p>
      </div>
      <NuxtLink to="/managers/new" class="btn btn-primary">+ New Manager</NuxtLink>
    </div>

    <div v-if="pending" style="text-align: center; padding: 48px;">
      <span class="spinner" />
    </div>

    <div v-else-if="error" class="alert alert-error">Failed to load managers.</div>

    <div v-else-if="managers.length === 0" class="empty-state">
      <div class="empty-icon">🧠</div>
      <div class="empty-title">No managers yet</div>
      <p>Create a manager to autonomously run and optimize your trading agents.</p>
      <NuxtLink to="/managers/new" class="btn btn-primary" style="margin-top: 16px;">Create Manager</NuxtLink>
    </div>

    <div v-else class="agents-grid">
      <ManagerCard
        v-for="m in managers"
        :key="m.id"
        :manager="m"
      />
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const { data, pending, error } = await useFetch<{ managers: any[] }>('/api/managers', {
  credentials: 'include',
});
const managers = computed(() => data.value?.managers ?? []);
</script>
