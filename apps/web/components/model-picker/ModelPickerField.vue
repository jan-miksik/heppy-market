<script setup lang="ts">
import type { ModelCatalogItem } from '@something-in-loop/shared';
import { deriveModelPickerState } from '~/utils/llm-models';

const props = withDefaults(defineProps<{
  modelValue: string;
  catalog: ModelCatalogItem[];
  hasOwnKey: boolean;
  customInputPlaceholder?: string;
  browseHref?: string;
  browseLabel?: string;
}>(), {
  customInputPlaceholder: 'Or type any model ID...',
  browseHref: 'https://openrouter.ai/models',
  browseLabel: 'Browse all models at openrouter.ai/models ↗',
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const modelPickerOpen = ref(false);
const modelQuery = ref('');
const modelPickerRef = ref<HTMLElement | null>(null);
const dropdownModel = ref('');
const customModel = ref('');

function syncInternalValue(value: string) {
  const next = deriveModelPickerState({
    value,
    catalog: props.catalog,
  });
  dropdownModel.value = next.dropdownModel;
  customModel.value = next.customModel;
}

watch(
  () => props.modelValue,
  (value) => {
    syncInternalValue(value);
  },
  { immediate: true }
);

watch(
  () => props.catalog,
  () => {
    syncInternalValue(props.modelValue);
  },
  { deep: true }
);

const currentModelId = computed(() => customModel.value.trim() || dropdownModel.value);

watch(currentModelId, (value) => {
  if (value && value !== props.modelValue) {
    emit('update:modelValue', value);
  }
});

const selectedModelMeta = computed<ModelCatalogItem | null>(() => {
  return props.catalog.find((item) => item.id === currentModelId.value) ?? null;
});

const filteredModels = computed<ModelCatalogItem[]>(() => {
  const q = modelQuery.value.trim().toLowerCase();
  if (!q) return props.catalog;
  return props.catalog.filter((item) =>
    (item.label + ' ' + item.id + ' ' + (item.desc ?? '')).toLowerCase().includes(q)
  );
});

function selectModel(id: string) {
  dropdownModel.value = id;
  modelPickerOpen.value = false;
  modelQuery.value = '';
}

function closeModelPicker() {
  modelPickerOpen.value = false;
  modelQuery.value = '';
}

function onDocPointerDown(e: PointerEvent) {
  if (!modelPickerOpen.value) return;
  const el = modelPickerRef.value;
  if (el && e.target instanceof Node && !el.contains(e.target)) closeModelPicker();
}

function onDocKeydown(e: KeyboardEvent) {
  if (!modelPickerOpen.value) return;
  if (e.key === 'Escape') closeModelPicker();
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onDocKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('keydown', onDocKeydown);
});
</script>

<template>
  <div ref="modelPickerRef" class="model-picker">
    <button
      type="button"
      class="model-picker__btn form-select"
      :aria-expanded="modelPickerOpen ? 'true' : 'false'"
      aria-haspopup="dialog"
      @click="modelPickerOpen = !modelPickerOpen"
    >
      <span class="model-picker__btn-left">
        <span class="model-picker__btn-label">{{ selectedModelMeta?.label ?? currentModelId }}</span>
        <span class="model-picker__btn-sub">
          <span class="model-picker__mono">{{ currentModelId }}</span>
          <span v-if="selectedModelMeta" class="model-picker__meta">
            · {{ selectedModelMeta.ctx }} · {{ selectedModelMeta.price }}
          </span>
        </span>
      </span>
      <span class="model-picker__chev" :class="{ open: modelPickerOpen }">›</span>
    </button>

    <div v-if="modelPickerOpen" class="model-picker__panel" role="dialog" aria-label="Select model">
      <div class="model-picker__panel-top">
        <input
          v-model="modelQuery"
          class="model-picker__search"
          placeholder="Search models..."
          autocomplete="off"
        />
        <div class="model-picker__hint">Pick a row · Esc to close</div>
      </div>

      <div class="model-picker__table">
        <div class="model-picker__thead">
          <div>Model</div>
          <div>Context</div>
          <div>Price (in/out)</div>
          <div>Tier</div>
        </div>
        <button
          v-for="item in filteredModels"
          :key="item.id"
          type="button"
          class="model-picker__row"
          :class="{ active: currentModelId === item.id }"
          @click="selectModel(item.id)"
        >
          <div class="model-picker__cell model-picker__model">
            <div class="model-picker__model-label">{{ item.label }}</div>
            <div class="model-picker__model-id">{{ item.id }}</div>
            <div v-if="item.desc" class="model-picker__model-desc">{{ item.desc }}</div>
          </div>
          <div class="model-picker__cell model-picker__mono">{{ item.ctx }}</div>
          <div class="model-picker__cell model-picker__mono">{{ item.price }}</div>
          <div class="model-picker__cell">
            <span class="model-picker__pill" :data-tier="item.tier">{{ item.tier }}</span>
          </div>
        </button>
        <div v-if="filteredModels.length === 0" class="model-picker__empty">
          No matches.
        </div>
      </div>
    </div>
  </div>

  <template v-if="hasOwnKey">
    <input
      v-model="customModel"
      class="form-input"
      style="margin-top: 8px"
      :placeholder="customInputPlaceholder"
    />
    <a
      :href="browseHref"
      target="_blank"
      rel="noopener"
      class="model-browse-link"
    >{{ browseLabel }}</a>
  </template>
  <p v-else class="model-nudge">
    <slot name="locked-message">
      <NuxtLink to="/settings">Connect your OpenRouter key</NuxtLink> to unlock paid models.
    </slot>
  </p>
</template>

<style scoped>
.model-picker { position: relative; }
.model-picker__btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
  cursor: pointer;
}
.model-picker__btn-left { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.model-picker__btn-label {
  font-weight: 650;
  letter-spacing: 0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-picker__btn-sub {
  font-size: 11px;
  color: var(--text-muted, #6a6a6a);
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.model-picker__meta { white-space: nowrap; opacity: 0.9; }
.model-picker__mono {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-variant-numeric: tabular-nums;
}
.model-picker__chev {
  font-size: 18px;
  color: var(--text-muted, #555);
  transition: transform 0.2s;
  display: inline-block;
  transform: rotate(0deg);
  flex-shrink: 0;
}
.model-picker__chev.open { transform: rotate(90deg); }

.model-picker__panel {
  position: absolute;
  z-index: 50;
  left: 0;
  right: 0;
  margin-top: 8px;
  background: color-mix(in srgb, var(--surface, #141414) 92%, black);
  border: 1px solid var(--border, #2a2a2a);
  box-shadow: 0 18px 60px rgba(0,0,0,0.55);
  border-radius: 10px;
  overflow: hidden;
}
.model-picker__panel-top {
  padding: 10px 12px 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--border, #2a2a2a);
  background: color-mix(in srgb, var(--border, #2a2a2a) 20%, transparent);
}
.model-picker__search {
  flex: 1;
  background: rgba(0,0,0,0.25);
  border: 1px solid color-mix(in srgb, var(--border, #2a2a2a) 70%, transparent);
  border-radius: 8px;
  padding: 9px 10px;
  font-size: 13px;
  color: var(--text, #e0e0e0);
  outline: none;
}
.model-picker__search:focus { border-color: var(--accent, #7c6af7); }
.model-picker__hint {
  font-size: 10px;
  color: var(--text-muted, #666);
  white-space: nowrap;
}

.model-picker__table { max-height: 360px; overflow: auto; }
.model-picker__thead {
  position: sticky;
  top: 0;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 92px 110px 72px;
  gap: 10px;
  padding: 9px 12px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--text-muted, #666);
  background: color-mix(in srgb, var(--surface, #141414) 96%, black);
  border-bottom: 1px solid var(--border, #2a2a2a);
}
.model-picker__row {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(260px, 1fr) 92px 110px 72px;
  gap: 10px;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--text, #e0e0e0);
  cursor: pointer;
  text-align: left;
  border-bottom: 1px dashed color-mix(in srgb, var(--border, #2a2a2a) 65%, transparent);
}
.model-picker__row:hover {
  background: color-mix(in srgb, var(--accent, #7c6af7) 10%, transparent);
}
.model-picker__row.active {
  background: color-mix(in srgb, var(--accent, #7c6af7) 18%, transparent);
  outline: 1px solid color-mix(in srgb, var(--accent, #7c6af7) 55%, transparent);
  outline-offset: -1px;
}
.model-picker__cell { display: flex; align-items: flex-start; }
.model-picker__model { flex-direction: column; gap: 2px; }
.model-picker__model-label { font-size: 13px; font-weight: 650; }
.model-picker__model-id { font-size: 11px; color: var(--text-muted, #777); font-family: inherit; }
.model-picker__model-desc { font-size: 10px; color: var(--text-muted, #666); }

.model-picker__pill {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--border, #2a2a2a) 80%, transparent);
  background: rgba(0,0,0,0.25);
  color: var(--text-muted, #aaa);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.model-picker__pill[data-tier="free"] {
  border-color: color-mix(in srgb, #4ade80 35%, transparent);
  color: color-mix(in srgb, #4ade80 85%, white);
}
.model-picker__pill[data-tier="paid"] {
  border-color: color-mix(in srgb, #fbbf24 35%, transparent);
  color: color-mix(in srgb, #fbbf24 85%, white);
}
.model-picker__pill[data-tier="tester"] {
  border-color: color-mix(in srgb, #60a5fa 35%, transparent);
  color: color-mix(in srgb, #60a5fa 85%, white);
}

.model-picker__empty {
  padding: 14px 12px;
  font-size: 12px;
  color: var(--text-muted, #666);
}

.model-browse-link {
  display: block;
  font-size: 12px;
  color: var(--accent, #7c6af7);
  margin-top: 4px;
  text-decoration: none;
}
.model-browse-link:hover { text-decoration: underline; }
.model-nudge {
  font-size: 12px;
  color: var(--text-muted, #555);
  margin-top: 6px;
}
.model-nudge :deep(a),
.model-nudge :deep(button) {
  color: var(--accent, #7c6af7);
}
.model-nudge :deep(button) {
  padding: 0;
  margin: 0;
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.model-nudge :deep(button:hover),
.model-nudge :deep(a:hover) {
  text-decoration: underline;
}
.model-nudge :deep(button:disabled) {
  opacity: 0.6;
  cursor: default;
}
</style>
