<script setup lang="ts">
import { computed, type PropType } from 'vue';
import { renderMarkdown } from '~/utils/markdown';

const props = defineProps({
  content: {
    type: String,
    required: true,
  },
  expanded: {
    type: Boolean,
    required: true,
  },
  label: {
    type: String,
    required: true,
  },
  showMdPreview: {
    type: Boolean,
    required: true,
  },
  tone: {
    type: String as PropType<'system' | 'market'>,
    required: true,
  },
  toggle: {
    type: Function as PropType<() => void>,
    required: true,
  },
});

const toneClass = computed(() => `prompt-pill--${props.tone}`);
</script>

<template>
  <button type="button" class="prompt-pill" :class="toneClass" @click="toggle()">
    <span>{{ label }}</span>
    <span class="acf__chevron" :class="{ open: expanded }">›</span>
  </button>
  <div v-if="expanded" class="pill-content">
    <pre v-if="!showMdPreview" class="dec-code-block dec-code-block--scrollable">{{ content }}</pre>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-else class="dec-code-block dec-code-block--scrollable md-content" v-html="renderMarkdown(content)" />
  </div>
</template>

<style scoped>
.prompt-pill {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-family: 'Space Mono', monospace;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  width: 100%;
  color: var(--text-muted);
  transition: opacity 0.1s;
}

.prompt-pill:hover { opacity: 0.75; }
.prompt-pill--system { color: var(--text-muted); }
.prompt-pill--market { color: #f59e0b; }

.acf__chevron {
  flex-shrink: 0;
  font-size: 18px;
  color: var(--text-muted, #555);
  transition: transform 0.2s;
  display: inline-block;
  transform: rotate(0deg);
}

.acf__chevron.open { transform: rotate(90deg); }

.pill-content { padding: 0 10px 8px 18px; }

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

.dec-code-block--scrollable { overflow-y: auto; }
</style>
