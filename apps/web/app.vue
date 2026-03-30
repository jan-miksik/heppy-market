<script setup lang="ts">
import { useAppKit } from '@reown/appkit/vue';
import { useAccount } from '@wagmi/vue';

// Feature flag — set to false to remove the beta badge sitewide
const IS_BETA = true;

const { user, isAuthenticated, authResolved } = useAuth();
const { open: openAppKit } = useAppKit();
const { isConnected, address } = useAccount();

useHead({
  htmlAttrs: { lang: 'en' },
});

function truncate(addr: string): string {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
</script>

<template>
  <div>
    <nav class="navbar">
      <NuxtLink to="/agents" class="navbar-brand">
        <span class="dot" />
        Something in loop
        <span v-if="IS_BETA" class="beta-badge">Beta</span>
      </NuxtLink>
      <div class="navbar-nav">
        <template v-if="isAuthenticated">
          <NuxtLink to="/agents">Agents</NuxtLink>
          <NuxtLink to="/managers">Managers</NuxtLink>
          <NuxtLink to="/trades">Trades</NuxtLink>
        </template>
      </div>
      <div class="navbar-auth">
        <template v-if="isAuthenticated && user">
          <NuxtLink to="/settings" class="settings-icon-btn" title="Settings">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </NuxtLink>
          <button
            type="button"
            class="wallet-trigger"
            @click="openAppKit({ view: 'Account' })"
          >
            <span class="wallet-dot" />
            {{ truncate(user.walletAddress) }}
            <span
              v-if="user.authProvider && user.authProvider !== 'wallet'"
              class="provider-badge"
              :title="`Signed in with ${user.authProvider}`"
            >{{ user.authProvider }}</span>
          </button>
        </template>
        <template v-else>
          <button
            type="button"
            class="wallet-trigger"
            @click="openAppKit(isConnected ? { view: 'Account' } : undefined)"
          >
            <span
              class="wallet-dot"
              :class="{ 'wallet-dot--disconnected': !isConnected }"
            />
            <span v-if="isConnected && address">
              {{ truncate(address) }}
            </span>
            <span v-else>
              Connect
            </span>
          </button>
        </template>
      </div>
    </nav>
    <main class="app-main">
      <NuxtPage />
      <div v-if="!authResolved" class="app-loading-overlay" aria-live="polite" aria-busy="true">
        <div class="init-loader">
          <div class="init-beacon" />
          <div class="init-bars">
            <span class="init-bar" />
            <span class="init-bar" />
            <span class="init-bar" />
            <span class="init-bar" />
            <span class="init-bar" />
          </div>
          <span class="init-label">Initializing</span>
          <span class="init-sub">restoring session · checking auth</span>
        </div>
      </div>
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
  border-bottom: 2px solid var(--border);
  padding: 0 var(--space-lg);
  height: 52px;
}

.navbar-brand {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  text-decoration: none;
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
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-muted);
  text-decoration: none;
  padding: 5px 10px;
  border: 1px solid transparent;
  transition: color var(--t-snap), border-color var(--t-snap);
}

.navbar-nav a:hover,
.navbar-nav a.router-link-active {
  color: var(--text);
  border-color: var(--border-light);
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
}

.app-loading-overlay {
  position: fixed;
  inset: 52px 0 0;
  z-index: 110;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
