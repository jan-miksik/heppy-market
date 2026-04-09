<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { handleWalletDisconnect } from '~/composables/useAuth';
import initRootLogoWithText from '~/assets/initRootLogoWithTextWhite.png';

// Feature flag — set to false to remove the beta badge sitewide
const IS_BETA = true;

const { user, isAuthenticated } = useAuth();
const {
  state: initiaState,
  openConnect: openInitiaConnect,
  openWallet: openInitiaWallet,
  refresh: refreshInitia,
} = useInitiaBridge();
const { notification, showNotification, clearNotification } = useNotification();
const walletActionError = ref<string | null>(null);
const walletConnected = computed(() => !!(initiaState.value.initiaAddress || initiaState.value.evmAddress));
const shouldEnforceWalletSession = computed(() => {
  if (!isAuthenticated.value || !user.value) return false;
  return user.value.authProvider !== 'playwright';
});
const route = useRoute();
const isConnectRoute = computed(() => route.path === '/connect');

useHead({
  htmlAttrs: { lang: 'en' },
});

function truncate(addr: string): string {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

onMounted(() => {
  void refreshInitia().catch(() => undefined);
});

watch(
  [() => initiaState.value.ready, walletConnected, shouldEnforceWalletSession],
  async ([ready, connected, enforce]) => {
    if (!ready || connected || !enforce) return;
    await handleWalletDisconnect();
    if (route.path !== '/connect') {
      await navigateTo('/connect', { replace: true });
    }
  },
  { immediate: true },
);

watch(
  [walletActionError, () => initiaState.value.error],
  ([walletErr, bridgeErr], [prevWalletErr, prevBridgeErr]) => {
    const message = walletErr || bridgeErr;
    if (!message) return;
    if (message === prevWalletErr || message === prevBridgeErr) return;
    showNotification({
      type: 'error',
      title: 'Wallet Error',
      message,
      durationMs: 8_000,
    });
  },
);

async function handleWalletClick() {
  walletActionError.value = null;

  const openPreferred = () => {
    if (initiaState.value.initiaAddress) {
      return openInitiaWallet();
    }
    return openInitiaConnect();
  };

  try {
    await openPreferred();
    return;
  } catch (err: unknown) {
    walletActionError.value = (err as Error)?.message ?? 'Failed to open Initia wallet connector.';
  }

  try {
    await refreshInitia();
    await openPreferred();
  } catch (err: unknown) {
    walletActionError.value = (err as Error)?.message ?? walletActionError.value ?? 'Failed to open Initia wallet connector.';
    if (route.path !== '/connect') {
      await navigateTo('/connect');
    }
  }
}
</script>

<template>
  <div>
    <header v-if="isConnectRoute" class="shellbar shellbar--connect">
      <NuxtLink to="/connect" class="shellbar-brand">
        <img :src="initRootLogoWithText" alt="initRoot" class="brand-logo brand-logo--shell" />
        <span v-if="IS_BETA" class="beta-badge">Beta</span>
      </NuxtLink>
      <div class="shellbar-auth">
        <button
          type="button"
          class="wallet-trigger wallet-trigger--shell"
          @click="handleWalletClick"
        >
          <span
            class="wallet-dot"
            :class="{ 'wallet-dot--disconnected': !walletConnected }"
          />
          <span v-if="user && walletConnected">{{ truncate(user.walletAddress) }}</span>
          <span v-else>Connect</span>
        </button>
      </div>
    </header>
    <nav v-else class="navbar">
      <NuxtLink to="/agents" class="navbar-brand">
        <img :src="initRootLogoWithText" alt="initRoot" class="brand-logo" />
        <span v-if="IS_BETA" class="beta-badge">Beta</span>
      </NuxtLink>
      <div class="navbar-nav">
        <template v-if="isAuthenticated && walletConnected">
          <NuxtLink to="/agents">Agents</NuxtLink>
          <NuxtLink to="/trades">Trades</NuxtLink>
        </template>
        <NuxtLink to="/about">About</NuxtLink>
      </div>
      <div class="navbar-auth">
        <template v-if="isAuthenticated && user && walletConnected">
          <NuxtLink to="/settings" class="settings-icon-btn" title="Settings">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </NuxtLink>
          <button
            type="button"
            class="wallet-trigger"
            @click="handleWalletClick"
          >
            <span class="wallet-dot" />
            {{ truncate(user.walletAddress) }}
            <span
              v-if="user.authProvider && user.authProvider !== 'wallet'"
              class="provider-badge"
              :title="`Signed in with ${user.authProvider}`"
            >wallet</span>
          </button>
        </template>
        <template v-else>
          <button
            type="button"
            class="wallet-trigger"
            @click="handleWalletClick"
          >
            <span
              class="wallet-dot"
              :class="{ 'wallet-dot--disconnected': !walletConnected }"
            />
            <span>Connect</span>
          </button>
        </template>
      </div>
    </nav>
    <transition name="site-notification">
      <section
        v-if="notification"
        class="site-notification"
        :class="`site-notification--${notification.type}`"
        role="status"
        aria-live="polite"
      >
        <div class="site-notification__head">
          <strong>{{ notification.title || (notification.type === 'success' ? 'Success' : 'Error') }}</strong>
          <button type="button" class="site-notification__close" aria-label="Dismiss notification" @click="clearNotification">
            ×
          </button>
        </div>
        <p class="site-notification__message">{{ notification.message }}</p>
      </section>
    </transition>
    <main class="app-main">
      <NuxtPage />
    </main>
  </div>
</template>

<style>
.navbar {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
  padding: 0 var(--space-lg);
  height: 56px;
}

.navbar-brand {
  font-family: var(--font-mono);
  flex-shrink: 0;
  font-size: 14px;
  font-weight: 600;
  text-transform: none;
  letter-spacing: -0.01em;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  text-decoration: none;
}

.brand-logo {
  display: block;
  width: auto;
  height: 18px;
  object-fit: contain;
}

.brand-logo--shell {
  height: 16px;
}

.navbar-nav {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
}

.navbar-nav a {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.01em;
  text-transform: none;
  color: var(--text-muted);
  text-decoration: none;
  padding: 5px 10px;
  border: 1px solid transparent;
  transition: color var(--t-snap), border-color var(--t-snap);
}

.navbar-nav a:hover,
.navbar-nav a.router-link-active {
  color: var(--text);
  text-decoration: none;
}

.navbar-nav a.router-link-active {
  color: var(--accent);
  border-color: var(--accent-dim);
}

.navbar-auth {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-shrink: 0;
}

.beta-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  background: var(--accent-dim);
  color: var(--accent);
  border: 1px solid var(--accent-dim);
  margin-left: 2px;
}

