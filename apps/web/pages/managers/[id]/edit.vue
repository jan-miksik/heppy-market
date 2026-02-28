<template>
  <main class="page">
    <div class="page-header">
      <div>
        <NuxtLink :to="`/managers/${id}`" class="back-link">← Manager</NuxtLink>
        <h1 class="page-title" style="margin-top: 4px;">Edit Manager</h1>
      </div>
    </div>

    <div style="max-width: 560px;">
      <div v-if="pending" style="text-align: center; padding: 48px;">
        <span class="spinner" />
      </div>
      <div v-else-if="manager" class="card">
        <div v-if="saveError" class="alert alert-error">{{ saveError }}</div>
        <ManagerConfigForm
          :initial="manager ? { name: manager.name, ...manager.config, profileId: manager.profileId, personaMd: manager.personaMd } : undefined"
          :is-edit="true"
          :on-cancel="() => router.push(`/managers/${id}`)"
          @submit="handleSave"
        />
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

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

<style scoped>
.back-link {
  font-size: 13px;
  color: var(--text-muted);
}
.back-link:hover {
  color: var(--text-dim);
}
</style>
