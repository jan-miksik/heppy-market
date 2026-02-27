<script setup lang="ts">
import type { CreateAgentPayload } from '~/composables/useAgents';
import type { ProfileItem } from '~/composables/useProfiles';

const props = defineProps<{
  /** Pre-populate the form when editing an existing agent */
  initialValues?: Partial<CreateAgentPayload & { pairs: string[] }>;
}>();

const emit = defineEmits<{
  submit: [payload: CreateAgentPayload];
  cancel: [];
}>();

const isEditing = computed(() => !!props.initialValues);

const form = reactive<CreateAgentPayload & { pairs: string[] }>({
  name: '',
  autonomyLevel: 'guided',
  pairs: ['WETH/USDC'],
  paperBalance: 10000,
  strategies: ['combined'],
  analysisInterval: '1h',
  maxPositionSizePct: 5,
  stopLossPct: 5,
  takeProfitPct: 7,
  maxOpenPositions: 3,
  llmModel: 'nvidia/nemotron-3-nano-30b-a3b:free',
  allowFallback: false,
  temperature: 0.7,
});

const submitting = ref(false);
const validationError = ref('');

// Tab state
const activeTab = ref<'config' | 'behavior' | 'persona'>('config');
const selectedProfileId = ref<string | null>(null);
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

function onProfileSelected(profile: ProfileItem) {
  selectedProfileId.value = profile.id;
  behavior.value = { ...profile.behaviorConfig };
}

/** Hardcoded pairs shown as toggles (in a row) */
const AVAILABLE_PAIRS = [
  'WETH/USDC',
  'cbBTC/USDC',
  'AERO/WETH',
] as const;

function togglePair(pairLabel: string) {
  if (form.pairs.includes(pairLabel)) {
    form.pairs = form.pairs.filter((p) => p !== pairLabel);
  } else {
    form.pairs = [...form.pairs, pairLabel];
  }
}

function isPairSelected(pairLabel: string) {
  return form.pairs.includes(pairLabel);
}

/** Extract a short model name from the OpenRouter model ID */
function shortModelName(modelId: string): string {
  // "nvidia/nemotron-3-nano-30b-a3b:free" → "Nemotron"
  const names: Record<string, string> = {
    'nvidia/nemotron-3-nano-30b-a3b:free': 'Nemotron-30B',
    'stepfun/step-3.5-flash:free': 'Step-3.5',
    'nvidia/nemotron-nano-9b-v2:free': 'Nemotron-9B',
    'arcee-ai/trinity-large-preview:free': 'Trinity-Large',
  };
  return names[modelId] ?? modelId.split('/').pop()?.split(':')[0] ?? 'Agent';
}

/** Generate a name from model + first pair, e.g. "Nemotron · WETH/USDC" */
function generateName(): string {
  const model = shortModelName(form.llmModel ?? 'nvidia/nemotron-3-nano-30b-a3b:free');
  const pairs = form.pairs;
  const pairLabel = pairs.length === 1 ? pairs[0] : pairs.length > 1 ? `${pairs[0]} +${pairs.length - 1}` : 'Base';
  return `${model} · ${pairLabel}`;
}

/** When true, changing model or pairs updates the agent name */
const syncNameWithModel = ref(true);

watch([() => form.llmModel, () => [...form.pairs]], () => {
  if (syncNameWithModel.value) {
    form.name = generateName();
  }
});

onMounted(() => {
  if (props.initialValues) {
    Object.assign(form, props.initialValues);
    // When editing, keep only selected pairs that are in our hardcoded list
    const allowed = new Set<string>(AVAILABLE_PAIRS);
    form.pairs = form.pairs.filter((p) => allowed.has(p));
    if (form.pairs.length === 0) {
      form.pairs = [AVAILABLE_PAIRS[0]];
    }
    if (props.initialValues.behavior) behavior.value = props.initialValues.behavior as Record<string, unknown>;
    if (props.initialValues.profileId) selectedProfileId.value = props.initialValues.profileId;
    if (props.initialValues.personaMd) personaMd.value = props.initialValues.personaMd;
  } else {
    form.name = generateName();
  }
});

async function handleSubmit() {
  if (!form.name.trim()) {
    validationError.value = 'Agent name is required';
    return;
  }
  if (!form.pairs.length) {
    validationError.value = 'Select at least one trading pair';
    return;
  }
  validationError.value = '';
  submitting.value = true;

  const payload: CreateAgentPayload = {
    ...form,
    llmModel: form.llmModel ?? 'nvidia/nemotron-3-nano-30b-a3b:free',
    allowFallback: form.allowFallback ?? false,
    behavior: behavior.value,
    profileId: selectedProfileId.value ?? undefined,
  };
  emit('submit', payload);
  submitting.value = false;
}
</script>

