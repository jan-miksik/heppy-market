<script setup lang="ts">
import {
  AGENT_PAID_MODEL_ITEMS,
  DEFAULT_FREE_AGENT_MODEL,
  ENTITY_NAME_MAX_CHARS,
  buildAgentModelCatalog,
  getAgentPersonaTemplate,
  resolveAgentProfileId,
  type ModelCatalogItem,
} from '@something-in-loop/shared';
import type { CreateAgentPayload } from '~/composables/useAgents';
import type { ProfileItem } from '~/composables/useProfiles';
import { useAuth } from '~/composables/useAuth';

const { user } = useAuth();
const { initConnect } = useOpenRouter();
const route = useRoute();
const isTester = computed(() => user.value?.role === 'tester');
const openRouterRedirecting = ref(false);

const hasOwnKey = computed(() => !!user.value?.openRouterKeySet);
const dropdownModel = ref<string>(DEFAULT_FREE_AGENT_MODEL);
const customModel = ref('');
// Keep form.llmModel in sync: custom input overrides dropdown; clearing restores dropdown value.
watch(dropdownModel, (val) => { form.llmModel = val; });
watch(customModel, (val) => {
  form.llmModel = val.trim() || dropdownModel.value;
});

// ─── Model picker (table dropdown) ───────────────────────────────────────────

const modelPickerOpen = ref(false);
const modelQuery = ref('');
const modelPickerRef = ref<HTMLElement | null>(null);

const MODEL_CATALOG = computed<ModelCatalogItem[]>(() => {
  return buildAgentModelCatalog({
    hasOwnOpenRouterKey: hasOwnKey.value,
    isTester: isTester.value,
  });
});

const selectedModelMeta = computed<ModelCatalogItem | null>(() => {
  const id = customModel.value.trim() || dropdownModel.value;
  return MODEL_CATALOG.value.find((m) => m.id === id) ?? null;
});

