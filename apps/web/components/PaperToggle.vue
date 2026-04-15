<script setup lang="ts">
import type { PaperMode } from '~/composables/usePaperModePreference';

interface Props {
  modelValue: PaperMode;
  hasLive?: boolean;
  hasPaper?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  hasLive: true,
  hasPaper: true,
});

const emit = defineEmits<{
  'update:modelValue': [value: PaperMode];
}>();

function isDisabled(mode: PaperMode) {
  if (mode === 'live') return !props.hasLive;
  if (mode === 'paper') return !props.hasPaper;
  return !props.hasLive || !props.hasPaper;
}

function select(mode: PaperMode) {
  if (isDisabled(mode)) return;
  if (props.modelValue === mode) return;
  emit('update:modelValue', mode);
}

const activeIndex = computed(() => {
  if (props.modelValue === 'live') return 0;
  if (props.modelValue === 'all') return 1;
  return 2;
});
</script>

<template>
  <div
    class="paper-segmented"
    :data-active="modelValue"
    role="group"
    aria-label="Paper agent visibility"
  >
    <span
      class="paper-segmented__glider"
      :class="`paper-segmented__glider--${modelValue}`"
      :style="{ transform: `translateX(calc(${activeIndex * 100}% + ${activeIndex * 2}px))` }"
      aria-hidden="true"
    />
    <button
      type="button"
      class="paper-segmented__option paper-segmented__option--live"
      :aria-pressed="modelValue === 'live'"
      :disabled="isDisabled('live')"
      @click="select('live')"
    >
      <span class="paper-segmented__dot" aria-hidden="true" />
      <span>Live</span>
    </button>
    <button
      type="button"
      class="paper-segmented__option paper-segmented__option--both"
      :aria-pressed="modelValue === 'all'"
      :disabled="isDisabled('all')"
      @click="select('all')"
    >
      <span class="paper-segmented__split-dot" aria-hidden="true">
        <span class="paper-segmented__split-dot-live" />
        <span class="paper-segmented__split-dot-paper" />
      </span>
      <span>Both</span>
    </button>
    <button
      type="button"
      class="paper-segmented__option paper-segmented__option--paper"
      :aria-pressed="modelValue === 'paper'"
      :disabled="isDisabled('paper')"
      @click="select('paper')"
    >
      <span class="paper-segmented__dot" aria-hidden="true" />
      <span>Paper</span>
    </button>
  </div>
</template>

<style scoped>
.paper-segmented {
  --live: var(--accent);
  --paper: #d97706;
  --cells: 3;
  --cell-gap: 2px;

  position: relative;
  display: grid;
  grid-template-columns: repeat(var(--cells), minmax(0, 1fr));
  gap: var(--cell-gap);
  padding: 2px;
  background: color-mix(in srgb, var(--border) 45%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  isolation: isolate;
}

.paper-segmented__glider {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: calc((100% - 4px - (var(--cells) - 1) * var(--cell-gap)) / var(--cells));
  border-radius: 1px;
  background: color-mix(in srgb, var(--live) 14%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--live) 38%, transparent);
  transition:
    transform 260ms cubic-bezier(0.32, 0.72, 0, 1),
    background 220ms ease,
    box-shadow 220ms ease;
  z-index: 0;
  pointer-events: none;
}

.paper-segmented__glider--all {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--live) 14%, transparent) 0%,
    color-mix(in srgb, var(--paper) 14%, transparent) 100%
  );
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--paper) 34%, transparent);
}

.paper-segmented__glider--paper {
  background: color-mix(in srgb, var(--paper) 14%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--paper) 38%, transparent);
}

.paper-segmented__option {
  position: relative;
  z-index: 1;
  appearance: none;
  border: 0;
  background: transparent;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 5px 12px;
  border-radius: 1px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  line-height: 1;
  transition: color 200ms ease;
}

.paper-segmented__option:hover:not(:disabled):not([aria-pressed="true"]) {
  color: var(--text-dim);
}

.paper-segmented__option:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--text) 40%, transparent);
  outline-offset: 1px;
}

.paper-segmented__option:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.paper-segmented__option--live[aria-pressed="true"] {
  color: var(--live);
}
.paper-segmented__option--paper[aria-pressed="true"] {
  color: var(--paper);
}
.paper-segmented__option--both[aria-pressed="true"] {
  color: color-mix(in srgb, var(--live) 50%, var(--paper));
}

.paper-segmented__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.35;
  flex-shrink: 0;
  transition: opacity 200ms ease, box-shadow 260ms ease, transform 260ms ease;
}

.paper-segmented__option[aria-pressed="true"] .paper-segmented__dot {
  opacity: 1;
  box-shadow: 0 0 6px currentColor;
  animation: paper-segmented-pulse 520ms ease-out;
}

.paper-segmented__split-dot {
  position: relative;
  width: 10px;
  height: 6px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}
.paper-segmented__split-dot-live,
.paper-segmented__split-dot-paper {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: block;
  opacity: 0.35;
  transition: opacity 200ms ease, box-shadow 260ms ease;
}
.paper-segmented__split-dot-live {
  background: var(--live);
}
.paper-segmented__split-dot-paper {
  background: var(--paper);
  margin-left: -2px;
  position: relative;
  z-index: 1;
}
.paper-segmented__option--both[aria-pressed="true"] .paper-segmented__split-dot-live {
  opacity: 1;
  box-shadow: 0 0 5px var(--live);
}
.paper-segmented__option--both[aria-pressed="true"] .paper-segmented__split-dot-paper {
  opacity: 1;
  box-shadow: 0 0 5px var(--paper);
}

@keyframes paper-segmented-pulse {
  0% {
    transform: scale(0.7);
    box-shadow: 0 0 0 currentColor;
  }
  60% {
    transform: scale(1.25);
    box-shadow: 0 0 10px currentColor;
  }
  100% {
    transform: scale(1);
    box-shadow: 0 0 6px currentColor;
  }
}
</style>