<template>
  <form @submit.prevent="handleSubmit">
    <div class="alert alert-error" v-if="validationError">{{ validationError }}</div>

    <!-- Tab navigation -->
    <div class="form-tabs">
      <button type="button" :class="['tab-btn', { active: activeTab === 'config' }]" @click="activeTab = 'config'">Config</button>
      <button type="button" :class="['tab-btn', { active: activeTab === 'behavior' }]" @click="activeTab = 'behavior'">Behavior</button>
      <button type="button" :class="['tab-btn', { active: activeTab === 'persona' }]" @click="activeTab = 'persona'">Persona</button>
    </div>

    <div v-show="activeTab === 'config'">
      <div class="form-group agent-name-row">
        <div class="agent-name-label-row">
          <label class="form-label">Agent Name</label>
          <label class="sync-name-checkbox">
            <input v-model="syncNameWithModel" type="checkbox" />
            <span>Sync with setup</span>
          </label>
        </div>
        <input v-model="form.name" class="form-input" placeholder="My Alpha Hunter" maxlength="50" required />
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Autonomy Level</label>
          <select v-model="form.autonomyLevel" class="form-select">
            <option value="full">Full — agent decides everything</option>
            <option value="guided">Guided — within bounds (default)</option>
            <option value="strict">Strict — rule-based only</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Analysis Interval</label>
          <select v-model="form.analysisInterval" class="form-select">
            <option value="1m">Every 1 minute</option>
            <option value="5m">Every 5 minutes</option>
            <option value="15m">Every 15 minutes</option>
            <option value="1h">Every hour (default)</option>
            <option value="4h">Every 4 hours</option>
            <option value="1d">Daily</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Trading Pairs</label>
        <div class="pair-toggles">
          <label
            v-for="pairLabel in AVAILABLE_PAIRS"
            :key="pairLabel"
            class="pair-toggle"
          >
            <span class="toggle-track" :class="{ active: isPairSelected(pairLabel) }" @click.prevent="togglePair(pairLabel)">
              <span class="toggle-thumb" />
            </span>
            <span class="pair-toggle-label">{{ pairLabel }}</span>
          </label>
        </div>
      </div>

      <div class="grid-2 llm-row">
        <div class="form-group">
          <label class="form-label">LLM Model</label>
          <select v-model="form.llmModel" class="form-select">
            <optgroup label="Free models">
              <option value="nvidia/nemotron-3-nano-30b-a3b:free">Nemotron-30B (free)</option>
              <option value="stepfun/step-3.5-flash:free">Step-3.5 (free)</option>
              <option value="nvidia/nemotron-nano-9b-v2:free">Nemotron-9B (free)</option>
              <option value="arcee-ai/trinity-large-preview:free">Trinity-Large (free)</option>
            </optgroup>
          </select>
        </div>
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Starting Balance (USDC)</label>
          <input v-model.number="form.paperBalance" type="number" class="form-input" min="100" max="1000000" step="100" />
        </div>
        <div class="form-group">
          <label class="form-label">Max Position Size (%)</label>
          <input v-model.number="form.maxPositionSizePct" type="number" class="form-input" min="1" max="100" />
          <div class="form-hint">Max % of balance per trade</div>
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

    <div v-show="activeTab === 'behavior'">
      <div style="margin-bottom: 16px;">
        <div class="form-label" style="margin-bottom: 8px; font-size: 13px; color: var(--text-secondary, #888);">Choose a Preset Profile (optional)</div>
        <BehaviorProfilePicker v-model="selectedProfileId" type="agent" @profile-selected="onProfileSelected" />
      </div>
      <div style="margin-top: 20px;">
        <div class="form-label" style="margin-bottom: 8px; font-size: 13px; color: var(--text-secondary, #888);">Fine-tune Behavior</div>
        <BehaviorSettingsForm v-model="behavior" type="agent" />
      </div>
    </div>

    <div v-show="activeTab === 'persona'">
      <PersonaEditor v-model="personaMd" />
    </div>

    <div class="modal-footer" style="padding: 0; margin-top: 8px;">
      <button type="button" class="btn btn-ghost" @click="$emit('cancel')">Cancel</button>
      <button type="submit" class="btn btn-primary" :disabled="submitting">
        <span v-if="submitting" class="spinner" style="width:14px;height:14px;"></span>
        {{ isEditing ? 'Save Changes' : 'Create Agent' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.form-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border, #2a2a2a);
  padding-bottom: 4px;
}
.tab-btn {
  background: none;
  border: none;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--text-secondary, #888);
  cursor: pointer;
  border-radius: 6px 6px 0 0;
  transition: color 0.15s, background 0.15s;
}
.tab-btn:hover {
  color: var(--text, #e0e0e0);
}
.tab-btn.active {
  color: var(--accent, #7c6af7);
  font-weight: 600;
  border-bottom: 2px solid var(--accent, #7c6af7);
}

.form-range {
  width: 100%;
  accent-color: var(--accent);
  cursor: pointer;
  margin-top: 4px;
}

.pair-toggles {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 12px 20px;
}
.pair-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}
.pair-toggle .toggle-track {
  flex-shrink: 0;
}
.toggle-track {
  width: 32px;
  height: 18px;
  background: var(--border-light);
  border-radius: 9px;
  position: relative;
  transition: background 0.2s;
}
.toggle-track.active {
  background: var(--accent);
}
.toggle-thumb {
  width: 14px;
  height: 14px;
  background: var(--text);
  border-radius: 50%;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.2s;
}
.toggle-track.active .toggle-thumb {
  transform: translateX(14px);
}
.pair-toggle-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
}
.agent-name-label-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.sync-name-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}
.sync-name-checkbox input[type="checkbox"] {
  cursor: pointer;
}
</style>
