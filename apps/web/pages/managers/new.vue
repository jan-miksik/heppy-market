<template>
  <div class="p-6 max-w-2xl mx-auto">
    <div class="flex items-center gap-3 mb-6">
      <NuxtLink to="/managers" class="text-gray-400 hover:text-white text-sm">← Managers</NuxtLink>
      <h1 class="text-xl font-bold text-white">New Manager</h1>
    </div>
    <div class="bg-gray-900 border border-gray-700 rounded-lg p-6">
      <ManagerConfigForm @submit="handleCreate" />
    </div>
    <div v-if="createError" class="mt-4 text-red-400 text-sm">{{ createError }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

definePageMeta({ middleware: 'auth' });

const router = useRouter();
const createError = ref('');

async function handleCreate(form: Record<string, unknown>) {
  createError.value = '';
  try {
    await $fetch('/api/managers', {
      method: 'POST',
      body: form,
      credentials: 'include',
    });
    router.push('/managers');
  } catch (err: any) {
    createError.value = err?.data?.error ?? 'Failed to create manager';
  }
}
</script>
