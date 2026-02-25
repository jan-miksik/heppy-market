<template>
  <div class="p-6 max-w-6xl mx-auto">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-white">Agent Managers</h1>
      <NuxtLink
        to="/managers/new"
        class="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
      >
        + New Manager
      </NuxtLink>
    </div>

    <!-- Skeleton -->
    <div v-if="pending" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div v-for="i in 3" :key="i" class="bg-gray-900 border border-gray-800 rounded-lg p-4 animate-pulse">
        <div class="h-5 bg-gray-800 rounded w-2/3 mb-3" />
        <div class="h-4 bg-gray-800 rounded w-1/2 mb-2" />
        <div class="h-4 bg-gray-800 rounded w-1/3" />
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="text-red-400 text-sm">Failed to load managers.</div>

    <!-- Empty -->
    <div v-else-if="managers.length === 0" class="text-center py-20 text-gray-500">
      <p class="text-lg mb-2">No managers yet</p>
      <p class="text-sm">Create a manager to autonomously run and optimize your trading agents.</p>
    </div>

    <!-- List -->
    <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <ManagerCard
        v-for="m in managers"
        :key="m.id"
        :manager="m"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

definePageMeta({ middleware: 'auth' });

const { data, pending, error } = await useFetch<{ managers: any[] }>('/api/managers', {
  credentials: 'include',
});
const managers = computed(() => data.value?.managers ?? []);
</script>
