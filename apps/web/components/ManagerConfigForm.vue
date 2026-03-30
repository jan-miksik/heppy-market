<script setup lang="ts">
import { AGENT_PROFILES, ENTITY_NAME_MAX_CHARS, SUPPORTED_BASE_PAIRS, getManagerPersonaTemplate } from '@something-in-loop/shared';
import { parse as markedParse } from 'marked';
import type { ProfileItem } from '~/composables/useProfiles';
import { useAuth } from '~/composables/useAuth';
import { splitManagerPromptSections } from '~/lib/manager-prompt';

const props = defineProps<{
  initial?: {
    name?: string;
    llmModel?: string;
    temperature?: number;
    decisionInterval?: string;
    riskParams?: { maxTotalDrawdown: number; maxAgents: number; maxCorrelatedPositions: number };
    behavior?: Record<string, unknown>;
    profileId?: string;
    personaMd?: string;
  };
  isEdit?: boolean;
  managerId?: string;
  onCancel?: () => void;
  hideFooter?: boolean;
}>();

const emit = defineEmits<{
  (e: 'submit', value: {
    name: string;
    llmModel: string;
    temperature: number;
    decisionInterval: string;
    riskParams: { maxTotalDrawdown: number; maxAgents: number; maxCorrelatedPositions: number };
    behavior: Record<string, unknown>;
    profileId?: string;
    personaMd?: string;
  }): void;
}>();

const { user } = useAuth();
const hasOwnKey = computed(() => !!user.value?.openRouterKeySet);
const dropdownModel = ref(props.initial?.llmModel ?? 'nvidia/nemotron-3-super-120b-a12b:free');
const customModel = ref('');

type ModelItem = {
  id: string;
  label: string;
  ctx: string;
  price: string;
  tier: 'free' | 'paid';
  desc?: string;
};

const FREE_MODELS: ModelItem[] = [
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 120B Super', ctx: '262K', price: '$0/$0', tier: 'free', desc: 'default free' },
  { id: 'qwen/qwen3-coder:free', label: 'Qwen3 Coder 480B', ctx: '262K', price: '$0/$0', tier: 'free', desc: 'strong reasoning' },
  { id: 'nvidia/nemotron-nano-9b-v2:free', label: 'Nemotron 9B', ctx: '128K', price: '$0/$0', tier: 'free' },
  { id: 'arcee-ai/trinity-large-preview:free', label: 'Trinity-Large', ctx: '131K', price: '$0/$0', tier: 'free' },
] as const;

const PAID_MODELS = [
  { id: 'google/gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro',        ctx: '2M',   price: '$2/$12' },
  { id: 'anthropic/claude-sonnet-4.6',    label: 'Claude Sonnet 4.6',     ctx: '1M',   price: '$3/$15' },
  { id: 'google/gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite', ctx: '1M', price: '$0.25/$1.50' },
  { id: 'openai/gpt-5.4',                 label: 'GPT-5.4',               ctx: '1M',   price: '$2.50/$15' },
  { id: 'deepseek/deepseek-v3.2',         label: 'DeepSeek V3.2',         ctx: '164K', price: '$0.26/$0.38' },
  { id: 'anthropic/claude-opus-4.6',      label: 'Claude Opus 4.6',       ctx: '200K', price: '$5/$25' },
  { id: 'minimax/minimax-m2.5',           label: 'MiniMax M2.5',          ctx: '196K', price: '$0.20/$1.20' },
  { id: 'mistralai/mistral-small-2603',   label: 'Mistral Small 2603',    ctx: '262K', price: '$0.15/$0.60' },
] as const;

// ─── Model picker (table dropdown) ───────────────────────────────────────────

const modelPickerOpen = ref(false);
const modelQuery = ref('');
const modelPickerRef = ref<HTMLElement | null>(null);

const MODEL_CATALOG = computed<ModelItem[]>(() => {
  const paid = PAID_MODELS.map((m) => ({ ...m, tier: 'paid' as const }));
  return [...FREE_MODELS, ...(hasOwnKey.value ? paid : [])];
});

const selectedModelMeta = computed<ModelItem | null>(() => {
  const id = customModel.value.trim() || dropdownModel.value;
  return MODEL_CATALOG.value.find((m) => m.id === id) ?? null;
});

