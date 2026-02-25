<template>
  <main class="page">
    <div class="page-header">
      <div>
        <NuxtLink to="/managers" class="back-link">← Managers</NuxtLink>
        <h1 class="page-title" style="margin-top: 4px;">New Manager</h1>
      </div>
    </div>

    <div style="max-width: 560px;">
      <div class="card">
        <div v-if="createError" class="alert alert-error">{{ createError }}</div>
        <ManagerConfigForm @submit="handleCreate" :on-cancel="() => $router.push('/managers')" />
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

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

<style scoped>
.back-link {
  font-size: 13px;
  color: var(--text-muted);
}
.back-link:hover {
  color: var(--text-dim);
}
</style>
