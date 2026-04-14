<script setup lang="ts">
import { toRef, type PropType } from 'vue';
import PromptPreviewEditableSetupSection from '~/components/prompt-preview/PromptPreviewEditableSetupSection.vue';
import PromptPreviewSourceSection from '~/components/prompt-preview/PromptPreviewSourceSection.vue';
import { useAgentPromptPreview, type PromptFormState } from '~/composables/useAgentPromptPreview';

const props = defineProps({
  formRef: {
    type: Object as PropType<PromptFormState | null>,
    default: null,
  },
  marketDataPreviewText: {
    type: String,
    default: '',
  },
  fallbackEditableSetup: {
    type: String,
    default: '',
  },
  previewError: {
    type: String,
    default: '',
  },
  initiallyExpanded: {
    type: Boolean,
    default: true,
  },
});

const {
  canEditSetup,
  editBehaviorText,
  editPersonaText,
  editRoleText,
  editingSetup,
  isBehaviorCustomized,
  isPersonaCustomized,
  isRoleCustomized,
  liveConstraintsSection,
  liveEditableSetup,
  liveSystemPrompt,
  marketDataExpanded,
  marketDataPreview,
  promptPreviewExpanded,
  resetBehavior,
  resetPersona,
  resetRole,
  setupChanged,
  setupDiffHtml,
  setupExpanded,
  showMdPreview,
  showSetupDiff,
  startEditingSetup,
  stopEditingSetup,
  systemExpanded,
  updateBehaviorText,
  updatePersonaText,
  updateRoleText,
} = useAgentPromptPreview({
  formRef: toRef(props, 'formRef'),
  marketDataPreviewText: toRef(props, 'marketDataPreviewText'),
  fallbackEditableSetup: toRef(props, 'fallbackEditableSetup'),
  initiallyExpanded: toRef(props, 'initiallyExpanded'),
});

function togglePromptPreviewExpanded() {
  promptPreviewExpanded.value = !promptPreviewExpanded.value;
}

function toggleShowMdPreview() {
  showMdPreview.value = !showMdPreview.value;
}

function toggleSystemExpanded() {
  systemExpanded.value = !systemExpanded.value;
}

function toggleMarketDataExpanded() {
  marketDataExpanded.value = !marketDataExpanded.value;
}

function toggleSetupExpanded() {
  setupExpanded.value = !setupExpanded.value;
}

function toggleSetupDiff() {
  showSetupDiff.value = !showSetupDiff.value;
}

const editableSetupActions = {
  resetBehavior,
  resetPersona,
  resetRole,
  startEditingSetup,
  stopEditingSetup,
  toggleExpanded: toggleSetupExpanded,
  toggleSetupDiff,
  updateBehaviorText,
  updatePersonaText,
  updateRoleText,
};
</script>

<template>
  <div class="prompt-preview">
    <button type="button" class="prompt-preview__toggle" @click="togglePromptPreviewExpanded">
      <span class="prompt-preview__title">Prompt Preview</span>
      <span class="acf__chevron" :class="{ open: promptPreviewExpanded }">›</span>
    </button>

    <div class="prompt-preview__body" :class="{ open: promptPreviewExpanded }">
      <div class="prompt-preview__body-content">
        <button type="button" class="btn btn-ghost btn-sm prompt-preview__md-toggle" @click="toggleShowMdPreview">
          {{ showMdPreview ? 'MD ●' : 'MD ○' }}
        </button>
        <div v-if="previewError" class="prompt-preview__error">{{ previewError }}</div>

        <div class="prompt-pills">
          <PromptPreviewSourceSection
            label="[SYSTEM]"
            tone="system"
            :content="liveSystemPrompt"
            :expanded="systemExpanded"
            :show-md-preview="showMdPreview"
            :toggle="toggleSystemExpanded"
          />
          <PromptPreviewSourceSection
            label="[MARKET DATA]"
            tone="market"
            :content="marketDataPreview"
            :expanded="marketDataExpanded"
            :show-md-preview="showMdPreview"
            :toggle="toggleMarketDataExpanded"
          />
        </div>

        <PromptPreviewEditableSetupSection
          :actions="editableSetupActions"
          :can-edit-setup="canEditSetup"
          :edit-behavior-text="editBehaviorText"
          :edit-persona-text="editPersonaText"
          :edit-role-text="editRoleText"
          :editing-setup="editingSetup"
          :is-behavior-customized="isBehaviorCustomized"
          :is-persona-customized="isPersonaCustomized"
          :is-role-customized="isRoleCustomized"
          :live-constraints-section="liveConstraintsSection"
          :live-editable-setup="liveEditableSetup"
          :setup-changed="setupChanged"
          :setup-diff-html="setupDiffHtml"
          :setup-expanded="setupExpanded"
          :show-md-preview="showMdPreview"
          :show-setup-diff="showSetupDiff"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.prompt-preview {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 10px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.prompt-preview__toggle {
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
  gap: 12px;
  transition: background 0.15s;
}

.prompt-preview__toggle:hover {
  background: color-mix(in srgb, var(--border, #2a2a2a) 50%, transparent);
}

.prompt-preview__body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
  position: relative;
}

.prompt-preview__body.open {
  max-height: 2000px;
}

.prompt-preview__body-content {
  padding-top: 30px;
}

.prompt-preview__md-toggle {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 11px;
  z-index: 1;
}

.prompt-preview__error {
  padding: 16px;
  font-size: 12px;
  color: var(--error, #e05a5a);
}

.prompt-pills {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 8px 12px;
}
</style>
