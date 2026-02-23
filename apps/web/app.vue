<script setup lang="ts">
// Feature flag — set to false to remove the beta badge sitewide
const IS_BETA = true;

const { user, isAuthenticated, signOut } = useAuth();

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
          <NuxtLink to="/trades">Trades</NuxtLink>
        </template>
      </div>
      <div class="navbar-auth">
        <template v-if="isAuthenticated && user">
          <span class="wallet-addr" :title="user.walletAddress">
            <span class="wallet-dot" />
            {{ truncate(user.walletAddress) }}
            <span
              v-if="user.authProvider && user.authProvider !== 'wallet'"
              class="provider-badge"
              :title="`Signed in with ${user.authProvider}`"
            >{{ user.authProvider }}</span>
          </span>
          <button class="btn btn-ghost btn-sm" @click="signOut">Disconnect</button>
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

.navbar-auth {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-left: auto;
}

.wallet-addr {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-secondary);
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
