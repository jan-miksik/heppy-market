<script setup lang="ts">
definePageMeta({ ssr: false });
import { parse as markedParse } from 'marked';
import { buildBehaviorSection, buildConstraintsSection, BASE_AGENT_PROMPT, buildJsonSchemaInstruction, AGENT_ROLE_SECTION } from '@something-in-loop/shared';
import type { CreateAgentPayload } from '~/composables/useAgents';
import AgentConfigForm from '~/components/AgentConfigForm.vue';

const router = useRouter();
const { createAgent, startAgent } = useAgents();

const creating = ref(false);
const createError = ref('');

const showMdPreview = ref(false);
const systemExpanded = ref(false);
const editingSetup = ref(false);
const editPersonaText = ref('');
const editBehaviorText = ref('');
const editRoleText = ref('');

const behaviorTextareaRef = ref<HTMLTextAreaElement | null>(null);
const personaTextareaRef = ref<HTMLTextAreaElement | null>(null);
const roleTextareaRef = ref<HTMLTextAreaElement | null>(null);

const configFormRef = ref<InstanceType<typeof AgentConfigForm> | null>(null);

function autoResize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 20}px`;
}

// Live system prompt
const liveSystemPrompt = computed(() => BASE_AGENT_PROMPT + buildJsonSchemaInstruction());

// Compute live EDITABLE SETUP from form values
const liveEditableSetup = computed(() => {
  const form = configFormRef.value;
  if (!form) return '';

  const roleSection = (form.isRoleCustomized && form.roleMd) ? form.roleMd : AGENT_ROLE_SECTION;
  const behaviorSection = (form.isBehaviorCustomized && form.behaviorMd)
    ? form.behaviorMd
    : buildBehaviorSection(form.behavior as any);
  const personaSection = form.personaMd ? '## Your Persona\n' + form.personaMd : '';
  const constraintsSection = buildConstraintsSection({
    pairs: form.form.pairs ?? [],
    maxPositionSizePct: form.form.maxPositionSizePct ?? 2,
    maxOpenPositions: form.form.maxOpenPositions ?? 3,
    stopLossPct: form.form.stopLossPct ?? 2,
    takeProfitPct: form.form.takeProfitPct ?? 3,
  });

  return [roleSection, behaviorSection, personaSection, constraintsSection].filter(Boolean).join('\n\n');
});

const liveBehaviorSection = computed(() => {
  const form = configFormRef.value;
  if (!form) return '';
  return buildBehaviorSection(form.behavior as any);
});

const liveConstraintsSection = computed(() => {
  const form = configFormRef.value;
  if (!form) return '';
  return buildConstraintsSection({
    pairs: form.form.pairs ?? [],
    maxPositionSizePct: form.form.maxPositionSizePct ?? 2,
    maxOpenPositions: form.form.maxOpenPositions ?? 3,
    stopLossPct: form.form.stopLossPct ?? 2,
    takeProfitPct: form.form.takeProfitPct ?? 3,
  });
});

const isPersonaCustomized = computed(() => configFormRef.value?.isPersonaCustomized ?? false);
const isBehaviorCustomized = computed(() => configFormRef.value?.isBehaviorCustomized ?? false);
const isRoleCustomized = computed(() => configFormRef.value?.isRoleCustomized ?? false);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function renderMarkdown(text: string): string {
  try {
    return markedParse(text, { async: false }) as string;
  } catch {
    return escapeHtml(text);
  }
}

// ── Inline setup editing ────────────────────────────────────────────────

function startEditingSetup() {
  editPersonaText.value = configFormRef.value?.personaMd ?? '';
  editBehaviorText.value = configFormRef.value?.behaviorMd || liveBehaviorSection.value;
  editRoleText.value = configFormRef.value?.roleMd || AGENT_ROLE_SECTION;
  editingSetup.value = true;

  nextTick(() => {
    autoResize(behaviorTextareaRef.value);
    autoResize(personaTextareaRef.value);
    autoResize(roleTextareaRef.value);
  });
}

function stopEditingSetup() {
  editingSetup.value = false;
}

function onPersonaTextInput(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  editPersonaText.value = el.value;
  if (configFormRef.value) {
    configFormRef.value.personaMd = el.value;
    configFormRef.value.isPersonaCustomized = true;
  }
  autoResize(el);
}

function resetPersona() {
  if (configFormRef.value) {
    configFormRef.value.restorePersona();
    editPersonaText.value = configFormRef.value.personaMd ?? '';
  }
}

function onBehaviorTextInput(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  editBehaviorText.value = el.value;
  if (configFormRef.value) {
    configFormRef.value.behaviorMd = el.value;
    configFormRef.value.isBehaviorCustomized = true;
  }
  autoResize(el);
}

function resetBehavior() {
  if (configFormRef.value) {
    configFormRef.value.restoreBehavior();
    editBehaviorText.value = liveBehaviorSection.value;
  }
}

function onRoleTextInput(event: Event) {
  const el = event.target as HTMLTextAreaElement;
  editRoleText.value = el.value;
  if (configFormRef.value) {
    configFormRef.value.roleMd = el.value;
    configFormRef.value.isRoleCustomized = true;
  }
  autoResize(el);
}

function resetRole() {
  if (configFormRef.value) {
    configFormRef.value.restoreRole();
    editRoleText.value = AGENT_ROLE_SECTION;
  }
}

// ── Create handler ──────────────────────────────────────────────────────

function toCreateAgentPayload(payload: Partial<CreateAgentPayload>): CreateAgentPayload {
  if (
    !payload.name
    || !payload.pairs
    || !payload.strategies
    || !payload.analysisInterval
    || payload.paperBalance === undefined
    || payload.maxPositionSizePct === undefined
    || payload.stopLossPct === undefined
    || payload.takeProfitPct === undefined
    || payload.maxOpenPositions === undefined
    || !payload.llmModel
    || payload.temperature === undefined
    || payload.allowFallback === undefined
  ) {
    throw new Error('Missing required agent configuration');
  }
  return payload as CreateAgentPayload;
}

async function handleCreate(payload: Partial<CreateAgentPayload>) {
  creating.value = true;
  createError.value = '';
  try {
    const agent = await createAgent(toCreateAgentPayload(payload));
    try {
      await startAgent(agent.id);
    } catch {
      console.warn('Agent created but failed to auto-start');
    }
    router.push(`/agents/${agent.id}`);
  } catch (e) {
    createError.value = extractApiError(e);
  } finally {
    creating.value = false;
  }
}

function handleCancel() {
  router.push('/agents');
}
</script>

<template>
  <div class="edit-page">
    <!-- Sticky command bar -->
    <div class="edit-bar">
      <NuxtLink to="/agents" class="edit-bar__back">&larr; back</NuxtLink>
      <span class="edit-bar__sep">/</span>
      <span class="edit-bar__name">New Agent</span>
      <div class="edit-bar__actions">
        <button type="button" class="edit-bar__cancel" @click="handleCancel">Cancel</button>
        <button
          type="submit"
          form="agent-config-form"
          class="edit-bar__save"
          :disabled="creating"
        >
          <span v-if="creating" class="spinner" style="width:13px;height:13px;border-color:#fff3;border-top-color:#fff" />
          {{ creating ? 'Creating…' : 'Create Agent' }}
        </button>
      </div>
    </div>

    <div v-if="createError" class="edit-error">{{ createError }}</div>

    <div class="edit-page__body">
      <div class="edit-page__left">
        <AgentConfigForm
          ref="configFormRef"
          hide-persona-editor
          :hide-footer="true"
          @submit="handleCreate"
          @cancel="handleCancel"
        />
      </div>

      <!-- Prompt preview -->
      <div class="edit-page__right">
        <div class="prompt-preview">
          <div class="prompt-preview__header">
            <span class="prompt-preview__title">Prompt Preview</span>
            <div class="prompt-preview__header-actions">
              <button
                class="btn btn-ghost btn-sm"
                style="margin-left: auto; font-size: 11px;"
                @click="showMdPreview = !showMdPreview"
              >
                {{ showMdPreview ? 'MD ●' : 'MD ○' }}
              </button>
            </div>
          </div>

          <div class="prompt-pills">
            <!-- SYSTEM pill -->
            <button class="prompt-pill prompt-pill--system" @click="systemExpanded = !systemExpanded">
              <span>[SYSTEM]</span>
              <span class="pill-chevron">{{ systemExpanded ? '▾' : '▸' }}</span>
            </button>
            <div v-if="systemExpanded" class="pill-content">
              <pre
                v-if="!showMdPreview"
                class="dec-code-block dec-code-block--scrollable"
              >{{ liveSystemPrompt }}</pre>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div
                v-else
                class="dec-code-block dec-code-block--scrollable"
                v-html="renderMarkdown(liveSystemPrompt)"
              />
            </div>

            <!-- MARKET DATA pill (placeholder for create) -->
            <button class="prompt-pill prompt-pill--market" disabled style="opacity: 0.4; cursor: default;">
              <span>[MARKET DATA]</span>
              <span style="font-size: 10px; font-weight: 400; text-transform: none; letter-spacing: 0;">&mdash; available after first run</span>
            </button>
          </div>

          <!-- EDITABLE SETUP block -->
          <div class="prompt-section prompt-section--editable">
            <div class="prompt-section__toggle-row">
              <button class="prompt-section__toggle" style="flex:1">
                <span class="prompt-section__label">[EDITABLE SETUP]</span>
              </button>
              <button v-if="!editingSetup" class="btn btn-ghost btn-sm" style="margin-right:8px" @click="startEditingSetup">
                Edit
              </button>
              <button v-else class="btn btn-ghost btn-sm" style="margin-right:8px" @click="stopEditingSetup">
                Done
              </button>
            </div>

            <!-- View mode -->
            <pre
              v-if="!editingSetup && !showMdPreview"
              class="prompt-section__content prompt-section__content--setup"
            >{{ liveEditableSetup }}</pre>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div
              v-else-if="!editingSetup && showMdPreview"
              class="prompt-section__content prompt-section__content--setup"
              v-html="renderMarkdown(liveEditableSetup)"
            />

            <!-- Edit mode -->
            <template v-else>
              <div class="setup-part">
                <div class="setup-part__label">
                  Role
                  <span v-if="isRoleCustomized" class="acf__custom-badge">Custom</span>
                  <span v-else class="setup-part__auto-tag">default</span>
                  <button v-if="isRoleCustomized" type="button" class="btn btn-ghost btn-sm" style="margin-left:8px" @click="resetRole">
                    ↺ Reset
                  </button>
                </div>
                <textarea
                  ref="roleTextareaRef"
                  class="setup-part__textarea"
                  :value="editRoleText"
                  placeholder="Role section markdown…"
                  @input="onRoleTextInput($event)"
                />
              </div>

              <div class="setup-part">
                <div class="setup-part__label">
                  Behavior profile
                  <span v-if="isBehaviorCustomized" class="acf__custom-badge">Custom</span>
                  <span v-else class="setup-part__auto-tag">auto-generated</span>
                  <button v-if="isBehaviorCustomized" type="button" class="btn btn-ghost btn-sm" style="margin-left:8px" @click="resetBehavior">
                    ↺ Reset
                  </button>
                </div>
                <textarea
                  ref="behaviorTextareaRef"
                  class="setup-part__textarea"
                  :value="editBehaviorText"
                  placeholder="Behavior profile markdown…"
                  @input="onBehaviorTextInput($event)"
                />
              </div>

              <div class="setup-part">
                <div class="setup-part__label">
                  Persona
                  <span v-if="isPersonaCustomized" class="acf__custom-badge">Custom</span>
                  <button v-if="isPersonaCustomized" type="button" class="btn btn-ghost btn-sm" style="margin-left:8px" @click="resetPersona">
                    ↺ Reset
                  </button>
                </div>
                <textarea
                  ref="personaTextareaRef"
                  class="setup-part__textarea"
                  :value="editPersonaText"
                  placeholder="Your persona markdown…"
                  @input="onPersonaTextInput($event)"
                />
              </div>

              <div class="setup-part setup-part--readonly">
                <div class="setup-part__label">Constraints <span class="setup-part__auto-tag">auto-generated</span></div>
                <pre
                  v-if="!showMdPreview"
                  class="prompt-section__content"
                >{{ liveConstraintsSection }}</pre>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <div
                  v-else
                  class="prompt-section__content"
                  v-html="renderMarkdown(liveConstraintsSection)"
                />
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.edit-page {
  min-height: 100vh;
  background: var(--bg, #0a0a0a);
  padding: 0 24px 40px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ── Command bar ────────────────────────────────────────────────── */
.edit-bar {
  position: sticky;
  top: 52px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  background: var(--bg, #0a0a0a);
  border-bottom: 1px solid var(--border, #1e1e1e);
}
.edit-bar__back {
  font-size: 13px;
  color: var(--accent, #7c6af7);
  text-decoration: none;
  white-space: nowrap;
  font-family: 'Space Mono', monospace;
}
.edit-bar__back:hover { text-decoration: underline; }
.edit-bar__sep {
  color: var(--border, #333);
  font-size: 14px;
}
.edit-bar__name {
  flex: 1;
  font-size: 13px;
  font-weight: 700;
  color: var(--text, #e0e0e0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Space Mono', monospace;
  letter-spacing: -0.01em;
}
.edit-bar__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.edit-bar__cancel {
  padding: 6px 14px;
  background: none;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  color: #555;
  font-size: 11px;
  font-family: 'Space Mono', monospace;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}
.edit-bar__cancel:hover {
  border-color: #555;
  color: #aaa;
}
.edit-bar__save {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 18px;
  background: #e0e0e0;
  color: #0a0a0a;
  border: none;
  border-radius: 3px;
  font-size: 11px;
  font-family: 'Space Mono', monospace;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}
.edit-bar__save:hover { background: #fff; }
.edit-bar__save:disabled { opacity: 0.35; cursor: not-allowed; }

.edit-error {
  padding: 10px 14px;
  background: color-mix(in srgb, #e55 10%, transparent);
  border: 1px solid color-mix(in srgb, #e55 30%, transparent);
  border-radius: 4px;
  font-size: 12px;
  color: #e55;
}

/* ── Body layout ─────────────────────────────────────────────────── */
.edit-page__body {
  display: flex;
  flex-direction: column;
  gap: 5rem;
  align-items: stretch;
  max-width: 740px;
  margin: 0 auto;
  width: 100%;
}
.edit-page__left {
  position: static;
  max-height: none;
  overflow: visible;
}
.edit-page__right { min-width: 0; }

/* ── Prompt preview ──────────────────────────────────────────── */
.prompt-preview {
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.prompt-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #2a2a2a);
  background: color-mix(in srgb, var(--border, #2a2a2a) 30%, transparent);
  gap: 12px;
}
.prompt-preview__header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.prompt-preview__title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
}

/* ── Prompt sections ─────────────────────────────────────────── */
.prompt-section {
  border-bottom: 1px solid var(--border, #1e1e1e);
}
.prompt-section:last-child { border-bottom: none; }
.prompt-section--editable { flex: 1; }
.prompt-section__toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
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
  border-bottom: 1px solid var(--border, #1e1e1e);
}
.prompt-section__label { flex: 1; }
.prompt-section__content {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary, #aaa);
  padding: 12px 16px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  background: color-mix(in srgb, var(--border, #2a2a2a) 10%, transparent);
}
.prompt-section__content--setup {
  overflow-y: auto;
}

/* Prompt pill rows */
.prompt-pills {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 8px 12px;
}

.prompt-pill {
  display: flex;
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

.pill-chevron {
  flex-shrink: 0;
  font-size: 12px;
}

.pill-content {
  padding: 0 10px 8px 18px;
}

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
.dec-code-block--scrollable {
  overflow-y: auto;
}

/* ── Setup edit parts ────────────────────────────────────────── */
.setup-part {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border, #1e1e1e);
}
.setup-part:last-child { border-bottom: none; }
.setup-part--readonly .prompt-section__content {
  opacity: 0.55;
}
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
.setup-part__textarea:focus {
  border-color: var(--accent, #7c6af7);
}

/* Custom badge */
.acf__custom-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--warning, #f5a623) 15%, transparent);
  color: var(--warning, #f5a623);
  border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 30%, transparent);
}

@media (max-width: 1000px) {
  .edit-page__body {
    max-width: 100%;
  }
}
</style>
