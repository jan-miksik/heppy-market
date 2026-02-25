<template>
  <div class="p-6 max-w-2xl mx-auto">
    <div class="flex items-center gap-3 mb-6">
      <NuxtLink :to="`/managers/${id}`" class="text-gray-400 hover:text-white text-sm">← Manager</NuxtLink>
      <h1 class="text-xl font-bold text-white">Edit Manager</h1>
    </div>
    <div v-if="pending" class="text-gray-400 text-sm">Loading…</div>
    <div v-else-if="manager" class="bg-gray-900 border border-gray-700 rounded-lg p-6">
      <ManagerConfigForm
        :initial="manager.config ? { name: manager.name, ...manager.config } : undefined"
        :is-edit="true"
        :on-cancel="() => router.push(`/managers/${id}`)"
        @submit="handleSave"
      />
    </div>
    <div v-if="saveError" class="mt-4 text-red-400 text-sm">{{ saveError }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

definePageMeta({ middleware: 'auth' });

const route = useRoute();
const router = useRouter();
const id = route.params.id as string;
const saveError = ref('');

const { data, pending } = await useFetch<any>(`/api/managers/${id}`, { credentials: 'include' });
const manager = computed(() => data.value ?? null);

async function handleSave(form: Record<string, unknown>) {
  saveError.value = '';
  try {
    await $fetch(`/api/managers/${id}`, {
      method: 'PATCH',
      body: form,
      credentials: 'include',
    });
    router.push(`/managers/${id}`);
  } catch (err: any) {
    saveError.value = err?.data?.error ?? 'Failed to save';
  }
}
</script>
