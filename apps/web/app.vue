<script setup lang="ts">
// Feature flag — set to false to remove the beta badge sitewide
const IS_BETA = true;

useHead({
  htmlAttrs: { lang: 'en' },
});
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
        <NuxtLink to="/">Dashboard</NuxtLink>
        <NuxtLink to="/agents">Agents</NuxtLink>
        <NuxtLink to="/trades">Trades</NuxtLink>
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
</style>
