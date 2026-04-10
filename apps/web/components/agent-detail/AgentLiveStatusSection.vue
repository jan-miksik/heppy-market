<script setup lang="ts">
const props = defineProps<{
  totalTokensUsed: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}>();
</script>

<template>
  <p class="tokens-note mono">
    llm tokens: {{ totalTokensUsed.toLocaleString('en') }}
    <span class="tokens-split">({{ totalPromptTokens.toLocaleString('en') }} ↑ / {{ totalCompletionTokens.toLocaleString('en') }} ↓)</span>
  </p>
</template>

<style scoped>
.tokens-note {
  font-size: 10px;
  color: var(--text-dim);
  opacity: 0.5;
  margin: -4px 0 20px;
  padding: 0 2px;
  letter-spacing: 0.02em;
}

.tokens-split {
  opacity: 0.7;
  margin-left: 4px;
}
</style>