const filteredModels = computed<ModelItem[]>(() => {
  const q = modelQuery.value.trim().toLowerCase();
  if (!q) return MODEL_CATALOG.value;
  return MODEL_CATALOG.value.filter((m) =>
    (m.label + ' ' + m.id + ' ' + (m.desc ?? '')).toLowerCase().includes(q)
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

// ─── Form state ────────────────────────────────────────────────────────────

const form = reactive({
  name: props.initial?.name ?? '',
  llmModel: props.initial?.llmModel ?? 'nvidia/nemotron-3-super-120b-a12b:free',
  temperature: props.initial?.temperature ?? 0.7,
  decisionInterval: props.initial?.decisionInterval ?? '1h',
  riskParams: {
    maxTotalDrawdown: props.initial?.riskParams?.maxTotalDrawdown ?? 0.2,
    maxAgents: props.initial?.riskParams?.maxAgents ?? 3,
    maxCorrelatedPositions: props.initial?.riskParams?.maxCorrelatedPositions ?? 3,
  },
});

const submitting = ref(false);
const validationError = ref('');

watch(dropdownModel, (val) => { form.llmModel = val; });
watch(customModel, (val) => {
  form.llmModel = val.trim() || dropdownModel.value;
});

// Accordions — all collapsed by default
const finetuneOpen = ref(false);
const personaMdOpen = ref(false);
const managerConfigOpen = ref(false);

const autoNamePrefKey = computed(() =>
  props.isEdit ? 'manager-config:auto-name-enabled:edit' : 'manager-config:auto-name-enabled:create'
);
const syncName = ref(true);
const hasHydratedAutoNamePref = ref(false);

// Profile & persona state
const selectedProfileId = ref<string | null>(props.initial?.profileId ?? null);
const selectedProfileName = ref('');
const selectedProfileDescription = ref('');

const behavior = ref<Record<string, unknown>>(props.initial?.behavior ?? {
  managementStyle: 'balanced',
  riskTolerance: 'moderate',
  diversificationPreference: 'balanced',
  performancePatience: 50,
  creationAggressiveness: 50,
  rebalanceFrequency: 'sometimes',
  philosophyBias: 'mixed',
});

const personaMd = ref(props.initial?.personaMd ?? '');
const isPersonaCustomized = ref(!!props.initial?.personaMd);
const showMdPreview = ref(false);
const systemExpanded = ref(false);
const contextExpanded = ref(false);
const editingSetup = ref(false);

const previewLoading = ref(false);
const previewError = ref('');
const lastPromptText = ref('');
const lastPromptAt = ref<string | null>(null);

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
    previewError.value = 'Prompt preview unavailable — run the manager once';
    lastPromptText.value = '';
    lastPromptAt.value = null;
  } finally {
    previewLoading.value = false;
  }
}

// ─── Behavior → Persona sync helpers ──────────────────────────────────────

function buildBehaviorSummaryMd(b: Record<string, unknown>): string {
  const MGMT: Record<string, string> = { aggressive: 'Aggressive', balanced: 'Balanced', conservative: 'Conservative', passive: 'Passive' };
  const RISK: Record<string, string> = { low: 'Low risk', moderate: 'Moderate', high: 'High risk', extreme: 'Extreme' };
  const DIV: Record<string, string> = { concentrated: 'Concentrated', balanced: 'Balanced', diversified: 'Diversified', hyper_diversified: 'Hyper-diversified' };
  const REBAL: Record<string, string> = { rarely: 'Rarely', sometimes: 'Sometimes', often: 'Often', constantly: 'Constantly' };
  const PHILO: Record<string, string> = { momentum: 'Momentum', value: 'Value', mixed: 'Mixed', contrarian: 'Contrarian' };

  const rows: string[] = [];
  if (b.managementStyle) rows.push(`**Style:** ${MGMT[b.managementStyle as string] ?? b.managementStyle}`);
  if (b.riskTolerance) rows.push(`**Risk:** ${RISK[b.riskTolerance as string] ?? b.riskTolerance}`);
  if (b.diversificationPreference) rows.push(`**Diversification:** ${DIV[b.diversificationPreference as string] ?? b.diversificationPreference}`);
  if (b.rebalanceFrequency) rows.push(`**Rebalancing:** ${REBAL[b.rebalanceFrequency as string] ?? b.rebalanceFrequency}`);
  if (b.philosophyBias) rows.push(`**Philosophy:** ${PHILO[b.philosophyBias as string] ?? b.philosophyBias}`);
  if (typeof b.performancePatience === 'number') rows.push(`**Patience:** ${b.performancePatience}%`);
  if (typeof b.creationAggressiveness === 'number') rows.push(`**Creation aggression:** ${b.creationAggressiveness}%`);

  if (rows.length === 0) return '';
  return `\n\n---\n\n*Behavior summary:*\n\n${rows.join(' · ')}`;
}

function generatePersonaMd() {
  if (!selectedProfileId.value) return;
  const base = getManagerPersonaTemplate(selectedProfileId.value, form.name || 'Manager');
  personaMd.value = base + buildBehaviorSummaryMd(behavior.value);
}

watch(behavior, () => {
  if (!isPersonaCustomized.value && selectedProfileId.value) {
    generatePersonaMd();
  }
}, { deep: true });

function onProfileSelected(profile: ProfileItem) {
  selectedProfileId.value = profile.id;
  selectedProfileName.value = profile.name;
  selectedProfileDescription.value = profile.description;
  behavior.value = { ...profile.behaviorConfig };
  isPersonaCustomized.value = false;
  generatePersonaMd();
  if (syncName.value) form.name = generateName();
}

function onPersonaEdited() {
  isPersonaCustomized.value = true;
  if (syncName.value) form.name = generateName();
}

function restorePersona() {
  isPersonaCustomized.value = false;
  generatePersonaMd();
  if (syncName.value) form.name = generateName();
}

// ─── Name helpers ──────────────────────────────────────────────────────────

const PAID_MODEL_NAMES = Object.fromEntries(PAID_MODELS.map((p) => [p.id, p.label]));
const MODEL_SHORT_NAMES: Record<string, string> = {
  'nvidia/nemotron-3-super-120b-a12b:free': 'Nemotron-120B',
  'qwen/qwen3-coder:free': 'Qwen3-Coder',
  'nvidia/nemotron-nano-9b-v2:free': 'Nemotron-9B',
  'arcee-ai/trinity-large-preview:free': 'Trinity-Large',
  'minimax/minimax-m2.5': 'MiniMax M2.5',
  'mistralai/mistral-small-2603': 'Mistral Small',
  ...PAID_MODEL_NAMES,
};

function shortModelName(modelId: string): string {
  return MODEL_SHORT_NAMES[modelId] ?? modelId.split('/').pop()?.split(':')[0] ?? 'Manager';
}

function generateName(): string {
  const model = shortModelName(form.llmModel);
  const interval = form.decisionInterval;
  const style = isPersonaCustomized.value
    ? 'Custom'
    : selectedProfileName.value || '';
  return style ? `${model} · ${interval} · ${style}` : `${model} · ${interval}`;
}

watch([() => form.llmModel, () => form.decisionInterval, isPersonaCustomized, selectedProfileName], () => {
  if (syncName.value) form.name = generateName();
});

watch(() => form.name, (name) => {
  if (!isPersonaCustomized.value && selectedProfileId.value && personaMd.value) {
    const newPersona = getManagerPersonaTemplate(selectedProfileId.value, name || 'Manager');
    const existingLines = personaMd.value.split('\n');
    const firstLine = newPersona.split('\n')[0] ?? '';
    if (existingLines[0] !== firstLine) {
      existingLines[0] = firstLine;
      personaMd.value = existingLines.join('\n');
    }
  }
});

onMounted(() => {
  try {
    const saved = localStorage.getItem(autoNamePrefKey.value);
    if (saved === 'true') syncName.value = true;
    else if (saved === 'false') syncName.value = false;
    else syncName.value = true; // default ON (including edit mode)
  } catch {
    syncName.value = true;
  } finally {
    hasHydratedAutoNamePref.value = true;
  }

  if (syncName.value && (!props.isEdit || !form.name.trim())) {
    form.name = generateName();
  }
});

watch(syncName, (enabled) => {
  if (!hasHydratedAutoNamePref.value) return;
  try {
    localStorage.setItem(autoNamePrefKey.value, enabled ? 'true' : 'false');
  } catch {
    // ignore storage failures
  }
});

function handleSubmit() {
  validationError.value = '';
  if (!form.name.trim()) {
    validationError.value = 'Manager name is required';
    return;
  }
  if (form.name.length > ENTITY_NAME_MAX_CHARS) {
    validationError.value = `Manager name must be at most ${ENTITY_NAME_MAX_CHARS} characters`;
    return;
  }
  submitting.value = true;
  try {
    emit('submit', {
      ...form,
      riskParams: { ...form.riskParams },
      behavior: behavior.value,
      profileId: selectedProfileId.value ?? undefined,
      personaMd: personaMd.value || undefined,
    });
  } finally {
    submitting.value = false;
  }
}

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

const DEFAULT_FREE_AGENT_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
const FREE_AGENT_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'qwen/qwen3-coder:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'arcee-ai/trinity-large-preview:free',
] as const;
const PAID_CHEAP_AGENT_MODELS = [
  'google/gemini-3.1-flash-lite-preview',
  'deepseek/deepseek-v3.2',
  'minimax/minimax-m2.5',
  'mistralai/mistral-small-2603',
] as const;

