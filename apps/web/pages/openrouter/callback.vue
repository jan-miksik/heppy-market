<script setup lang="ts">
definePageMeta({ layout: false });

const { handleCallback } = useOpenRouter();
const { fetchMe } = useAuth();
const route = useRoute();

const status = ref<'loading' | 'success' | 'error'>('loading');
const errorMsg = ref('');
let exchangeStarted = false;

onMounted(async () => {
  if (exchangeStarted) return; // guard against double-mount
  exchangeStarted = true;

  const code = route.query.code as string | undefined;
  const state = route.query.state as string | undefined;
  if (!code || !state) {
    status.value = 'error';
    errorMsg.value = 'Missing code or state in callback URL.';
    return;
  }
  try {
    const returnTo = await handleCallback(code, state);
    await fetchMe();
    status.value = 'success';
    setTimeout(() => navigateTo(returnTo || '/settings'), 1500);
  } catch (err) {
    status.value = 'error';
    errorMsg.value = (err as Error).message ?? 'Exchange failed.';
  }
});
</script>

<template>
  <div class="callback-root">
    <div class="callback-card">
      <template v-if="status === 'loading'">
        <div class="callback-spinner" />
        <p>Connecting OpenRouter…</p>
      </template>
      <template v-else-if="status === 'success'">
        <p class="callback-ok">OpenRouter connected. Redirecting…</p>
      </template>
      <template v-else>
        <p class="callback-err">{{ errorMsg }}</p>
        <NuxtLink to="/connect">Try again</NuxtLink>
      </template>
    </div>
  </div>
</template>

<style scoped>
.callback-root {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}
.callback-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 40px 48px;
  text-align: center;
  color: var(--text);
  min-width: 280px;
}
.callback-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  margin: 0 auto 16px;
}
@keyframes spin { to { transform: rotate(360deg); } }
.callback-ok { color: var(--success, #22c55e); }
.callback-err { color: var(--danger, #ef4444); margin-bottom: 12px; }
</style>
