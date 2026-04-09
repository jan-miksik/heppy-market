<script setup lang="ts">
definePageMeta({ ssr: false });
import { buildBehaviorSection, buildConstraintsSection, BASE_AGENT_PROMPT, buildJsonSchemaInstruction, AGENT_ROLE_SECTION } from '@something-in-loop/shared';
import type { CreateAgentPayload } from '~/composables/useAgents';
import AgentConfigForm from '~/components/AgentConfigForm.vue';
import { splitAgentPromptSections } from '~/lib/agent-prompt';
import { escapeHtml, renderMarkdown } from '~/utils/markdown';

const route = useRoute();
const router = useRouter();
const id = computed(() => route.params.id as string);
const { getAgent, updateAgent } = useAgents();
const { request } = useApi();

const agent = ref<Awaited<ReturnType<typeof getAgent>> | null>(null);
const loading = ref(true);
const saving = ref(false);
const saveError = ref('');

// API-fetched prompt sections (static between refreshes)
const previewLoading = ref(true);
const previewError = ref('');
const apiSystemPrompt = ref('');
const apiMarketData = ref('');
const marketDataAt = ref<string | null>(null);
const hasMarketData = ref(false);

const showMdPreview = ref(false);
const showSetupDiff = ref(false);
const promptPreviewExpanded = ref(true);

// Collapsible pill state
const systemExpanded = ref(false);
const marketDataExpanded = ref(false);
const setupExpanded = ref(true);
const editingSetup = ref(false);
const editPersonaText = ref('');
const editBehaviorText = ref('');
const editRoleText = ref('');

const behaviorTextareaRef = ref<HTMLTextAreaElement | null>(null);
const personaTextareaRef = ref<HTMLTextAreaElement | null>(null);
const roleTextareaRef = ref<HTMLTextAreaElement | null>(null);

function autoResize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 20}px`;
}

// Template ref to the form
const configFormRef = ref<InstanceType<typeof AgentConfigForm> | null>(null);

// Live system prompt
const liveSystemPrompt = computed(() => BASE_AGENT_PROMPT + buildJsonSchemaInstruction());
const marketDataPreview = computed(() => {
  const marketData = (apiMarketData.value || '').trim();
  if (marketData) return marketData;
  return `## Portfolio State
Balance: $N/A USDC
Open positions: N/A of N/A max
Max per trade: N/A
Daily P&L: N/A
Total P&L: N/A

## Market Data
### <PAIR>
Price: N/A
5m change: N/A
1h change: N/A
6h change: N/A
24h change: N/A
Volume 24h: N/A
Liquidity: N/A
Short-term (48h hourly):
N/A