const availableAgentModels = computed(() => hasOwnKey.value
  ? [...FREE_AGENT_MODELS, ...PAID_CHEAP_AGENT_MODELS]
  : [...FREE_AGENT_MODELS]
);

const liveSystemPrompt = computed(() => {
  const pairsAllowlist = SUPPORTED_BASE_PAIRS.map((p) => `- "${p}"`).join('\n');
  const modelAllowlist = availableAgentModels.value.map((m) => `- "${m}"`).join('\n');
  const profileAllowlist = AGENT_PROFILES.map((p) => `- "${p.id}" ${p.emoji} ${p.name}: ${p.description}`).join('\n');

  return `You are an Agent Manager overseeing a portfolio of paper trading agents on Base chain DEXes.

## Allowed Trading Pairs
When creating or modifying agents, you MUST choose pairs only from this allowlist:
${pairsAllowlist}

## Allowed Agent Analysis Intervals
When creating or modifying agents, "analysisInterval" MUST be one of:
- "1h"
- "4h"
- "1d"
Do not use unsupported legacy values like "1m", "5m", "15m", "30m", or numeric seconds/minutes.

## Available LLM Models For Agents
Use only these llmModel IDs when creating or modifying agents:
${modelAllowlist}

${hasOwnKey.value
  ? 'The user has OpenRouter connected, so you may use free models and low-cost paid models (up to $3 per 1M tokens).'
  : 'The user has no connected OpenRouter key, so you must use free models only.'}
If unsure, default to "${DEFAULT_FREE_AGENT_MODEL}".

## Available Agent Profiles
When creating agents, pick a profileId that naturally fits your management style and risk tolerance — or combine several across your fleet for diversity. You can also write a fully custom personaMd instead.
${profileAllowlist}

## Instructions
Evaluate each agent's performance and decide what actions to take this cycle.

Valid actions:
- "create_agent": spawn a new agent. Params: name, pairs, llmModel, temperature, analysisInterval (1h|4h|1d), strategies, paperBalance; optional: profileId (from the list above — sets the agent's persona), personaMd (custom markdown persona, overrides profileId), stopLossPct, takeProfitPct, maxPositionSizePct, maxOpenPositions, maxDailyLossPct, cooldownAfterLossMinutes. Choose risk parameters that reflect your own risk tolerance.
- "start_agent": start a stopped or paused agent (provide agentId)
- "pause_agent": pause an underperforming agent (provide agentId)
- "modify_agent": change agent parameters (provide agentId + params). Params can include: name, pairs, llmModel, temperature, analysisInterval (1h|4h|1d), strategies, paperBalance, stopLossPct, takeProfitPct, maxPositionSizePct, maxOpenPositions, personaMd (markdown), profileId, etc.
- "terminate_agent": permanently stop an agent (provide agentId)
- "hold": no action needed (provide agentId, or omit for portfolio-level hold)

IMPORTANT: Respond with ONLY a valid JSON array — no markdown, no explanation.
Each element: { "action": "<action>", "agentId": "<id or omit>", "params": {<optional>}, "reasoning": "<why>" }

Example:
[
  { "action": "hold", "agentId": "agent_001", "reasoning": "Strong performance, no changes needed" },
  { "action": "pause_agent", "agentId": "agent_002", "reasoning": "Drawdown exceeds 15%" }
]`;
});

