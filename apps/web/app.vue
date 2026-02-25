<script setup lang="ts">
import { useAppKit } from '@reown/appkit/vue';

// Feature flag — set to false to remove the beta badge sitewide
const IS_BETA = true;

const { user, isAuthenticated } = useAuth();
const { open: openAppKit } = useAppKit();

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
      <NuxtLink to="/" class="navbar-brand">
        <span class="dot" />
        Heppy Market
        <span v-if="IS_BETA" class="beta-badge">Beta</span>
      </NuxtLink>
      <div class="navbar-nav">
        <template v-if="isAuthenticated">
          <NuxtLink to="/">Dashboard</NuxtLink>
          <NuxtLink to="/agents">Agents</NuxtLink>
          <NuxtLink to="/managers">Managers</NuxtLink>
          <NuxtLink to="/trades">Trades</NuxtLink>
        </template>
      </div>
      <div class="navbar-auth">
        <template v-if="isAuthenticated && user">
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
          <NuxtLink to="/connect" class="btn btn-primary btn-sm">Connect</NuxtLink>
        </template>
      </div>
    </nav>
    <NuxtPage />
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
  padding: 0 24px;
  height: 56px;
}

.navbar-brand {
  flex-shrink: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 8px;
}

.navbar-nav {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 1rem;
}

.navbar-nav a {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-dim);
  text-decoration: none;
  padding: 6px 12px;
  border-radius: 6px;
  transition: background 0.15s, color 0.15s;
}

.navbar-nav a:hover,
.navbar-nav a.router-link-active {
  background: var(--bg-hover);
  color: var(--text);
}

.navbar-auth {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.beta-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 20px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--accent-dim);
  color: var(--accent);
  border: 1px solid var(--accent-dim);
  margin-left: 2px;
}

.wallet-trigger {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border);
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.wallet-trigger:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.wallet-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success, #22c55e);
  flex-shrink: 0;
}

.provider-badge {
  font-size: 0.65rem;
  padding: 1px 5px;
  border-radius: 10px;
  background: var(--accent-dim);
  color: var(--accent);
  text-transform: capitalize;
  font-family: 'Inter', sans-serif;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 0.75rem;
}

.btn-ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-secondary);
}

.btn-ghost:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}
</style>
