<script setup lang="ts">
useHead({
  htmlAttrs: { lang: 'en' },
});
</script>

<template>
  <div>
    <nav class="navbar">
      <NuxtLink to="/" class="navbar-brand">
        <span class="dot" />
        DEX Trading Agents
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
