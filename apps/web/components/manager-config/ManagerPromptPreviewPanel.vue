<script setup lang="ts">
import PromptPreviewSourceSection from '~/components/prompt-preview/PromptPreviewSourceSection.vue';
import { splitManagerPromptSections } from '~/lib/manager-prompt';
import { renderMarkdown } from '~/utils/markdown';

const props = defineProps<{
  managerId?: string;
  isEdit?: boolean;
  initiallyExpanded?: boolean;
  systemPrompt: string;
  editableSetup: string;
  personaMd: string;
  isPersonaCustomized: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:personaMd', value: string): void;
  (e: 'edited'): void;
  (e: 'restore'): void;
}>();

const promptPreviewExpanded = ref(true);
const showMdPreview = ref(false);
const systemExpanded = ref(false);
const contextExpanded = ref(false);
const setupExpanded = ref(true);
const editingSetup = ref(false);
const previewLoading = ref(false);
const previewError = ref('');
const lastPromptText = ref('');
const lastPromptAt = ref<string | null>(null);
const bodyContentRef = ref<HTMLElement | null>(null);
const bodyMaxHeight = ref('0px');
let resizeObserver: ResizeObserver | null = null;

function syncBodyHeight() {
  bodyMaxHeight.value = promptPreviewExpanded.value
    ? `${bodyContentRef.value?.scrollHeight ?? 0}px`
    : '0px';
}

const editablePersonaMd = computed({
  get: () => props.personaMd,
  set: (value: string) => emit('update:personaMd', value),
});

async function loadPromptPreview() {
  if (!props.managerId) return;
  previewLoading.value = true;
  previewError.value = '';
  try {
    const data = await $fetch<{ promptText: string | null; promptAt: string | null }>(`/api/managers/${props.managerId}/prompt-preview`, {
      credentials: 'include',
    });
    lastPromptText.value = data.promptText ?? '';
    lastPromptAt.value = data.promptAt ?? null;
  } catch {
    previewError.value = 'Prompt preview unavailable yet - run the paper manager once';
    lastPromptText.value = '';
    lastPromptAt.value = null;
  } finally {
    previewLoading.value = false;
  }
}

const apiContext = computed(() => splitManagerPromptSections(lastPromptText.value).context);
const contextNote = computed(() => {
  if (previewLoading.value) return 'loading...';
  if (!props.isEdit) return '- available after first run';
  if (!lastPromptText.value) return '- run manager once to populate';
  return lastPromptAt.value ? `- last run ${new Date(lastPromptAt.value).toLocaleString()}` : '- last run';
});
const contextPreview = computed(() => {
  if (previewLoading.value) return '(Loading portfolio context...)';
  if (!props.isEdit) return '(Portfolio context will appear after the manager runs for the first time)';
  if (!lastPromptText.value) return '(Run the manager once to populate portfolio context)';
  return apiContext.value || '(No portfolio context captured yet)';
});

watch(
  () => props.initiallyExpanded,
  (value) => {
    promptPreviewExpanded.value = value ?? true;
  },
  { immediate: true }
);

watch(
  () => [props.isEdit, props.managerId] as const,
  ([isEdit, managerId]) => {
    if (isEdit && managerId) {
      loadPromptPreview();
      return;
    }
    previewError.value = '';
    lastPromptText.value = '';
    lastPromptAt.value = null;
  },
  { immediate: true }
);

watch(
  [
    promptPreviewExpanded,
    showMdPreview,
    systemExpanded,
    contextExpanded,
    setupExpanded,
    editingSetup,
    previewLoading,
    previewError,
    lastPromptText,
    lastPromptAt,
    editablePersonaMd,
  ],
  async () => {
    await nextTick();
    syncBodyHeight();
  },
  { immediate: true }
);

