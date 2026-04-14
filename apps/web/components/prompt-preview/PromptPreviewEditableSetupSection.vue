<script setup lang="ts">
import { nextTick, ref, watch, type PropType } from 'vue';
import { renderMarkdown } from '~/utils/markdown';

type PromptPreviewEditableActions = {
  resetBehavior: () => void;
  resetPersona: () => void;
  resetRole: () => void;
  startEditingSetup: () => void;
  stopEditingSetup: () => void;
  toggleExpanded: () => void;
  toggleSetupDiff: () => void;
  updateBehaviorText: (value: string) => void;
  updatePersonaText: (value: string) => void;
  updateRoleText: (value: string) => void;
};

const props = defineProps({
  actions: {
    type: Object as PropType<PromptPreviewEditableActions>,
    required: true,
  },
  canEditSetup: {
    type: Boolean,
    required: true,
  },
  editBehaviorText: {
    type: String,
    required: true,
  },
  editPersonaText: {
    type: String,
    required: true,
  },
  editRoleText: {
    type: String,
    required: true,
  },
  editingSetup: {
    type: Boolean,
    required: true,
  },
  isBehaviorCustomized: {
    type: Boolean,
    required: true,
  },
  isPersonaCustomized: {
    type: Boolean,
    required: true,
  },
  isRoleCustomized: {
    type: Boolean,
    required: true,
  },
  liveConstraintsSection: {
    type: String,
    required: true,
  },
  liveEditableSetup: {
    type: String,
    required: true,
  },
  setupChanged: {
    type: Boolean,
    required: true,
  },
  setupDiffHtml: {
    type: String,
    required: true,
  },
  setupExpanded: {
    type: Boolean,
    required: true,
  },
  showMdPreview: {
    type: Boolean,
    required: true,
  },
  showSetupDiff: {
    type: Boolean,
    required: true,
  },
});

const behaviorTextareaRef = ref<HTMLTextAreaElement | null>(null);
const personaTextareaRef = ref<HTMLTextAreaElement | null>(null);
const roleTextareaRef = ref<HTMLTextAreaElement | null>(null);

