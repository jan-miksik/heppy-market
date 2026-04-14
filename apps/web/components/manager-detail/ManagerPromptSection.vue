<script setup lang="ts">
import { sectionHtml } from '~/utils/markdown';

defineProps<{
  title: string;
  content: string;
  isOpen: boolean;
  variant: 'system' | 'market' | 'setup' | 'llm';
  showMdPreview: boolean;
}>();

defineEmits<{
  (e: 'toggle'): void;
}>();
</script>

<template>
  <div class="prompt-section">
    <button class="prompt-pill" :class="`prompt-pill--${variant}`" @click="$emit('toggle')">
      <span>[{{ title }}]</span>
      <span class="pill-chevron">{{ isOpen ? '▾' : '▸' }}</span>
    </button>
    <div v-if="isOpen" class="pill-content">
      <pre v-if="!showMdPreview" class="dec-code-block">{{ content }}</pre>
      <div
        v-else
        class="dec-code-block chat-reasoning md-content"
        v-html="sectionHtml(content, true)"
      />
    </div>
  </div>
</template>

<style scoped>
.prompt-section { margin-bottom: 4px; }

.prompt-pill {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  width: 100%;
  color: var(--text-muted);
}

.prompt-pill--market { color: #f59e0b; }
.prompt-pill--setup { color: #60a5fa; }
.prompt-pill--llm { color: #4ade80; }

.pill-chevron { flex-shrink: 0; font-size: 12px; }
.pill-content { padding-left: 10px; }

.dec-code-block {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary, #aaa);
  padding: 8px 10px;
  margin: 0;
  background: color-mix(in srgb, var(--border, #2a2a2a) 10%, transparent);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-reasoning { font-size: 14px; line-height: 1.6; color: var(--text); }
</style>