const liveEditableSetup = computed(() => {
  const parts: string[] = [];
  if (personaMd.value.trim()) {
    parts.push(`## Your Persona\n${personaMd.value.trim()}`);
  }

  const riskSummary = `MaxDrawdown: ${(form.riskParams.maxTotalDrawdown * 100).toFixed(0)}%, MaxAgents: ${form.riskParams.maxAgents}, MaxCorrelated: ${form.riskParams.maxCorrelatedPositions}`;
  parts.push(`## Risk Limits\n${riskSummary}`);

  const b = behavior.value;
  if (b && typeof b === 'object') {
    parts.push(`## Your Management Style
- Risk Tolerance: ${(b as any).riskTolerance} | Management Style: ${(b as any).managementStyle}
- Creation Aggressiveness: ${(b as any).creationAggressiveness}/100 | Performance Patience: ${(b as any).performancePatience}/100
- Diversification: ${(b as any).diversificationPreference} | Rebalance Frequency: ${(b as any).rebalanceFrequency}
- Philosophy: ${(b as any).philosophyBias}`);
  }

  return parts.filter(Boolean).join('\n\n').trim();
});

const apiContext = computed(() => splitManagerPromptSections(lastPromptText.value).context);
const contextNote = computed(() => {
  if (previewLoading.value) return 'loading…';
  if (!props.isEdit) return '— available after first run';
  if (!lastPromptText.value) return '— run manager to populate';
  return lastPromptAt.value ? `— last run ${new Date(lastPromptAt.value).toLocaleString()}` : '— last run';
});

