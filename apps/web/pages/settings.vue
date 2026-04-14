<script setup lang="ts">
const { user, fetchMe } = useAuth();
const { initConnect, disconnect } = useOpenRouter();
const {
  chainAutoSignConfigured,
  chainAutoSignEnabled,
  chainAutoSignExpiresAt,
  chainAutoSignExpired,
  chainAutoSignNeedsRenewal,
  chainAutoSignGrantEnabled,
} = useAutoSign();
const { state: initiaState, enableAutoSign, disableAutoSign } = useInitiaBridge();

const disconnecting = ref(false);
const connecting = ref(false);
const togglingChain = ref(false);

const bridgeBusy = computed(() => Boolean(initiaState.value.busyAction));
const bridgeConnected = computed(() => Boolean(initiaState.value.initiaAddress));

function formatExpiryDistance(target: Date): string {
  const diffMs = target.getTime() - Date.now();
  const diffMinutes = Math.max(0, Math.floor(Math.abs(diffMs) / 60_000));
  const days = Math.floor(diffMinutes / (24 * 60));
  const hours = Math.floor((diffMinutes % (24 * 60)) / 60);
  const minutes = diffMinutes % 60;
  const parts: string[] = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes} min`);

  return diffMs >= 0 ? `${parts.join(' ')}` : `${parts.join(' ')} ago`;
}

function formatExpiryExact(target: Date): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(target);
}

// In settings, we control the Interwoven grant only. The per-agent onchain flag
// (autoSignConfiguredOnchain) is managed from the Agent Detail page.
// So use chainAutoSignGrantEnabled as the primary signal here.
const grantActive = computed(() => chainAutoSignGrantEnabled.value);

const autoSignStatusLabel = computed(() => {
  if (grantActive.value) return 'Active';
  if (chainAutoSignExpired.value) return 'Expired';
  return 'Inactive';
});

const autoSignStatusClass = computed(() => {
  if (grantActive.value) return 'or-status--connected';
  if (chainAutoSignExpired.value) return 'or-status--warning';
  return 'or-status--none';
});

const autoSignToggleLabel = computed(() => {
  if (togglingChain.value) {
    return grantActive.value ? 'Disabling…' : 'Enabling…';
  }
  return grantActive.value ? 'Disable' : 'Enable';
});

const autoSignInfo = computed(() => {
  if (!bridgeConnected.value) {
    return 'Connect your Initia wallet to manage auto-sign in Interwoven.';
  }

  const expiresAt = chainAutoSignExpiresAt.value;

  if (grantActive.value && expiresAt) {
    return `Expires after ${formatExpiryDistance(expiresAt)} (${formatExpiryExact(expiresAt)}).`;
  }

  if (grantActive.value) {
    return 'Auto-sign is active until you revoke it in Interwoven.';
  }

  if (chainAutoSignExpired.value && expiresAt) {
    return `The previous auto-sign approval expired ${formatExpiryDistance(expiresAt)} (${formatExpiryExact(expiresAt)}). Enable it again to renew.`;
  }
});

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
    if (grantActive.value) {
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
        With auto-sign, you only approve actions once in Interwoven, no need to confirm again in your wallet.
      </p>

      <div class="settings-row autosign-chain-row">
        <span class="or-status" :class="autoSignStatusClass">
          {{ autoSignStatusLabel }}
        </span>
        <button
          class="btn btn-ghost btn-sm"
          :disabled="togglingChain || bridgeBusy || !bridgeConnected"
          @click="handleToggleChainAutoSign"
        >
          {{ autoSignToggleLabel }}
        </button>
      </div>
      <p class="settings-section-note">
        {{ autoSignInfo }}
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
.or-status--warning { color: var(--warning, #f59e0b); }
.or-status--none { color: var(--text-dim); }

.settings-section--autosign { margin-top: 20px; }

.autosign-chain-row {
  margin-bottom: 0;
}
.autosign-chain-label { font-size: 13px; color: var(--text); flex: 1; }
.settings-section-note {
  margin-top: 12px;
  margin-bottom: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
}
</style>