## Recent Decisions (last N)
No recent decisions`;
});

// Compute live EDITABLE SETUP from form values
const liveEditableSetup = computed(() => {
  const form = configFormRef.value;
  if (!form) {
    return apiFallbackEditableSetup.value;
  }

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

// Fallback editable setup extracted from API-fetched userPrompt
const apiFallbackEditableSetup = ref('');

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

const setupChanged = computed(() => {
  const prev = (apiFallbackEditableSetup.value || '').trim();
  const next = (liveEditableSetup.value || '').trim();
  return prev.length > 0 && next !== prev;
});

watch(setupChanged, (changed) => {
  if (!changed) showSetupDiff.value = false;
});

type DiffOp = 'equal' | 'insert' | 'delete';

function diffLines(prev: string, next: string): Array<{ op: DiffOp; line: string }> {
  const a = prev.split('\n');
  const b = next.split('\n');

  // LCS DP (line-based). n,m are small-ish here; prompt sections are manageable.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const ai = a[i]!;
      const bj = b[j]!;
      const down = dp[i + 1]![j]!;
      const right = dp[i]![j + 1]!;
      const diag = dp[i + 1]![j + 1]!;
      dp[i]![j] = ai === bj ? diag + 1 : Math.max(down, right);
    }
  }

  const out: Array<{ op: DiffOp; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i]!;
    const bj = b[j]!;
    if (ai === bj) {
      out.push({ op: 'equal', line: ai });
      i++;
      j++;
      continue;
    }
    if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: 'delete', line: ai });
      i++;
    } else {
      out.push({ op: 'insert', line: bj });
      j++;
    }
  }
  while (i < n) { out.push({ op: 'delete', line: a[i++]! }); }
  while (j < m) { out.push({ op: 'insert', line: b[j++]! }); }
  return out;
}

function escapeHtmlPlain(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const setupDiffHtml = computed(() => {
  const prev = (apiFallbackEditableSetup.value || '').trim();
  const next = (liveEditableSetup.value || '').trim();
  if (!prev || prev === next) return '';

  const parts = diffLines(prev, next);
  const lines: string[] = [];
  for (const p of parts) {
    const safe = escapeHtmlPlain(p.line);
    if (p.op === 'equal') lines.push(`<span class="diff-line diff-line--eq">${safe}</span>`);
    if (p.op === 'insert') lines.push(`<span class="diff-line diff-line--add">${safe}</span>`);
    if (p.op === 'delete') lines.push(`<span class="diff-line diff-line--del">${safe}</span>`);
  }
  return lines.join('\n');
});

function parseApiSections(systemFull: string, userFull: string) {
  apiSystemPrompt.value = systemFull;
  const sections = splitAgentPromptSections(userFull);
  apiMarketData.value = sections.marketData;
  apiFallbackEditableSetup.value = sections.editableSetup
    .replace(/\n\nBased on the above data, what is your trading decision\?$/, '')
    .trim();
}

onMounted(async () => {
  try {
    agent.value = await getAgent(id.value);
  } finally {
    loading.value = false;
  }

  try {
    const data = await request<{
      systemPrompt: string;
      userPrompt: string;
      marketDataAt: string | null;
      hasMarketData: boolean;
    }>(`/api/agents/${id.value}/prompt-preview`);
    parseApiSections(data.systemPrompt, data.userPrompt);
    marketDataAt.value = data.marketDataAt;
    hasMarketData.value = data.hasMarketData;
  } catch {
    apiSystemPrompt.value = '';
    apiMarketData.value = '';
  } finally {
    previewLoading.value = false;
  }
});

async function handleRefreshPreview() {
  previewLoading.value = true;
  previewError.value = '';
  try {
    const data = await request<{
      systemPrompt: string;
      userPrompt: string;
      marketDataAt: string | null;
      hasMarketData: boolean;
    }>(`/api/agents/${id.value}/prompt-preview`);
    parseApiSections(data.systemPrompt, data.userPrompt);
    marketDataAt.value = data.marketDataAt;
    hasMarketData.value = data.hasMarketData;
  } catch {
    previewError.value = 'Refresh failed — check connection';
  } finally {
    previewLoading.value = false;
  }
}

async function handleSave(payload: Partial<CreateAgentPayload>) {
  saving.value = true;
  saveError.value = '';
  try {
    await updateAgent(id.value, payload as Parameters<typeof updateAgent>[1]);
    router.push(`/agents/${id.value}`);
  } catch (e: any) {
    saveError.value = extractApiError(e) || 'Save failed';
  } finally {
    saving.value = false;
  }
}

function handleCancel() {
  router.push(`/agents/${id.value}`);
}

// Build initialValues for the form
const editInitialValues = computed(() => {
  if (!agent.value) return undefined;
  const profileId = agent.value.profileId ?? (agent.value.config as { profileId?: string })?.profileId;
  return {
    name: agent.value.name,
    llmModel: agent.value.llmModel,
    pairs: agent.value.config.pairs,
    paperBalance: agent.value.config.paperBalance,
    strategies: agent.value.config.strategies,
    analysisInterval: agent.value.config.analysisInterval,
    maxPositionSizePct: agent.value.config.maxPositionSizePct,
    stopLossPct: agent.value.config.stopLossPct,
    takeProfitPct: agent.value.config.takeProfitPct,
    maxOpenPositions: agent.value.config.maxOpenPositions,
    temperature: agent.value.config.temperature ?? 0.7,
    allowFallback: agent.value.config.allowFallback ?? false,
    profileId: profileId ?? undefined,
    behavior: (agent.value.config as any).behavior,
    personaMd: agent.value.personaMd || undefined,
    behaviorMd: (agent.value.config as any).behaviorMd || undefined,
  };
});

// ── Inline persona editing ────────────────────────────────────────────────

function startEditingSetup() {
  editPersonaText.value = configFormRef.value?.personaMd ?? '';
  editBehaviorText.value = configFormRef.value?.behaviorMd || liveBehaviorSection.value;
  editRoleText.value = configFormRef.value?.roleMd || AGENT_ROLE_SECTION;
  editingSetup.value = true;

  // Wait for textareas to mount before measuring
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
  const value = el.value;

  editPersonaText.value = value;
  if (configFormRef.value) {
    configFormRef.value.personaMd = value;
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
  const value = el.value;

  editBehaviorText.value = value;
  if (configFormRef.value) {
    configFormRef.value.behaviorMd = value;
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
  const value = el.value;

  editRoleText.value = value;
  if (configFormRef.value) {
    configFormRef.value.roleMd = value;
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
</script>

<template>
  <div class="edit-page">
    <div v-if="loading" class="edit-page__loading">Loading…</div>
    <template v-else-if="agent">
      <!-- Sticky command bar -->
      <div class="edit-bar">
        <NuxtLink :to="`/agents/${id}`" class="edit-bar__back">← back</NuxtLink>
        <span class="edit-bar__sep">/</span>
        <span class="edit-bar__name">{{ agent.name }}</span>
        <span v-if="agent.status === 'running'" class="edit-page__running-badge" style="flex-shrink:0">running — changes apply next cycle</span>
        <div class="edit-bar__actions">
          <button type="button" class="edit-bar__cancel" @click="handleCancel">Cancel</button>
          <button
            type="submit"
            form="agent-config-form"
            class="edit-bar__save"
            :disabled="saving"
          >
            <span v-if="saving" class="spinner" style="width:13px;height:13px;border-color:#fff3;border-top-color:#fff" />
            {{ saving ? 'Saving…' : 'Save Changes' }}
          </button>
        </div>
      </div>

      <div v-if="saveError" class="edit-error">{{ saveError }}</div>

      <div class="edit-page__body">
        <div class="edit-page__left">
          <AgentConfigForm
            v-if="editInitialValues"
            ref="configFormRef"
            :initial-values="editInitialValues"
            hide-persona-editor
            :hide-footer="true"
            @submit="handleSave"
            @cancel="handleCancel"
          />
        </div>

        <!-- Prompt preview -->
        <div class="edit-page__right">
          <div class="prompt-preview">
            <button class="prompt-preview__toggle" @click="promptPreviewExpanded = !promptPreviewExpanded">
              <span class="prompt-preview__title">Prompt Preview</span>
              <span class="acf__chevron" :class="{ open: promptPreviewExpanded }">›</span>
            </button>

            <div class="prompt-preview__body" :class="{ open: promptPreviewExpanded }">
              <div class="prompt-preview__body-content">
                <button
                  class="btn btn-ghost btn-sm prompt-preview__md-toggle"
                  @click="showMdPreview = !showMdPreview"
                >
                  {{ showMdPreview ? 'MD ●' : 'MD ○' }}
                </button>
                <div v-if="previewError" class="prompt-preview__error">{{ previewError }}</div>

                <div class="prompt-pills">
                  <!-- SYSTEM pill -->
                  <button class="prompt-pill prompt-pill--system" @click="systemExpanded = !systemExpanded">
                    <span>[SYSTEM]</span>
                    <span class="acf__chevron" :class="{ open: systemExpanded }">›</span>
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

                  <!-- MARKET DATA pill -->
                  <button class="prompt-pill prompt-pill--market" @click="marketDataExpanded = !marketDataExpanded">
                    <span>[MARKET DATA]</span>
                    <span class="acf__chevron" :class="{ open: marketDataExpanded }">›</span>
                  </button>
                  <div v-if="marketDataExpanded" class="pill-content">
                    <pre
                      v-if="!showMdPreview"
                      class="dec-code-block dec-code-block--scrollable"
                    >{{ marketDataPreview }}</pre>
                    <!-- eslint-disable-next-line vue/no-v-html -->
                    <div
                      v-else
                      class="dec-code-block dec-code-block--scrollable"
                      v-html="renderMarkdown(marketDataPreview)"
                    />
                  </div>
                </div>

                <!-- EDITABLE SETUP block (always visible, with inline editor toggle) -->
                <div class="prompt-section prompt-section--editable">
                  <div class="prompt-section__toggle-row">
                    <button class="prompt-section__toggle" style="flex:1" @click="setupExpanded = !setupExpanded">
                      <span class="prompt-section__label">[EDITABLE SETUP]</span>
                      <span v-if="setupChanged" class="prompt-section__edited-badge">edited</span>
                      <span class="acf__chevron" :class="{ open: setupExpanded }">›</span>
                    </button>
                    <button
                      v-if="setupExpanded && !editingSetup && !showMdPreview && setupChanged"
                      class="btn btn-ghost btn-sm"
                      style="margin-right:8px"
                      @click="showSetupDiff = !showSetupDiff"
                    >
                      {{ showSetupDiff ? 'Text' : 'Diff' }}
                    </button>
                    <button v-if="setupExpanded && !editingSetup" class="btn btn-ghost btn-sm" style="margin-right:8px" @click="startEditingSetup">
                      Edit
                    </button>
                    <button v-if="setupExpanded && editingSetup" class="btn btn-ghost btn-sm" style="margin-right:8px" @click="stopEditingSetup">
                      Done
                    </button>
                  </div>

                  <!-- View mode: show full live text -->
                  <pre
                    v-if="setupExpanded && !editingSetup && !showMdPreview && (!setupChanged || !showSetupDiff)"
                    class="prompt-section__content prompt-section__content--setup"
                  >{{ liveEditableSetup }}</pre>
                  <!-- Diff view when edited (prev vs current) -->
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <pre
                    v-else-if="setupExpanded && !editingSetup && !showMdPreview && setupChanged && showSetupDiff"
                    class="prompt-section__content prompt-section__content--setup prompt-section__content--diff"
                    v-html="setupDiffHtml"
                  />
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div
                    v-else-if="setupExpanded && !editingSetup && showMdPreview"
                    class="prompt-section__content prompt-section__content--setup"
                    v-html="renderMarkdown(liveEditableSetup)"
                  />

                  <!-- Edit mode: role, behavior, persona textareas + constraints (read-only) -->
                  <template v-else-if="setupExpanded">
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
      </div>
    </template>
    <div v-else class="edit-page__loading">Agent not found.</div>
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
.edit-page__loading {
  color: var(--text-muted);
  padding: 40px;
  text-align: center;
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

/* Cancel — ghost, typographically present */
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

/* Save — high contrast, sharp, intentional */
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

.edit-page__running-badge {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--warning, #f5a623) 12%, transparent);
  color: var(--warning, #f5a623);
  border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 25%, transparent);
  font-family: 'Space Mono', monospace;
  letter-spacing: 0.03em;
}

.edit-error {
  padding: 10px 14px;
  background: color-mix(in srgb, #e55 10%, transparent);
  border: 1px solid color-mix(in srgb, #e55 30%, transparent);
  border-radius: 4px;
  font-size: 12px;
  color: #e55;
}

/* ── Single-column body ─────────────────────────────────────────── */
.edit-page__body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
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

.prompt-preview__meta {
  font-size: 11px;
  color: var(--text-muted, #444);
  font-family: 'Space Mono', monospace;
}
.prompt-preview__error {
  padding: 16px;
  font-size: 12px;
  color: var(--error, #e05a5a);
}

/* ── Prompt sections ─────────────────────────────────────────── */
.prompt-section {
  border-bottom: 1px solid var(--border, #1e1e1e);
}
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
.prompt-section__live-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 2px 5px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--success, #4caf50) 15%, transparent);
  color: var(--success, #4caf50);
  border: 1px solid color-mix(in srgb, var(--success, #4caf50) 30%, transparent);
  text-transform: uppercase;
  letter-spacing: 0.05em;
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
.prompt-section__content--setup {
  overflow-y: auto;
}
.prompt-section__content--diff {
  white-space: pre;
}
.diff-line {
  display: block;
  position: relative;
  padding: 0 2px 0 16px;
  border-radius: 3px;
}
.diff-line::before {
  position: absolute;
  left: 4px;
  top: 0;
  width: 10px;
  text-align: center;
  opacity: 0.85;
}
.diff-line--add {
  background: color-mix(in srgb, #22c55e 14%, transparent);
  color: color-mix(in srgb, #22c55e 70%, #e0e0e0);
}
.diff-line--add::before { content: '+'; }
.diff-line--del {
  background: color-mix(in srgb, #ef4444 14%, transparent);
  color: color-mix(in srgb, #ef4444 70%, #e0e0e0);
  text-decoration: line-through;
  opacity: 0.9;
}
.diff-line--del::before { content: '−'; }
.diff-line--eq {
  opacity: 0.75;
}
.diff-line--eq::before { content: ' '; }

/* Prompt pill rows */
.prompt-pills {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 8px 12px;
}

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
.acf__chevron.open {
  transform: rotate(90deg);
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
.btn-jump {
  font-size: 9px;
  font-family: 'Space Mono', monospace;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent, #7c6af7);
  background: none;
  border: 1px solid color-mix(in srgb, var(--accent, #7c6af7) 35%, transparent);
  border-radius: 2px;
  padding: 2px 7px;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}
.btn-jump:hover {
  border-color: var(--accent, #7c6af7);
  color: #fff;
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
