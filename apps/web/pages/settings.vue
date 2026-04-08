<script setup lang="ts">
const { user, fetchMe } = useAuth();
const { initConnect, disconnect } = useOpenRouter();
const { ON_CHAIN_ACTIONS, isEnabled, setEnabled, chainAutoSignEnabled } = useAutoSign();
const { state: initiaState, enableAutoSign, disableAutoSign } = useInitiaBridge();

const disconnecting = ref(false);
const connecting = ref(false);
const togglingChain = ref(false);

const bridgeBusy = computed(() => Boolean(initiaState.value.busyAction));
const bridgeConnected = computed(() => Boolean(initiaState.value.initiaAddress));

async function handleDisconnect() {
  disconnecting.value = true;
  try {
    await disconnect();
    await fetchMe();
  } finally {
    disconnecting.value = false;
  }
}

async function handleConnect() {
  connecting.value = true;
  try {
    await initConnect(); // redirects away on success
  } catch {
    connecting.value = false;
  }
}

async function handleToggleChainAutoSign() {
  togglingChain.value = true;
  try {
    if (chainAutoSignEnabled.value) {
      await disableAutoSign();
    } else {
      await enableAutoSign();
    }
  } finally {
    togglingChain.value = false;
  }
}
</script>

<template>
  <div class="settings-root">
    <h1 class="settings-title">Settings</h1>
    <section class="settings-section">
      <h2 class="settings-section-title">OpenRouter</h2>
      <p class="settings-section-desc">
        Connect your OpenRouter account to use paid models (GPT-5, Claude, Gemini, DeepSeek…).
      </p>
      <div class="settings-row">
        <template v-if="user?.openRouterKeySet">
          <span class="or-status or-status--connected">Connected</span>
          <button class="btn btn-ghost btn-sm" :disabled="disconnecting" @click="handleDisconnect">
            {{ disconnecting ? 'Disconnecting…' : 'Disconnect' }}
          </button>
        </template>
        <template v-else>
          <span class="or-status or-status--none">Not connected</span>
          <button class="btn btn-primary btn-sm" :disabled="connecting" @click="handleConnect">
            {{ connecting ? 'Redirecting…' : 'Connect OpenRouter →' }}
          </button>
        </template>
      </div>
    </section>

    <section class="settings-section settings-section--autosign">
      <h2 class="settings-section-title">Auto-Sign</h2>
      <p class="settings-section-desc">
        Choose which on-chain actions can be signed without wallet confirmation.
        A session key is registered on-chain once and can be revoked at any time.
      </p>

      <div class="settings-row autosign-chain-row">
        <span class="autosign-chain-label">Session key</span>
        <span class="or-status" :class="chainAutoSignEnabled ? 'or-status--connected' : 'or-status--none'">
          {{ chainAutoSignEnabled ? 'Active' : 'Inactive' }}
        </span>
        <button
          class="btn btn-ghost btn-sm"
          :disabled="togglingChain || bridgeBusy || !bridgeConnected"
          @click="handleToggleChainAutoSign"
        >
          {{ togglingChain ? (chainAutoSignEnabled ? 'Disabling…' : 'Enabling…') : (chainAutoSignEnabled ? 'Disable' : 'Enable') }}
        </button>
      </div>

      <div class="autosign-actions-list">
        <label
          v-for="action in ON_CHAIN_ACTIONS"
          :key="action.key"
          class="autosign-action-row"
        >
          <input
            type="checkbox"
            class="autosign-checkbox"
            :checked="isEnabled(action.key)"
            @change="setEnabled(action.key, ($event.target as HTMLInputElement).checked)"
          />
          <div class="autosign-action-info">
            <span class="autosign-action-label">{{ action.label }}</span>
            <span class="autosign-action-desc">{{ action.description }}</span>
          </div>
        </label>
      </div>

      <p class="settings-note">
        Unchecking an action resets its auto-sign consent — the prompt will reappear on next use.
        Disabling the session key revokes it on-chain but does not change the checkboxes above.
      </p>
    </section>
  </div>
</template>

<style scoped>
.settings-root { max-width: 560px; margin: 48px auto; padding: 0 24px; }
.settings-title { font-size: 20px; font-weight: 700; margin-bottom: 32px; color: var(--text); }
.settings-section {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
}
.settings-section-title { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.settings-section-desc { font-size: 13px; color: var(--text-dim); margin-bottom: 20px; line-height: 1.5; }
.settings-row { display: flex; align-items: center; gap: 12px; }
.or-status { font-size: 13px; font-weight: 500; }
.or-status--connected { color: var(--success, #22c55e); }
.or-status--none { color: var(--text-dim); }

.settings-section--autosign { margin-top: 20px; }

.autosign-chain-row {
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.autosign-chain-label { font-size: 13px; color: var(--text); flex: 1; }

.autosign-actions-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.autosign-action-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 11px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  transition: background 0.1s;
}
.autosign-action-row:last-child { border-bottom: none; }
.autosign-action-row:hover { background: color-mix(in srgb, var(--bg-card) 80%, var(--border)); }

.autosign-checkbox {
  flex-shrink: 0;
  margin-top: 3px;
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.autosign-action-info { display: flex; flex-direction: column; gap: 2px; }
.autosign-action-label { font-size: 13px; color: var(--text); }
.autosign-action-desc { font-size: 11px; color: var(--text-dim); line-height: 1.4; }

.settings-note {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 12px;
  line-height: 1.5;
}
</style>