onMounted(() => {
  resizeObserver = new ResizeObserver(() => syncBodyHeight());
  if (bodyContentRef.value) {
    resizeObserver.observe(bodyContentRef.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});
</script>

<template>
  <div class="mpp">
    <button type="button" class="mpp__toggle" @click="promptPreviewExpanded = !promptPreviewExpanded">
      <span class="mpp__title">Prompt Preview</span>
      <span class="acf__chevron" :class="{ open: promptPreviewExpanded }">›</span>
    </button>

    <div class="mpp__body" :class="{ open: promptPreviewExpanded }" :style="{ maxHeight: bodyMaxHeight }">
      <div ref="bodyContentRef" class="mpp__body-content">
        <button
          type="button"
          class="btn btn-ghost btn-sm mpp__md-toggle"
          @click="showMdPreview = !showMdPreview"
        >
          {{ showMdPreview ? 'MD ●' : 'MD ○' }}
        </button>

        <div v-if="previewError" class="mpp__error">{{ previewError }}</div>

        <div class="mpp__pills">
          <PromptPreviewSourceSection
            label="[SYSTEM]"
            tone="system"
            :content="systemPrompt"
            :expanded="systemExpanded"
            :show-md-preview="showMdPreview"
            :toggle="() => { systemExpanded = !systemExpanded; }"
          />

          <div class="mpp__context-group">
            <button type="button" class="prompt-pill prompt-pill--market" @click="contextExpanded = !contextExpanded">
              <span>[PAPER PORTFOLIO CONTEXT]</span>
              <span class="mpp__pill-meta">
                <span class="mpp__pill-note">{{ contextNote }}</span>
                <span class="acf__chevron" :class="{ open: contextExpanded }">›</span>
              </span>
            </button>
            <div v-if="contextExpanded" class="pill-content">
              <pre v-if="!showMdPreview" class="dec-code-block dec-code-block--scrollable">{{ contextPreview }}</pre>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div
                v-else
                class="dec-code-block dec-code-block--scrollable md-content"
                v-html="renderMarkdown(contextPreview)"
              />
            </div>
          </div>

          <div class="mpp__setup-section">
            <div class="mpp__setup-row">
              <button type="button" class="prompt-pill prompt-pill--setup" @click="setupExpanded = !setupExpanded">
                <span>[EDITABLE SETUP]</span>
                <span class="acf__chevron" :class="{ open: setupExpanded }">›</span>
              </button>
              <button
                v-if="setupExpanded"
                type="button"
                class="btn btn-ghost btn-sm"
                @click="editingSetup = !editingSetup"
              >
                {{ editingSetup ? 'Done' : 'Edit' }}
              </button>
            </div>

            <template v-if="setupExpanded && editingSetup">
              <div class="mpp__persona-wrap">
                <PersonaEditor v-model="editablePersonaMd" :show-actions="false" @edited="emit('edited')" />
                <div v-if="isPersonaCustomized" class="mpp__restore-row">
                  <button type="button" class="btn btn-ghost btn-sm" @click="emit('restore')">
                    ↺ Restore auto-persona
                  </button>
                </div>
              </div>
            </template>
            <template v-else-if="setupExpanded">
              <pre v-if="!showMdPreview" class="mpp__code-block">{{ editableSetup }}</pre>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div v-else class="mpp__code-block mpp__code-block--md md-content" v-html="renderMarkdown(editableSetup)" />
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mpp {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.mpp__toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 16px;
  border: none;
  color: var(--text, #e0e0e0);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  background: color-mix(in srgb, var(--border, #2a2a2a) 30%, transparent);
  gap: 8px;
  transition: background 0.15s;
}

.mpp__toggle:hover {
  background: color-mix(in srgb, var(--border, #2a2a2a) 50%, transparent);
}

.mpp__title {
  font-size: 13px;
  font-weight: 600;
}

.acf__chevron {
  flex-shrink: 0;
  font-size: 18px;
  color: var(--text-muted, #555);
  transition: transform 0.2s;
  display: inline-block;
  transform: rotate(0deg);
}

.acf__chevron.open { transform: rotate(90deg); }

.mpp__body {
  overflow: hidden;
  transition: max-height 0.3s ease;
  position: relative;
}

.mpp__body-content {
  padding-top: 30px;
}

.mpp__md-toggle {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 11px;
  z-index: 1;
}

.mpp__error {
  padding: 16px;
  font-size: 12px;
  color: var(--error, #e05a5a);
}

.mpp__pills {
  padding: 8px 10px 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mpp__context-group {
  display: flex;
  flex-direction: column;
}

.mpp__setup-section {
  border-top: 1px solid var(--border, #1e1e1e);
}

.mpp__setup-row {
  display: flex;
  align-items: center;
}

:deep(.prompt-pill) {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-family: var(--font-mono, monospace);
  padding: 4px 8px;
  text-align: left;
  background: transparent;
  border: none;
  cursor: pointer;
}

:deep(.prompt-pill--system) { color: var(--text-muted, #888); }
:deep(.prompt-pill--market) { color: #f59e0b; }
:deep(.prompt-pill--setup) { color: #60a5fa; }
:deep(.pill-content) { padding: 0 10px 8px 18px; }
:deep(.dec-code-block) {
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

:deep(.dec-code-block--scrollable) { overflow-y: auto; }

.mpp__pill-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.mpp__pill-note {
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  color: var(--text-muted, #777);
}

.mpp__code-block {
  margin: 0;
  padding: 8px 10px 8px 18px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary, #aaa);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'JetBrains Mono', monospace;
}

.mpp__persona-wrap {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mpp__restore-row {
  display: flex;
  justify-content: flex-end;
}
</style>
