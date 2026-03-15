<script setup lang="ts">
definePageMeta({ ssr: false });
import { buildBehaviorSection, buildConstraintsSection } from '@dex-agents/shared';
import type { CreateAgentPayload } from '~/composables/useAgents';
import AgentConfigForm from '~/components/AgentConfigForm.vue';

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

// Collapsible pill state
const systemExpanded = ref(false);
const marketDataExpanded = ref(false);
const editingSetup = ref(false);
const editPersonaText = ref('');

// Template ref to the form
const configFormRef = ref<InstanceType<typeof AgentConfigForm> | null>(null);

// Compute live EDITABLE SETUP from form values
const liveEditableSetup = computed(() => {
  const form = configFormRef.value;
  if (!form) {
    // Fallback to API-fetched editable setup before form is mounted
    return apiFallbackEditableSetup.value;
  }

  const behaviorSection = buildBehaviorSection(form.behavior as any);
  const personaSection = form.personaMd ? '## Your Persona\n' + form.personaMd : '';
  const constraintsSection = buildConstraintsSection({
    pairs: form.form.pairs ?? [],
    maxPositionSizePct: form.form.maxPositionSizePct ?? 5,
    maxOpenPositions: form.form.maxOpenPositions ?? 3,
    stopLossPct: form.form.stopLossPct ?? 5,
    takeProfitPct: form.form.takeProfitPct ?? 7,
  });

  return [behaviorSection, personaSection, constraintsSection].filter(Boolean).join('\n\n');
});

// Fallback editable setup extracted from API-fetched userPrompt
const apiFallbackEditableSetup = ref('');

// Split sections from API userPrompt
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
    maxPositionSizePct: form.form.maxPositionSizePct ?? 5,
    maxOpenPositions: form.form.maxOpenPositions ?? 3,
    stopLossPct: form.form.stopLossPct ?? 5,
    takeProfitPct: form.form.takeProfitPct ?? 7,
  });
});

const isPersonaCustomized = computed(() => configFormRef.value?.isPersonaCustomized ?? false);

function parseApiSections(systemFull: string, userFull: string) {
  // SYSTEM: everything in systemPrompt
  apiSystemPrompt.value = systemFull;

  // MARKET DATA: from ## Portfolio State up to ## Your Behavior Profile (or ## Your Persona or ## Constraints)
  const portfolioIdx = userFull.indexOf('## Portfolio State');
  const behaviorIdx = userFull.indexOf('## Your Behavior Profile');
  const personaIdx = userFull.indexOf('## Your Persona');
  const constraintsIdx = userFull.indexOf('## Constraints');

  const candidates = [behaviorIdx, personaIdx, constraintsIdx].filter(i => i >= 0);
  const editableStart = candidates.length > 0 ? Math.min(...candidates) : -1;

  if (portfolioIdx >= 0) {
    const marketEnd = editableStart >= 0 ? editableStart : userFull.length;
    apiMarketData.value = userFull.slice(portfolioIdx, marketEnd).trim();
  }

  // EDITABLE SETUP fallback (used before form mounts)
  if (editableStart >= 0) {
    apiFallbackEditableSetup.value = userFull.slice(editableStart).trim();
  }
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
    }>(`/agents/${id.value}/prompt-preview`);
    parseApiSections(data.systemPrompt, data.userPrompt);
    marketDataAt.value = data.marketDataAt;
    hasMarketData.value = data.hasMarketData;
  } catch {
    previewError.value = 'Failed to load prompt preview';
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
    }>(`/agents/${id.value}/prompt-preview`);
    parseApiSections(data.systemPrompt, data.userPrompt);
    marketDataAt.value = data.marketDataAt;
    hasMarketData.value = data.hasMarketData;
  } catch {
    previewError.value = 'Failed to refresh preview';
  } finally {
    previewLoading.value = false;
  }
}