.wallet-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 400;
  color: var(--text-dim);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 5px 10px;
  cursor: pointer;
  transition: border-color var(--t-snap), color var(--t-snap);
}

.wallet-trigger:hover {
  border-color: var(--border-light);
  color: var(--text);
}

.wallet-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green);
  flex-shrink: 0;
}

.wallet-dot--disconnected {
  background: var(--text-muted);
}

.provider-badge {
  font-family: var(--font-mono);
  font-size: 9px;
  padding: 1px 5px;
  border-radius: var(--radius);
  background: var(--accent-dim);
  color: var(--accent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 10px;
}

.btn-ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-dim);
}

.btn-ghost:hover {
  border-color: var(--border-light);
  color: var(--text);
}

.settings-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  color: var(--text-muted);
  text-decoration: none;
  cursor: pointer;
  transition: border-color var(--t-snap), color var(--t-snap);
}
.settings-icon-btn:hover {
  border-color: var(--border-light);
  color: var(--text);
}

.app-main {
  position: relative;
  background: black;
}

.site-notification {
  position: fixed;
  top: 68px;
  right: 16px;
  z-index: 180;
  width: min(340px, calc(100vw - 32px));
  border: 1px solid var(--border-light);
  border-left-width: 3px;
  background: var(--bg-card);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.site-notification--success {
  border-color: color-mix(in srgb, var(--green) 25%, var(--border));
  border-left-color: var(--green);
}

.site-notification--error {
  border-color: color-mix(in srgb, #f87171 25%, var(--border));
  border-left-color: #f87171;
}

.site-notification__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

.site-notification--success .site-notification__head strong {
  color: var(--green);
}

.site-notification--error .site-notification__head strong {
  color: #f87171;
}

.site-notification__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  line-height: 1;
  font-size: 11px;
  flex-shrink: 0;
  transition: border-color 0.1s, color 0.1s;
}

.site-notification__close:hover {
  border-color: var(--text-muted);
  color: var(--text);
}

.site-notification__message {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}

.site-notification-enter-active,
.site-notification-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.site-notification-enter-from,
.site-notification-leave-to {
  opacity: 0;
  transform: translateX(10px);
}

@media (max-width: 760px) {
  .site-notification {
    top: 62px;
    right: 10px;
    left: 10px;
    width: auto;
  }
}

.app-loading-overlay {
  position: fixed;
  inset: 56px 0 0;
  z-index: 110;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
}

.shellbar {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  padding: 0 16px;
  background: #171717;
  border-bottom: 1px solid #2a2a2a;
}

.shellbar-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  text-decoration: none;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.shellbar-dot--inline {
  margin-left: 4px;
}

.shellbar-sep,
.shellbar-status,
.shellbar-session {
  color: var(--text-muted);
}

.shellbar-auth {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

.shellbar-session {
  font-family: var(--font-mono);
  font-size: 13px;
}

.wallet-trigger--shell {
  padding: 7px 12px;
  border-color: var(--accent);
  color: var(--accent);
}

.wallet-trigger--shell:hover {
  border-color: var(--accent-hover);
  color: var(--accent-hover);
}
</style>