const filteredModels = computed<ModelCatalogItem[]>(() => {
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

const props = defineProps<{
  initialValues?: Partial<CreateAgentPayload & { pairs: string[] }>;
  hidePersonaEditor?: boolean;
  hideFooter?: boolean;
  hideBalanceInput?: boolean;
}>();

const emit = defineEmits<{
  submit: [payload: Partial<CreateAgentPayload>];
  cancel: [];
}>();

const isEditing = computed(() => !!props.initialValues);

const form = reactive<CreateAgentPayload & { pairs: string[] }>({
  name: '',
  pairs: ['WETH/USDC'],
  paperBalance: 1000,
  strategies: ['combined'],
  analysisInterval: '1h',
  maxPositionSizePct: 2,
  stopLossPct: 2,
  takeProfitPct: 3,
  maxOpenPositions: 3,
  llmModel: DEFAULT_FREE_AGENT_MODEL,
  allowFallback: false,
  temperature: 0.7,
});

const submitting = ref(false);
const validationError = ref('');
const initialSubmitPayload = ref<CreateAgentPayload | null>(null);

// Accordions — all collapsed by default
const configOpen = ref(false);
const finetuneOpen = ref(false);
const personaMdOpen = ref(false);

// Profile & persona state
const selectedProfileId = ref<string | null>(null);
const selectedProfileName = ref('');
const selectedProfileDescription = ref('');

const behavior = ref<Record<string, unknown>>({
  riskAppetite: 'moderate',
  fomoProne: 30,
  panicSellThreshold: 50,
  contrarian: 20,
  analysisDepth: 'balanced',
  decisionSpeed: 'measured',
  confidenceThreshold: 60,
  overthinker: false,
  style: 'swing',
  preferredConditions: 'any',
  entryPreference: 'momentum',
  exitStrategy: 'signal_based',
  averageDown: false,
  verbosity: 'normal',
  personality: 'professional',
  emotionalAwareness: false,
  defaultBias: 'neutral',
  adaptability: 50,
  memoryWeight: 'medium',
});

const personaMd = ref('');
const isPersonaCustomized = ref(false);
const behaviorMd = ref('');
const isBehaviorCustomized = ref(false);
const roleMd = ref('');
const isRoleCustomized = ref(false);

// ─── Behavior → Persona sync helpers ──────────────────────────────────────

function generatePersonaMd() {
  if (!selectedProfileId.value) return;
  personaMd.value = getAgentPersonaTemplate(selectedProfileId.value, form.name || 'Agent');
}

// Watch behavior deeply — regenerate persona if not manually customized
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
  if (syncNameWithModel.value) form.name = generateName();
}

function onPersonaEdited() {
  isPersonaCustomized.value = true;
  if (syncNameWithModel.value) form.name = generateName();
}

function restorePersona() {
  isPersonaCustomized.value = false;
  generatePersonaMd();
  if (syncNameWithModel.value) form.name = generateName();
}

function restoreBehavior() {
  behaviorMd.value = '';
  isBehaviorCustomized.value = false;
}

// ─── Name helpers ──────────────────────────────────────────────────────────

const AVAILABLE_PAIRS = ['WETH/USDC', 'cbBTC/USDC', 'AERO/WETH'] as const;

function togglePair(p: string) {
  form.pairs = form.pairs.includes(p) ? form.pairs.filter((x) => x !== p) : [...form.pairs, p];
}

function shortModelName(m: string): string {
  const PAID_MODEL_NAMES = Object.fromEntries(AGENT_PAID_MODEL_ITEMS.map((p) => [p.id, p.label]));
  const n: Record<string, string> = {
    [DEFAULT_FREE_AGENT_MODEL]: 'Nemotron-120B',
    'qwen/qwen3-coder:free': 'Qwen3-Coder',
    'nvidia/nemotron-nano-9b-v2:free': 'Nemotron-9B',
    'arcee-ai/trinity-large-preview:free': 'Trinity-Large',
    'minimax/minimax-m2.5': 'MiniMax M2.5',
    'mistralai/mistral-small-2603': 'Mistral Small',
    'claude-sonnet-4-5': 'Claude Sonnet',
    'claude-haiku-4-5': 'Claude Haiku',
    ...PAID_MODEL_NAMES,
  };
  return n[m] ?? m.split('/').pop()?.split(':')[0] ?? 'Agent';
}

function generateName(): string {
  const model = shortModelName(form.llmModel ?? DEFAULT_FREE_AGENT_MODEL);
  const pair = form.pairs.length === 1 ? form.pairs[0] : form.pairs.length > 1 ? `${form.pairs[0]} +${form.pairs.length - 1}` : 'Base';
  const style = isPersonaCustomized.value
    ? 'Custom'
    : selectedProfileName.value || '';
  return style ? `${model} · ${pair} · ${style}` : (`${model} · ${pair}`);
}

const syncNameWithModel = ref(true);

watch([() => form.llmModel, () => [...form.pairs], isPersonaCustomized, selectedProfileName], () => {
  if (syncNameWithModel.value) form.name = generateName();
});

// When name changes: refresh persona first line (only if not customized)
watch(() => form.name, (name) => {
  if (!isPersonaCustomized.value && selectedProfileId.value && personaMd.value) {
    const newPersona = getAgentPersonaTemplate(selectedProfileId.value, name || 'Agent');
    const existingLines = personaMd.value.split('\n');
    const firstLine = newPersona.split('\n')[0] ?? '';
    if (existingLines[0] !== firstLine) {
      existingLines[0] = firstLine;
      personaMd.value = existingLines.join('\n');
    }
  }
});

onMounted(() => {
  if (props.initialValues) {
    Object.assign(form, props.initialValues);
    if (props.initialValues.llmModel) dropdownModel.value = props.initialValues.llmModel;
    const allowed = new Set<string>(AVAILABLE_PAIRS);
    form.pairs = form.pairs.filter((p) => allowed.has(p));
    if (form.pairs.length === 0) form.pairs = [AVAILABLE_PAIRS[0]];

    // Normalize legacy/invalid values so PATCH passes current API validation
    const clamp = (n: unknown, min: number, max: number, fallback: number) => {
      const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
      return Math.min(max, Math.max(min, v));
    };
    form.paperBalance = clamp(form.paperBalance, 100, 1_000_000, 10_000);
    form.maxPositionSizePct = clamp(form.maxPositionSizePct, 1, 100, 5);
    form.stopLossPct = clamp(form.stopLossPct, 0.5, 50, 5);
    form.takeProfitPct = clamp(form.takeProfitPct, 0.5, 100, 7);
    form.maxOpenPositions = clamp(form.maxOpenPositions, 1, 10, 3);
    form.temperature = clamp(form.temperature, 0, 2, 0.7);

    if (props.initialValues.behavior) behavior.value = props.initialValues.behavior as Record<string, unknown>;
    if (props.initialValues.profileId) {
      selectedProfileId.value = resolveAgentProfileId(props.initialValues.profileId);
      // Profile name will be set by BehaviorProfilePicker via profile-selected once loaded
    }
    if (props.initialValues.personaMd) {
      personaMd.value = props.initialValues.personaMd;
      isPersonaCustomized.value = true; // Treat existing persona as custom to prevent overwrite
    } else if (props.initialValues.profileId) {
      generatePersonaMd();
    }
    if (props.initialValues.behaviorMd) {
      behaviorMd.value = props.initialValues.behaviorMd;
      isBehaviorCustomized.value = true;
    }
    if ((props.initialValues as any).roleMd) {
      roleMd.value = (props.initialValues as any).roleMd;
      isRoleCustomized.value = true;
    }

    // Snapshot the payload shape we submit in edit mode,
    // so we can send only deltas (avoids resending legacy invalid fields).
    initialSubmitPayload.value = buildSubmitPayload();
  } else {
    form.name = generateName();
  }
});

function buildSubmitPayload(): CreateAgentPayload {
  return {
    ...form,
    llmModel: form.llmModel ?? DEFAULT_FREE_AGENT_MODEL,
    allowFallback: form.allowFallback ?? false,
    behavior: behavior.value,
    profileId: selectedProfileId.value ?? undefined,
    personaMd: personaMd.value || undefined,
    behaviorMd: behaviorMd.value || undefined,
    roleMd: roleMd.value || undefined,
  } as CreateAgentPayload;
}

async function handleSubmit() {
  if (!form.name.trim()) { validationError.value = 'Agent name is required'; return; }
  if (form.name.length > ENTITY_NAME_MAX_CHARS) { validationError.value = `Agent name must be at most ${ENTITY_NAME_MAX_CHARS} characters`; return; }
  if (!form.pairs.length) { validationError.value = 'Select at least one pair'; return; }
  validationError.value = '';
  submitting.value = true;
  const full = buildSubmitPayload();

  if (isEditing.value && initialSubmitPayload.value) {
    const base = initialSubmitPayload.value as unknown as Record<string, unknown>;
    const next = full as unknown as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(next)) {
      const a = base[key];
      const b = next[key];
      const same = (typeof a === 'object' || typeof b === 'object')
        ? JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
        : a === b;
      if (!same) changed[key] = b;
    }
    emit('submit', changed as Partial<CreateAgentPayload>);
  } else {
    emit('submit', full);
  }
  submitting.value = false;
}

