<script setup lang="ts">
import { getAgentPersonaTemplate } from '@dex-agents/shared';
import type { CreateAgentPayload } from '~/composables/useAgents';
import type { ProfileItem } from '~/composables/useProfiles';

const props = defineProps<{
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

// ─── Behavior → Persona sync helpers ──────────────────────────────────────

function buildBehaviorSummaryMd(b: Record<string, unknown>): string {
  const RISK: Record<string, string> = { conservative: 'Conservative', moderate: 'Moderate', aggressive: 'Aggressive', degen: 'Degen' };
  const STYLE: Record<string, string> = { scalp: 'Scalp', swing: 'Swing', position: 'Position', hodl: 'HODL', any: 'Any' };
  const DEPTH: Record<string, string> = { quick: 'Quick scan', balanced: 'Balanced', deep: 'Deep analysis', obsessive: 'Obsessive' };
  const SPEED: Record<string, string> = { aggressive: 'Fast', measured: 'Measured', patient: 'Patient', sloth: 'Very patient' };
  const BIAS: Record<string, string> = { bullish: 'Bullish', bearish: 'Bearish', neutral: 'Neutral', contrarian: 'Contrarian' };
  const ENTRY: Record<string, string> = { momentum: 'Momentum', dip_buy: 'Dip buy', breakout: 'Breakout', mean_reversion: 'Mean reversion' };
  const EXIT: Record<string, string> = { fixed_targets: 'Fixed TP/SL', trailing_stop: 'Trailing stop', signal_based: 'Signal-based', time_based: 'Time-based' };

  const rows: string[] = [];
  if (b.riskAppetite) rows.push(`**Risk:** ${RISK[b.riskAppetite as string] ?? b.riskAppetite}`);
  if (b.style) rows.push(`**Style:** ${STYLE[b.style as string] ?? b.style}`);
  if (b.analysisDepth) rows.push(`**Analysis:** ${DEPTH[b.analysisDepth as string] ?? b.analysisDepth}`);
  if (b.decisionSpeed) rows.push(`**Speed:** ${SPEED[b.decisionSpeed as string] ?? b.decisionSpeed}`);
  if (b.defaultBias && b.defaultBias !== 'neutral') rows.push(`**Bias:** ${BIAS[b.defaultBias as string] ?? b.defaultBias}`);
  if (b.entryPreference) rows.push(`**Entry:** ${ENTRY[b.entryPreference as string] ?? b.entryPreference}`);
  if (b.exitStrategy) rows.push(`**Exit:** ${EXIT[b.exitStrategy as string] ?? b.exitStrategy}`);
  if (typeof b.confidenceThreshold === 'number') rows.push(`**Min confidence:** ${b.confidenceThreshold}%`);
  if (typeof b.fomoProne === 'number' && (b.fomoProne as number) > 40) rows.push(`**FOMO tendency:** ${b.fomoProne}%`);
  if (typeof b.adaptability === 'number') rows.push(`**Adaptability:** ${b.adaptability}%`);

  const flags: string[] = [];
  if (b.averageDown === true) flags.push('averages down');
  if (b.overthinker === true) flags.push('overthinks');
  if (b.emotionalAwareness === true) flags.push('emotionally aware');
  if (typeof b.contrarian === 'number' && (b.contrarian as number) > 50) flags.push('contrarian tendency');
  if (flags.length) rows.push(`**Traits:** ${flags.join(', ')}`);

  if (rows.length === 0) return '';
  return `\n\n---\n\n*Auto-generated behavior summary:*\n\n${rows.join(' · ')}`;
}

function generatePersonaMd() {
  if (!selectedProfileId.value) return;
  const base = getAgentPersonaTemplate(selectedProfileId.value, form.name || 'Agent');
  personaMd.value = base + buildBehaviorSummaryMd(behavior.value);
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

// ─── Name helpers ──────────────────────────────────────────────────────────

const AVAILABLE_PAIRS = ['WETH/USDC', 'cbBTC/USDC', 'AERO/WETH'] as const;

function togglePair(p: string) {
  form.pairs = form.pairs.includes(p) ? form.pairs.filter((x) => x !== p) : [...form.pairs, p];
}

function shortModelName(m: string): string {
  const n: Record<string, string> = {
    'nvidia/nemotron-3-nano-30b-a3b:free': 'Nemotron-30B',
    'stepfun/step-3.5-flash:free': 'Step-3.5',
    'nvidia/nemotron-nano-9b-v2:free': 'Nemotron-9B',
    'arcee-ai/trinity-large-preview:free': 'Trinity-Large',
  };
  return n[m] ?? m.split('/').pop()?.split(':')[0] ?? 'Agent';
}

function generateName(): string {
  const model = shortModelName(form.llmModel ?? 'nvidia/nemotron-3-nano-30b-a3b:free');
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
    const allowed = new Set<string>(AVAILABLE_PAIRS);
    form.pairs = form.pairs.filter((p) => allowed.has(p));
    if (form.pairs.length === 0) form.pairs = [AVAILABLE_PAIRS[0]];
    if (props.initialValues.behavior) behavior.value = props.initialValues.behavior as Record<string, unknown>;
    if (props.initialValues.profileId) {
      selectedProfileId.value = props.initialValues.profileId;
      // Profile name will be set by BehaviorProfilePicker via profile-selected once loaded
    }
    if (props.initialValues.personaMd) {
      personaMd.value = props.initialValues.personaMd;
      isPersonaCustomized.value = true; // Treat existing persona as custom to prevent overwrite
    } else if (props.initialValues.profileId) {
      generatePersonaMd();
    }
  } else {
    form.name = generateName();
  }
});

async function handleSubmit() {
  if (!form.name.trim()) { validationError.value = 'Agent name is required'; return; }
  if (!form.pairs.length) { validationError.value = 'Select at least one pair'; return; }
  validationError.value = '';
  submitting.value = true;
  emit('submit', {
    ...form,
    llmModel: form.llmModel ?? 'nvidia/nemotron-3-nano-30b-a3b:free',
    allowFallback: form.allowFallback ?? false,
    behavior: behavior.value,
    profileId: selectedProfileId.value ?? undefined,
    personaMd: personaMd.value || undefined,
  } as CreateAgentPayload);
  submitting.value = false;
}
</script>

<template>
  <form class="acf" @submit.prevent="handleSubmit">
    <div v-if="validationError" class="alert alert-error">{{ validationError }}</div>

    <!-- Name -->
    <div class="acf__name-row">
      <input v-model="form.name" class="acf__name-input" placeholder="Agent name…" maxlength="50" required />
      <label class="acf__sync-check">
        <input v-model="syncNameWithModel" type="checkbox" />
        <span>auto-name</span>
      </label>
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
    <div class="acf__accordion">
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
    <div class="acf__accordion">
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
                <option value="1h">Every hour</option>
                <option value="4h">Every 4 hours</option>
                <option value="1d">Daily</option>
              </select>
            </div>
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

          <div class="grid-2">
            <div class="form-group">
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
    <div class="acf__footer">
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

/* Footer */
.acf__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}
</style>