function autoResize(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight + 20}px`;
}

watch(() => props.editingSetup, async (editing) => {
  if (!editing) return;
  await nextTick();
  autoResize(roleTextareaRef.value);
  autoResize(behaviorTextareaRef.value);
  autoResize(personaTextareaRef.value);
});

function onRoleInput(event: Event) {
  const element = event.target as HTMLTextAreaElement;
  props.actions.updateRoleText(element.value);
  autoResize(element);
}

function onBehaviorInput(event: Event) {
  const element = event.target as HTMLTextAreaElement;
  props.actions.updateBehaviorText(element.value);
  autoResize(element);
}

function onPersonaInput(event: Event) {
  const element = event.target as HTMLTextAreaElement;
  props.actions.updatePersonaText(element.value);
  autoResize(element);
}
</script>

<template>
  <div class="prompt-section prompt-section--editable">
    <div class="prompt-section__toggle-row">
      <button type="button" class="prompt-section__toggle" style="flex:1" @click="actions.toggleExpanded()">
        <span class="prompt-section__label">[EDITABLE SETUP]</span>
        <span v-if="setupChanged" class="prompt-section__edited-badge">edited</span>
        <span class="acf__chevron" :class="{ open: setupExpanded }">›</span>
      </button>
      <button
        type="button"
        v-if="setupExpanded && !editingSetup && !showMdPreview && setupChanged"
        class="btn btn-ghost btn-sm"
        style="margin-right:8px"
        @click="actions.toggleSetupDiff()"
      >
        {{ showSetupDiff ? 'Text' : 'Diff' }}
      </button>
      <button
        type="button"
        v-if="setupExpanded && !editingSetup && canEditSetup"
        class="btn btn-ghost btn-sm"
        style="margin-right:8px"
        @click="actions.startEditingSetup()"
      >
        Edit
      </button>
      <button
        type="button"
        v-if="setupExpanded && editingSetup"
        class="btn btn-ghost btn-sm"
        style="margin-right:8px"
        @click="actions.stopEditingSetup()"
      >
        Done
      </button>
    </div>

    <pre
      v-if="setupExpanded && !editingSetup && !showMdPreview && (!setupChanged || !showSetupDiff)"
      class="prompt-section__content prompt-section__content--setup"
    >{{ liveEditableSetup }}</pre>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <pre
      v-else-if="setupExpanded && !editingSetup && !showMdPreview && setupChanged && showSetupDiff"
      class="prompt-section__content prompt-section__content--setup prompt-section__content--diff"
      v-html="setupDiffHtml"
    />
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div
      v-else-if="setupExpanded && !editingSetup && showMdPreview"
      class="prompt-section__content prompt-section__content--setup md-content"
      v-html="renderMarkdown(liveEditableSetup)"
    />

    <template v-else-if="setupExpanded">
      <div class="setup-part">
        <div class="setup-part__label">
          Role
          <span v-if="isRoleCustomized" class="acf__custom-badge">Custom</span>
          <span v-else class="setup-part__auto-tag">default</span>
          <button v-if="isRoleCustomized" type="button" class="btn btn-ghost btn-sm" style="margin-left:8px" @click="actions.resetRole()">
            ↺ Reset
          </button>
        </div>
        <textarea
          ref="roleTextareaRef"
          class="setup-part__textarea"
          :value="editRoleText"
          placeholder="Role section markdown..."
          @input="onRoleInput($event)"
        />
      </div>

      <div class="setup-part">
        <div class="setup-part__label">
          Behavior profile
          <span v-if="isBehaviorCustomized" class="acf__custom-badge">Custom</span>
          <span v-else class="setup-part__auto-tag">auto-generated</span>
          <button
            v-if="isBehaviorCustomized"
            type="button"
            class="btn btn-ghost btn-sm"
            style="margin-left:8px"
            @click="actions.resetBehavior()"
          >
            ↺ Reset
          </button>
        </div>
        <textarea
          ref="behaviorTextareaRef"
          class="setup-part__textarea"
          :value="editBehaviorText"
          placeholder="Behavior profile markdown..."
          @input="onBehaviorInput($event)"
        />
      </div>

      <div class="setup-part">
        <div class="setup-part__label">
          Persona
          <span v-if="isPersonaCustomized" class="acf__custom-badge">Custom</span>
          <button
            v-if="isPersonaCustomized"
            type="button"
            class="btn btn-ghost btn-sm"
            style="margin-left:8px"
            @click="actions.resetPersona()"
          >
            ↺ Reset
          </button>
        </div>
        <textarea
          ref="personaTextareaRef"
          class="setup-part__textarea"
          :value="editPersonaText"
          placeholder="Your persona markdown..."
          @input="onPersonaInput($event)"
        />
      </div>

      <div class="setup-part setup-part--readonly">
        <div class="setup-part__label">Constraints <span class="setup-part__auto-tag">auto-generated</span></div>
        <pre v-if="!showMdPreview" class="prompt-section__content">{{ liveConstraintsSection }}</pre>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-else class="prompt-section__content md-content" v-html="renderMarkdown(liveConstraintsSection)" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.prompt-section { border-bottom: 1px solid var(--border, #1e1e1e); }
.prompt-section:last-child { border-bottom: none; }

.prompt-section__toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 10px 16px;
  background: none;
  border: none;
  color: var(--text-muted, #555);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  text-align: left;
  gap: 8px;
}

.prompt-section__toggle:hover {
  background: color-mix(in srgb, var(--border) 20%, transparent);
}

.prompt-section__toggle-row {
  display: flex;
  align-items: center;
}

.prompt-section__edited-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--warning, #f5a623) 18%, transparent);
  color: var(--warning, #f5a623);
  border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 32%, transparent);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.prompt-section__content {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary, #aaa);
  padding: 12px 16px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.prompt-section__content--setup { overflow-y: auto; }
.prompt-section__content--diff { white-space: pre; }

:deep(.diff-line) {
  display: block;
  position: relative;
  padding: 0 2px 0 16px;
  border-radius: 3px;
}

:deep(.diff-line)::before {
  position: absolute;
  left: 4px;
  top: 0;
  width: 10px;
  text-align: center;
  opacity: 0.85;
}

:deep(.diff-line--add) {
  background: color-mix(in srgb, #22c55e 14%, transparent);
  color: color-mix(in srgb, #22c55e 70%, #e0e0e0);
}

:deep(.diff-line--add)::before { content: '+'; }

:deep(.diff-line--del) {
  background: color-mix(in srgb, #ef4444 14%, transparent);
  color: color-mix(in srgb, #ef4444 70%, #e0e0e0);
  text-decoration: line-through;
  opacity: 0.9;
}

:deep(.diff-line--del)::before { content: '-'; }

:deep(.diff-line--eq) {
  opacity: 0.75;
}

:deep(.diff-line--eq)::before { content: ' '; }

.setup-part {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border, #1e1e1e);
}

.setup-part:last-child { border-bottom: none; }
.setup-part--readonly .prompt-section__content { opacity: 0.55; }

.setup-part__label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.setup-part__auto-tag {
  font-size: 9px;
  font-weight: 400;
  color: var(--text-muted, #444);
  text-transform: none;
  letter-spacing: 0;
}

.setup-part__textarea {
  width: 100%;
  min-height: 140px;
  height: auto;
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 4px;
  padding: 10px 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text, #e0e0e0);
  resize: vertical;
  overflow-y: auto;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}

.setup-part__textarea:focus { border-color: var(--accent, #7c6af7); }

.acf__chevron {
  flex-shrink: 0;
  font-size: 18px;
  color: var(--text-muted, #555);
  transition: transform 0.2s;
  display: inline-block;
  transform: rotate(0deg);
}

.acf__chevron.open { transform: rotate(90deg); }

.acf__custom-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--warning, #f5a623) 15%, transparent);
  color: var(--warning, #f5a623);
  border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 30%, transparent);
}
</style>
