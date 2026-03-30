<template>
  <div class="edit-page">
    <div class="edit-bar">
      <NuxtLink :to="`/managers/${id}`" class="edit-bar__back">&larr; back</NuxtLink>
      <span class="edit-bar__sep">/</span>
      <span class="edit-bar__name">{{ manager?.name || 'Edit Manager' }}</span>
      <div class="edit-bar__actions">
        <button type="button" class="edit-bar__cancel" @click="router.push(`/managers/${id}`)">Cancel</button>
        <button
          type="submit"
          form="manager-config-form"
          class="edit-bar__save"
          :disabled="saving"
        >
          <span v-if="saving" class="spinner" style="width:13px;height:13px;border-color:#fff3;border-top-color:#fff" />
          {{ saving ? 'Saving...' : 'Save Changes' }}
        </button>
      </div>
    </div>

    <div v-if="pending" class="edit-page__loading">
      <div class="page-loader">
        <div class="page-loader-track">
          <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
          <span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" /><span class="page-loader-block" />
        </div>
        <span class="page-loader-label">Loading config</span>
      </div>
    </div>
    <template v-else-if="manager">
      <div v-if="saveError" class="edit-error">{{ saveError }}</div>
      <div class="edit-page__body">
        <ManagerConfigForm
          :initial="{ name: manager.name, ...manager.config, profileId: manager.profileId, personaMd: manager.personaMd }"
          :is-edit="true"
          :manager-id="id"
          :hide-footer="true"
          @submit="handleSave"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();
const id = route.params.id as string;
const saveError = ref('');
const saving = ref(false);

const { data, pending } = await useFetch<any>(`/api/managers/${id}`, { credentials: 'include' });
const manager = computed(() => data.value ?? null);

async function handleSave(form: Record<string, unknown>) {
  saveError.value = '';
  saving.value = true;
  try {
    await $fetch(`/api/managers/${id}`, {
      method: 'PATCH',
      body: form,
      credentials: 'include',
    });
    router.push(`/managers/${id}`);
  } catch (err: any) {
    saveError.value = err?.data?.error ?? 'Failed to save';
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.edit-page {
  min-height: 100vh;
  background: var(--bg, #0a0a0a);
  padding: 0 24px 40px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.edit-page__loading { text-align: center; padding: 48px; }
.edit-bar {
  position: sticky;
  top: 52px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  background: var(--bg, #0a0a0a);
  border-bottom: 1px solid var(--border, #1e1e1e);
}
.edit-bar__back {
  font-size: 13px;
  color: var(--accent, #7c6af7);
  text-decoration: none;
  white-space: nowrap;
  font-family: 'Space Mono', monospace;
}
.edit-bar__back:hover { text-decoration: underline; }
.edit-bar__sep { color: var(--border, #333); font-size: 14px; }
.edit-bar__name {
  flex: 1;
  font-size: 13px;
  font-weight: 700;
  color: var(--text, #e0e0e0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Space Mono', monospace;
}
.edit-bar__actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.edit-bar__cancel {
  padding: 6px 14px;
  background: none;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  color: #555;
  font-size: 11px;
  font-family: 'Space Mono', monospace;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}
.edit-bar__save {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 18px;
  background: #e0e0e0;
  color: #0a0a0a;
  border: none;
  border-radius: 3px;
  font-size: 11px;
  font-family: 'Space Mono', monospace;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}
.edit-bar__save:disabled { opacity: 0.35; cursor: not-allowed; }
.edit-error {
  padding: 10px 14px;
  background: color-mix(in srgb, #e55 10%, transparent);
  border: 1px solid color-mix(in srgb, #e55 30%, transparent);
  border-radius: 4px;
  font-size: 12px;
  color: #e55;
}
.edit-page__body {
  max-width: 740px;
  margin: 0 auto;
  width: 100%;
}
</style>