async function handleSave(payload: CreateAgentPayload) {
  saving.value = true;
  saveError.value = '';
  try {
    await updateAgent(id.value, payload as Parameters<typeof updateAgent>[1]);
    router.push(`/agents/${id.value}`);
  } catch (e: any) {
    saveError.value = e?.message ?? 'Save failed';
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
    autonomyLevel: agent.value.autonomyLevel,
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
  };
});

// ── Inline persona editing ────────────────────────────────────────────────

function startEditingSetup() {
  editPersonaText.value = configFormRef.value?.personaMd ?? '';
  editingSetup.value = true;
}

function stopEditingSetup() {
  editingSetup.value = false;
}

function onPersonaTextInput(value: string) {
  editPersonaText.value = value;
  if (configFormRef.value) {
    configFormRef.value.personaMd = value;
    configFormRef.value.isPersonaCustomized = true;
  }
}

function resetPersona() {
  if (configFormRef.value) {
    configFormRef.value.restorePersona();
    editPersonaText.value = configFormRef.value.personaMd ?? '';
  }
}
</script>

<template>
  <div class="edit-page">
    <div v-if="loading" class="edit-page__loading">Loading…</div>
    <template v-else-if="agent">
      <!-- Header -->
      <div class="edit-page__header">
        <NuxtLink :to="`/agents/${id}`" class="edit-page__back">← Back to agent</NuxtLink>
        <h1 class="edit-page__title">Edit · {{ agent.name }}</h1>
        <span v-if="agent.status === 'running'" class="edit-page__running-badge">running — changes apply next cycle</span>
      </div>

      <div class="edit-page__body">
        <!-- Left: Config form -->
        <div class="edit-page__left">
          <AgentConfigForm
            v-if="editInitialValues"
            ref="configFormRef"
            :initial-values="editInitialValues"
            hide-persona-editor
            @submit="handleSave"
            @cancel="handleCancel"
          />
          <div v-if="saveError" class="alert alert-error" style="margin-top:12px">{{ saveError }}</div>
        </div>

        <!-- Right: Prompt preview -->
        <div class="edit-page__right">
          <div class="prompt-preview">
            <div class="prompt-preview__header">
              <span class="prompt-preview__title">Prompt Preview</span>
              <div class="prompt-preview__header-actions">
                <span v-if="marketDataAt" class="prompt-preview__meta">
                  market data from {{ new Date(marketDataAt).toLocaleTimeString() }}
                </span>
                <button class="btn btn-ghost btn-sm" :disabled="previewLoading" @click="handleRefreshPreview">
                  <span v-if="previewLoading" class="spinner" style="width:12px;height:12px;" />
                  <span v-else>↻ Refresh</span>
                </button>
              </div>
            </div>

            <div v-if="previewError" class="prompt-preview__error">{{ previewError }}</div>

            <!-- SYSTEM pill -->
            <div class="prompt-section">
              <button class="prompt-section__toggle" @click="systemExpanded = !systemExpanded">
                <span class="prompt-section__label">[SYSTEM]</span>
                <span class="prompt-section__chevron" :class="{ open: systemExpanded }">›</span>
              </button>
              <pre v-if="systemExpanded" class="prompt-section__content">{{ apiSystemPrompt || '(loading…)' }}</pre>
            </div>

            <!-- MARKET DATA pill -->
            <div class="prompt-section">
              <button class="prompt-section__toggle" @click="marketDataExpanded = !marketDataExpanded">
                <span class="prompt-section__label">[MARKET DATA]</span>
                <span v-if="!hasMarketData" class="prompt-section__hint">no data yet — run agent first</span>
                <span class="prompt-section__chevron" :class="{ open: marketDataExpanded }">›</span>
              </button>
              <pre v-if="marketDataExpanded" class="prompt-section__content">{{ apiMarketData || '(no market data)' }}</pre>
            </div>

            <!-- EDITABLE SETUP pill -->
            <div class="prompt-section prompt-section--editable">
              <div class="prompt-section__toggle-row">
                <button class="prompt-section__toggle" style="flex:1" @click="marketDataExpanded = false">
                  <span class="prompt-section__label">[EDITABLE SETUP]</span>
                  <span class="prompt-section__live-badge">live</span>
                </button>
                <button v-if="!editingSetup" class="btn btn-ghost btn-sm" style="margin-right:8px" @click="startEditingSetup">
                  Edit
                </button>
                <button v-else class="btn btn-ghost btn-sm" style="margin-right:8px" @click="stopEditingSetup">
                  Done
                </button>
              </div>

              <!-- View mode: show full live text -->
              <pre v-if="!editingSetup" class="prompt-section__content prompt-section__content--setup">{{ liveEditableSetup }}</pre>

              <!-- Edit mode: behavior (read-only), persona textarea, constraints (read-only) -->
              <template v-else>
                <!-- Behavior section (auto-generated, read-only) -->
                <div class="setup-part setup-part--readonly">
                  <div class="setup-part__label">Behavior profile <span class="setup-part__auto-tag">auto-generated</span></div>
                  <pre class="prompt-section__content">{{ liveBehaviorSection }}</pre>
                </div>

                <!-- Persona section (editable) -->
                <div class="setup-part">
                  <div class="setup-part__label">
                    Persona
                    <span v-if="isPersonaCustomized" class="acf__custom-badge">Custom</span>
                    <button v-if="isPersonaCustomized" type="button" class="btn btn-ghost btn-sm" style="margin-left:8px" @click="resetPersona">
                      ↺ Reset
                    </button>
                  </div>
                  <textarea
                    class="setup-part__textarea"
                    :value="editPersonaText"
                    placeholder="Your persona markdown…"
                    @input="onPersonaTextInput(($event.target as HTMLTextAreaElement).value)"
                  />
                </div>

                <!-- Constraints section (auto-generated, read-only) -->
                <div class="setup-part setup-part--readonly">
                  <div class="setup-part__label">Constraints <span class="setup-part__auto-tag">auto-generated</span></div>
                  <pre class="prompt-section__content">{{ liveConstraintsSection }}</pre>
                </div>
              </template>
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
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 1400px;
  margin: 0 auto;
}
.edit-page__loading {
  color: var(--text-muted);
  padding: 40px;
  text-align: center;
}
.edit-page__header {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.edit-page__back {
  color: var(--accent, #7c6af7);
  font-size: 13px;
  text-decoration: none;
}
.edit-page__back:hover { text-decoration: underline; }
.edit-page__title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
  margin: 0;
}
.edit-page__running-badge {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--warning, #f5a623) 12%, transparent);
  color: var(--warning, #f5a623);
  border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 25%, transparent);
}
.edit-page__body {
  display: grid;
  grid-template-columns: 420px 1fr;
  gap: 24px;
  align-items: start;
}
.edit-page__left {
  position: sticky;
  top: 24px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}
.edit-page__right { min-width: 0; }

/* ── Prompt preview ──────────────────────────────────────────── */
.prompt-preview {
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 12px;
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
.prompt-preview__meta {
  font-size: 11px;
  color: var(--text-muted, #444);
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
.prompt-section__hint {
  font-size: 10px;
  font-weight: 400;
  color: var(--text-muted, #444);
}
.prompt-section__live-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 2px 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--success, #4caf50) 15%, transparent);
  color: var(--success, #4caf50);
  border: 1px solid color-mix(in srgb, var(--success, #4caf50) 30%, transparent);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.prompt-section__chevron {
  font-size: 16px;
  transition: transform 0.2s;
}
.prompt-section__chevron.open { transform: rotate(90deg); }
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
  max-height: 500px;
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
  min-height: 180px;
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 6px;
  padding: 10px 12px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text, #e0e0e0);
  resize: vertical;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
}
.setup-part__textarea:focus {
  border-color: var(--accent, #7c6af7);
}

/* Custom badge (reused from AgentConfigForm) */
.acf__custom-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--warning, #f5a623) 15%, transparent);
  color: var(--warning, #f5a623);
  border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 30%, transparent);
}

@media (max-width: 900px) {
  .edit-page__body { grid-template-columns: 1fr; }
  .edit-page__left { position: static; max-height: none; }
}
</style>