function openBehaviorSection() {
  finetuneOpen.value = true;
  nextTick(() => {
    document.getElementById('acf-behavior-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function restoreRole() {
  roleMd.value = '';
  isRoleCustomized.value = false;
}

defineExpose({ personaMd, isPersonaCustomized, behavior, form, restorePersona, generatePersonaMd, openBehaviorSection, behaviorMd, isBehaviorCustomized, restoreBehavior, roleMd, isRoleCustomized, restoreRole });

async function handleConnectOpenRouterFromCreate() {
  openRouterRedirecting.value = true;
  try {
    await initConnect({ returnTo: route.fullPath || '/agents/create' });
  } catch {
    openRouterRedirecting.value = false;
  }
}
</script>

<template>
  <form id="agent-config-form" class="acf" @submit.prevent="handleSubmit">
    <div v-if="validationError" class="alert alert-error">{{ validationError }}</div>

    <!-- Name -->
    <div class="acf__name-row">
      <input v-model="form.name" class="acf__name-input" placeholder="Agent name…" :maxlength="ENTITY_NAME_MAX_CHARS" required />
      <div class="acf__name-count">{{ form.name.length }}/{{ ENTITY_NAME_MAX_CHARS }}</div>
      <label class="acf__sync-check">
        <input v-model="syncNameWithModel" type="checkbox" />
        <span>auto-name</span>
      </label>
    </div>

    <!-- LLM Model (top-level) -->
    <div class="form-group">
      <label class="form-label">LLM Model</label>
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
              placeholder="Search models…"
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
          placeholder="Or type any model ID…"
        />
        <a
          href="https://openrouter.ai/models"
          target="_blank"
          rel="noopener"
          class="model-browse-link"
        >Browse all models at openrouter.ai/models ↗</a>
      </template>
      <p v-else class="model-nudge">
        <button
          type="button"
          class="model-nudge__link"
          :disabled="openRouterRedirecting"
          @click="handleConnectOpenRouterFromCreate"
        >
          {{ openRouterRedirecting ? 'Redirecting…' : 'Connect your OpenRouter key' }}
        </button>
        to unlock paid models.
      </p>
    </div>

    <!-- Persona style (profile picker) -->
    <div class="acf__section">
      <div class="acf__section-label">
        Persona style
        <span v-if="isPersonaCustomized" class="acf__custom-badge">✎ Custom</span>
      </div>
      <BehaviorProfilePicker v-model="selectedProfileId" type="agent" @profile-selected="onProfileSelected" />
      <div v-if="selectedProfileDescription && !isPersonaCustomized" class="acf__profile-desc">
        {{ selectedProfileDescription }}
      </div>
    </div>

    <!-- Fine-tune Behavior accordion -->
    <div id="acf-behavior-section" class="acf__accordion">
      <button type="button" class="acf__accordion-btn" @click="finetuneOpen = !finetuneOpen">
        <span>Fine-tune Behavior</span>
        <span class="acf__chevron" :class="{ open: finetuneOpen }">›</span>
      </button>
      <div class="acf__accordion-body" :class="{ open: finetuneOpen }">
        <!-- Lock banner when persona is customized -->
        <div v-if="isPersonaCustomized" class="acf__lock-banner">
          <span>Persona MD was manually edited — behavior sync paused.</span>
          <button type="button" class="btn btn-ghost btn-sm" @click="restorePersona">
            Restore auto-persona
          </button>
        </div>
        <div :class="{ 'acf__locked-content': isPersonaCustomized }">
          <BehaviorSettingsForm v-model="behavior" type="agent" />
        </div>
      </div>
    </div>

    <!-- Persona MD accordion -->
    <div v-if="!hidePersonaEditor" class="acf__accordion">
      <button type="button" class="acf__accordion-btn" @click="personaMdOpen = !personaMdOpen">
        <span class="acf__acc-left">
          Persona MD
          <span v-if="isPersonaCustomized" class="acf__custom-badge">Custom</span>
        </span>
        <span class="acf__acc-right">
          <span class="acf__hint-chip">injected into system prompt</span>
          <span class="acf__chevron" :class="{ open: personaMdOpen }">›</span>
        </span>
      </button>
      <div class="acf__accordion-body" :class="{ open: personaMdOpen }">
        <div class="acf__persona-wrap">
          <PersonaEditor v-model="personaMd" :show-actions="false" @edited="onPersonaEdited" />
          <div v-if="isPersonaCustomized" class="acf__restore-row">
            <button type="button" class="btn btn-ghost btn-sm" @click="restorePersona">
              ↺ Restore auto-persona
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Trading Config accordion -->
    <div class="acf__accordion">
      <button type="button" class="acf__accordion-btn" @click="configOpen = !configOpen">
        <span>Trading Config</span>
        <span class="acf__chevron" :class="{ open: configOpen }">›</span>
      </button>
      <div class="acf__accordion-body" :class="{ open: configOpen }">
        <div class="acf__config">
          <div class="form-group">
            <label class="form-label">Analysis Interval</label>
            <select v-model="form.analysisInterval" class="form-select">
              <option value="1h">Every hour</option>
              <option value="4h">Every 4 hours</option>
              <option value="1d">Daily</option>
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">Trading Pairs</label>
            <div class="pair-toggles">
              <label v-for="pairLabel in AVAILABLE_PAIRS" :key="pairLabel" class="pair-toggle">
                <span class="toggle-track" :class="{ active: form.pairs.includes(pairLabel) }" @click.prevent="togglePair(pairLabel)">
                  <span class="toggle-thumb" />
                </span>
                <span class="pair-toggle-label">{{ pairLabel }}</span>
              </label>
            </div>
          </div>

          <div class="grid-2">
            <div v-if="!hideBalanceInput" class="form-group">
              <label class="form-label">Starting Balance (USDC)</label>
              <input v-model.number="form.paperBalance" type="number" class="form-input" min="100" max="1000000" step="100" />
            </div>
            <div class="form-group">
              <label class="form-label">Max Position Size (%)</label>
              <input v-model.number="form.maxPositionSizePct" type="number" class="form-input" min="1" max="100" />
            </div>
          </div>

          <div class="grid-3">
            <div class="form-group">
              <label class="form-label">Stop Loss (%)</label>
              <input v-model.number="form.stopLossPct" type="number" class="form-input" min="0.5" max="50" step="0.5" />
            </div>
            <div class="form-group">
              <label class="form-label">Take Profit (%)</label>
              <input v-model.number="form.takeProfitPct" type="number" class="form-input" min="0.5" max="100" step="0.5" />
            </div>
            <div class="form-group">
              <label class="form-label">Max Open Positions</label>
              <input v-model.number="form.maxOpenPositions" type="number" class="form-input" min="1" max="10" />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Strategy</label>
            <select v-model="(form.strategies as string[])[0]" class="form-select">
              <option value="combined">Combined (LLM weighs all indicators)</option>
              <option value="rsi_oversold">RSI Oversold/Overbought</option>
              <option value="ema_crossover">EMA 9/21 Crossover</option>
              <option value="macd_signal">MACD Signal Cross</option>
              <option value="bollinger_bounce">Bollinger Band Bounce</option>
              <option value="llm_sentiment">LLM Sentiment Analysis</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div v-if="!hideFooter" class="acf__footer">
      <button type="button" class="btn btn-ghost" @click="$emit('cancel')">Cancel</button>
      <button type="submit" class="btn btn-primary" :disabled="submitting">
        <span v-if="submitting" class="spinner" style="width:14px;height:14px;" />
        {{ isEditing ? 'Save Changes' : 'Create Agent' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.acf {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Name row */
.acf__name-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.acf__name-input {
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
.acf__name-input:focus { border-color: var(--accent, #7c6af7); }
.acf__name-count {
  font-size: 11px;
  color: var(--text-muted, #555);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.acf__sync-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted, #555);
  cursor: pointer;
  white-space: nowrap;
}

/* Section */
.acf__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.acf__section-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted, #555);
  display: flex;
  align-items: center;
  gap: 8px;
}
.acf__profile-desc {
  font-size: 12px;
  color: var(--text-secondary, #888);
  line-height: 1.5;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--accent, #7c6af7) 6%, transparent);
  border-left: 2px solid var(--accent, #7c6af7);
  border-radius: 0 6px 6px 0;
}

/* Custom badge */
.acf__custom-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--warning, #f5a623) 15%, transparent);
  color: var(--warning, #f5a623);
  border: 1px solid color-mix(in srgb, var(--warning, #f5a623) 30%, transparent);
  text-transform: none;
  letter-spacing: 0;
  font-size: 10px;
}

/* Accordion */
.acf__accordion {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 10px;
  overflow: hidden;
}
.acf__accordion-btn {
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
.acf__accordion-btn:hover {
  background: color-mix(in srgb, var(--border, #2a2a2a) 50%, transparent);
}
.acf__acc-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}
.acf__acc-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.acf__hint-chip {
  font-size: 10px;
  font-weight: 400;
  color: var(--text-muted, #444);
  background: color-mix(in srgb, var(--border, #2a2a2a) 60%, transparent);
  padding: 2px 7px;
  border-radius: 4px;
}
.acf__chevron {
  font-size: 18px;
  color: var(--text-muted, #555);
  transition: transform 0.2s;
  display: inline-block;
  transform: rotate(0deg);
}
.acf__chevron.open { transform: rotate(90deg); }

.acf__accordion-body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}
.acf__accordion-body.open {
  max-height: 2000px;
}

/* Lock state */
.acf__lock-banner {
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
.acf__locked-content {
  opacity: 0.4;
  pointer-events: none;
  user-select: none;
}

/* Persona wrap */
.acf__persona-wrap {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.acf__restore-row {
  display: flex;
  justify-content: flex-end;
}

/* Config body */

.acf__config {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 0;
}

/* Pairs */
.pair-toggles { display: flex; flex-direction: row; flex-wrap: wrap; gap: 12px 20px; }
.pair-toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
.toggle-track { flex-shrink: 0; width: 32px; height: 18px; background: var(--border-light, #333); border-radius: 9px; position: relative; transition: background 0.2s; cursor: pointer; }
.toggle-track.active { background: var(--accent, #7c6af7); }
.toggle-thumb { width: 14px; height: 14px; background: var(--text, #e0e0e0); border-radius: 50%; position: absolute; top: 2px; left: 2px; transition: transform 0.2s; }
.toggle-track.active .toggle-thumb { transform: translateX(14px); }
.pair-toggle-label { font-size: 13px; font-weight: 500; color: var(--text, #e0e0e0); font-family: 'JetBrains Mono', monospace; }

/* Footer — sticky within the scrollable left column */
.acf__footer {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 4px;
  background: var(--bg, #0a0a0a);
  border-top: 1px solid var(--border, #1e1e1e);
  margin-top: 8px;
  z-index: 2;
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
.model-nudge__link {
  padding: 0;
  margin: 0;
  border: 0;
  background: transparent;
  color: var(--accent, #7c6af7);
  font: inherit;
  cursor: pointer;
}
.model-nudge__link:hover {
  text-decoration: underline;
}
.model-nudge__link:disabled {
  opacity: 0.6;
  cursor: default;
}

/* Model picker — table dropdown */
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
</style>