onMounted(() => {
  if (props.isEdit && props.managerId) {
    loadPromptPreview();
  }
});
</script>

<template>
  <form id="manager-config-form" class="mcf" @submit.prevent="handleSubmit">
    <div v-if="validationError" class="alert alert-error">{{ validationError }}</div>

    <!-- Name -->
    <div class="mcf__name-row">
      <input
        v-model="form.name"
        class="mcf__name-input"
        placeholder="Manager name…"
        :maxlength="ENTITY_NAME_MAX_CHARS"
        required
        @input="syncName = false"
      />
      <div class="mcf__name-count">{{ form.name.length }}/{{ ENTITY_NAME_MAX_CHARS }}</div>
      <label class="mcf__sync-check">
        <input v-model="syncName" type="checkbox" />
        <span>auto-name</span>
      </label>
    </div>

    <div class="mcf__section">
      <div class="mcf__section-label">LLM model</div>
      <div class="form-group">
        <div ref="modelPickerRef" class="model-picker">
          <button
            type="button"
            class="model-picker__btn form-select"
            :aria-expanded="modelPickerOpen ? 'true' : 'false'"
            aria-haspopup="dialog"
            @click="modelPickerOpen = !modelPickerOpen"
          >
            <span class="model-picker__btn-left">
              <span class="model-picker__btn-label">{{ selectedModelMeta?.label ?? (customModel.trim() || dropdownModel) }}</span>
              <span class="model-picker__btn-sub">
                <span class="model-picker__mono">{{ customModel.trim() || dropdownModel }}</span>
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
                v-for="m in filteredModels"
                :key="m.id"
                type="button"
                class="model-picker__row"
                :class="{ active: (customModel.trim() || dropdownModel) === m.id }"
                @click="selectModel(m.id)"
              >
                <div class="model-picker__cell model-picker__model">
                  <div class="model-picker__model-label">{{ m.label }}</div>
                  <div class="model-picker__model-id">{{ m.id }}</div>
                  <div v-if="m.desc" class="model-picker__model-desc">{{ m.desc }}</div>
                </div>
                <div class="model-picker__cell model-picker__mono">{{ m.ctx }}</div>
                <div class="model-picker__cell model-picker__mono">{{ m.price }}</div>
                <div class="model-picker__cell">
                  <span class="model-picker__pill" :data-tier="m.tier">{{ m.tier }}</span>
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
            placeholder="Or type any model ID..."
          />
          <a
            href="https://openrouter.ai/models"
            target="_blank"
            rel="noopener"
            class="model-browse-link"
          >Browse all models at openrouter.ai/models ↗</a>
        </template>
        <p v-else class="model-nudge">
          <NuxtLink to="/settings">Connect your OpenRouter key</NuxtLink> to unlock paid models.
        </p>
      </div>
    </div>

    <!-- Persona style -->
    <div class="mcf__section">
      <div class="mcf__section-label">
        Persona style
        <span v-if="isPersonaCustomized" class="mcf__custom-badge">✎ Custom</span>
      </div>
      <BehaviorProfilePicker v-model="selectedProfileId" type="manager" @profile-selected="onProfileSelected" />
      <div v-if="selectedProfileDescription && !isPersonaCustomized" class="mcf__profile-desc">
        {{ selectedProfileDescription }}
      </div>
    </div>

    <!-- Fine-tune Behavior accordion -->
    <div class="mcf__accordion">
      <button type="button" class="mcf__accordion-btn" @click="finetuneOpen = !finetuneOpen">
        <span>Fine-tune Behavior</span>
        <span class="mcf__chevron" :class="{ open: finetuneOpen }">›</span>
      </button>
      <div class="mcf__accordion-body" :class="{ open: finetuneOpen }">
        <div v-if="isPersonaCustomized" class="mcf__lock-banner">
          <span>Persona MD was manually edited — behavior sync paused.</span>
          <button type="button" class="btn btn-ghost btn-sm" @click="restorePersona">
            Restore auto-persona
          </button>
        </div>
        <div :class="{ 'mcf__locked-content': isPersonaCustomized }">
          <BehaviorSettingsForm v-model="behavior" type="manager" />
        </div>
      </div>
    </div>

    <div class="mcf__accordion">
      <button type="button" class="mcf__accordion-btn" @click="managerConfigOpen = !managerConfigOpen">
        <span>Manager config</span>
        <span class="mcf__chevron" :class="{ open: managerConfigOpen }">›</span>
      </button>
      <div class="mcf__accordion-body" :class="{ open: managerConfigOpen }">
        <div class="mcf__config">
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">Decision Interval</label>
              <select v-model="form.decisionInterval" class="form-select">
                <option value="1h">Every 1 hour</option>
                <option value="4h">Every 4 hours</option>
                <option value="1d">Every 24 hours</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Temperature</label>
              <input
                v-model.number="form.temperature"
                class="form-range"
                type="range"
                min="0"
                max="1"
                step="0.05"
              />
              <div class="mcf__range-inline">{{ form.temperature.toFixed(2) }}</div>
            </div>
          </div>

          <div class="mcf__risk">
            <div class="mcf__risk-title">Risk Parameters</div>
            <div class="grid-3">
              <div class="form-group" style="margin-bottom: 0;">
                <label class="form-label">
                  Max Drawdown
                  <span class="mcf__range-val">{{ (form.riskParams.maxTotalDrawdown * 100).toFixed(0) }}%</span>
                </label>
                <input v-model.number="form.riskParams.maxTotalDrawdown" class="form-range" type="range" min="0.01" max="1" step="0.01" />
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label class="form-label">
                  Max Agents
                  <span class="mcf__range-val">{{ form.riskParams.maxAgents }}</span>
                </label>
                <input v-model.number="form.riskParams.maxAgents" class="form-range" type="range" min="1" max="20" step="1" />
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label class="form-label">
                  Max Correlated
                  <span class="mcf__range-val">{{ form.riskParams.maxCorrelatedPositions }}</span>
                </label>
                <input v-model.number="form.riskParams.maxCorrelatedPositions" class="form-range" type="range" min="1" max="10" step="1" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Prompt preview (last section, same format as agent pages) -->
    <div class="mcf__prompt-preview">
      <div class="mcf__prompt-header">
        <span class="mcf__prompt-title">Prompt Preview</span>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          style="font-size: 11px;"
          @click.prevent.stop="showMdPreview = !showMdPreview"
        >
          {{ showMdPreview ? 'MD ●' : 'MD ○' }}
        </button>
      </div>

      <div v-if="previewError" class="mcf__prompt-error">{{ previewError }}</div>

      <div class="mcf__prompt-pills">
        <button type="button" class="mcf__prompt-pill mcf__prompt-pill--system" @click="systemExpanded = !systemExpanded">
          <span>[SYSTEM]</span>
          <span class="mcf__pill-chevron">{{ systemExpanded ? '▾' : '▸' }}</span>
        </button>
        <div v-if="systemExpanded" class="mcf__pill-content">
          <pre v-if="!showMdPreview" class="mcf__code-block">{{ liveSystemPrompt }}</pre>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-else class="mcf__code-block mcf__code-block--md" v-html="renderMarkdown(liveSystemPrompt)" />
        </div>

        <button
          type="button"
          class="mcf__prompt-pill mcf__prompt-pill--market"
          :disabled="!managerId"
          @click="contextExpanded = !contextExpanded"
        >
          <span>[PORTFOLIO CONTEXT]</span>
          <span class="mcf__prompt-pill-meta">
            <span class="mcf__prompt-pill-note">{{ contextNote }}</span>
            <span v-if="managerId" class="mcf__pill-chevron">{{ contextExpanded ? '▾' : '▸' }}</span>
          </span>
        </button>
        <div v-if="contextExpanded" class="mcf__pill-content">
          <pre v-if="!showMdPreview" class="mcf__code-block">{{ apiContext || '(No runtime context yet — run the manager at least once to populate the preview)' }}</pre>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div
            v-else
            class="mcf__code-block mcf__code-block--md"
            v-html="renderMarkdown(apiContext || '(No runtime context yet — run the manager at least once to populate the preview)')"
          />
        </div>
      </div>

      <div class="mcf__editable-setup">
        <div class="mcf__editable-setup-row">
          <span class="mcf__editable-label">[EDITABLE SETUP]</span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            style="font-size: 11px;"
            @click="editingSetup = !editingSetup"
          >
            {{ editingSetup ? 'Done' : 'Edit' }}
          </button>
        </div>

        <template v-if="editingSetup">
          <div class="mcf__persona-wrap">
            <PersonaEditor v-model="personaMd" :show-actions="false" @edited="onPersonaEdited" />
            <div v-if="isPersonaCustomized" class="mcf__restore-row">
              <button type="button" class="btn btn-ghost btn-sm" @click="restorePersona">
                ↺ Restore auto-persona
              </button>
            </div>
          </div>
        </template>
        <template v-else>
          <pre v-if="!showMdPreview" class="mcf__code-block">{{ liveEditableSetup }}</pre>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-else class="mcf__code-block mcf__code-block--md" v-html="renderMarkdown(liveEditableSetup)" />
        </template>
      </div>
    </div>

    <!-- Footer -->
    <div v-if="!hideFooter" class="mcf__footer">
      <button v-if="onCancel" type="button" class="btn btn-ghost" @click="onCancel">Cancel</button>
      <button type="submit" class="btn btn-primary" :disabled="submitting">
        <span v-if="submitting" class="spinner" style="width:14px;height:14px;" />
        {{ isEdit ? 'Save Changes' : 'Create Manager' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.mcf {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.mcf__name-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mcf__name-input {
  flex: 1;
  background: var(--surface, #141414);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text, #e0e0e0);
  outline: none;
  transition: border-color 0.15s;
}
.mcf__name-input:focus { border-color: var(--accent, #7c6af7); }
.mcf__name-count {
  font-size: 11px;
  color: var(--text-muted, #555);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.mcf__sync-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted, #555);
  cursor: pointer;
  white-space: nowrap;
}

.mcf__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mcf__section--compact {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 10px;
  padding: 14px 16px;
}
.mcf__section-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
  display: flex;
  align-items: center;
  gap: 8px;
}
.mcf__profile-desc {
  font-size: 12px;
  color: var(--text-secondary, #888);
  line-height: 1.5;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--accent, #7c6af7) 6%, transparent);
  border-left: 2px solid var(--accent, #7c6af7);
  border-radius: 0 6px 6px 0;
}

.mcf__custom-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--warning, #f5a623) 15%, transparent);
  color: var(--warning, #f5a623);
  border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 30%, transparent);
  text-transform: none;
  letter-spacing: 0;
}

.mcf__accordion {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 10px;
  overflow: hidden;
}
.mcf__accordion-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 16px;
  background: color-mix(in srgb, var(--border, #2a2a2a) 30%, transparent);
  border: none;
  color: var(--text, #e0e0e0);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
  text-align: left;
  gap: 8px;
}
.mcf__accordion-btn:hover {
  background: color-mix(in srgb, var(--border, #2a2a2a) 50%, transparent);
}
.mcf__acc-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}
.mcf__acc-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.mcf__hint-chip {
  font-size: 10px;
  font-weight: 400;
  color: var(--text-muted, #444);
  background: color-mix(in srgb, var(--border, #2a2a2a) 60%, transparent);
  padding: 2px 7px;
  border-radius: 4px;
}
.mcf__chevron {
  font-size: 18px;
  color: var(--text-muted, #555);
  transition: transform 0.2s;
  display: inline-block;
  transform: rotate(0deg);
}
.mcf__chevron.open { transform: rotate(90deg); }

.mcf__accordion-body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}
.mcf__accordion-body.open {
  max-height: 2000px;
}

.mcf__lock-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  background: color-mix(in srgb, var(--warning, #f5a623) 8%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--warning, #f5a623) 18%, transparent);
  font-size: 12px;
  color: var(--text-muted, #888);
  flex-wrap: wrap;
}
.mcf__locked-content {
  opacity: 0.4;
  pointer-events: none;
  user-select: none;
}

.mcf__persona-wrap {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mcf__restore-row {
  display: flex;
  justify-content: flex-end;
}

.mcf__prompt-preview {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 10px;
  overflow: hidden;
  background: color-mix(in srgb, var(--surface, #141414) 94%, black);
}
.mcf__prompt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border, #2a2a2a);
  background: color-mix(in srgb, var(--border, #2a2a2a) 22%, transparent);
}
.mcf__prompt-error {
  padding: 10px 14px;
  background: color-mix(in srgb, #e55 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, #e55 30%, transparent);
  font-size: 12px;
  color: #e55;
}
.mcf__prompt-title {
  font-size: 13px;
  font-weight: 650;
  color: var(--text, #e0e0e0);
}
.mcf__prompt-pills {
  padding: 10px 12px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mcf__prompt-pill {
  width: 100%;
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--text-muted, #888);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-family: var(--font-mono, monospace);
  padding: 4px 2px;
  text-align: left;
  cursor: pointer;
}
.mcf__prompt-pill--system { color: var(--text-muted, #888); }
.mcf__prompt-pill--market { color: #f59e0b; }
.mcf__prompt-pill:disabled {
  opacity: 0.55;
  cursor: default;
}
.mcf__prompt-pill-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.mcf__pill-chevron {
  font-size: 12px;
  flex-shrink: 0;
}
.mcf__prompt-pill-note {
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}
.mcf__pill-content {
  padding: 0 0 4px 10px;
}
.mcf__editable-setup {
  border-top: 1px solid var(--border, #2a2a2a);
  margin-top: 8px;
}
.mcf__editable-setup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 8px;
}
.mcf__editable-label {
  color: #60a5fa;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-family: var(--font-mono, monospace);
}
.mcf__code-block {
  margin: 0;
  padding: 8px 12px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text, #e0e0e0);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, monospace);
}
.mcf__code-block--md :deep(p) { margin: 0 0 6px; }
.mcf__code-block--md :deep(ul) { margin: 4px 0; padding-left: 16px; }
.mcf__code-block--md :deep(li) { margin-bottom: 2px; }
.mcf__code-block--md :deep(h1),
.mcf__code-block--md :deep(h2),
.mcf__code-block--md :deep(h3) { margin: 6px 0 2px; font-size: 12px; font-weight: 700; }

.mcf__config {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.mcf__risk {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 8px;
  padding: 14px 16px;
}
.mcf__risk-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
  margin-bottom: 14px;
}
.mcf__range-val {
  color: var(--text-muted, #555);
  font-weight: 400;
  margin-left: 4px;
}
.mcf__range-inline {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-muted, #666);
  font-family: 'JetBrains Mono', monospace;
}

.form-range {
  width: 100%;
  accent-color: var(--accent);
  cursor: pointer;
  margin-top: 4px;
}

.mcf__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
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
.model-nudge a { color: var(--accent, #7c6af7); }

/* Model picker — table dropdown (shared with AgentConfigForm) */
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

.model-picker__empty {
  padding: 14px 12px;
  font-size: 12px;
  color: var(--text-muted, #666);
}
</style>
