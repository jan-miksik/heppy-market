<script setup lang="ts">
import { getManagerPersonaTemplate } from '@dex-agents/shared';
import type { ProfileItem } from '~/composables/useProfiles';

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
  onCancel?: () => void;
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

// ─── Form state ────────────────────────────────────────────────────────────

const form = reactive({
  name: props.initial?.name ?? '',
  llmModel: props.initial?.llmModel ?? 'nvidia/nemotron-3-nano-30b-a3b:free',
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

// Accordions — all collapsed by default
const configOpen = ref(false);
const finetuneOpen = ref(false);
const personaMdOpen = ref(false);

const syncName = ref(!props.isEdit);

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
  return `\n\n---\n\n*Auto-generated behavior summary:*\n\n${rows.join(' · ')}`;
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

const MODEL_SHORT_NAMES: Record<string, string> = {
  'nvidia/nemotron-3-nano-30b-a3b:free': 'Nemotron-30B',
  'stepfun/step-3.5-flash:free': 'Step-3.5',
  'nvidia/nemotron-nano-9b-v2:free': 'Nemotron-9B',
  'arcee-ai/trinity-large-preview:free': 'Trinity-Large',
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
  if (!props.isEdit) {
    form.name = generateName();
  }
});

function handleSubmit() {
  validationError.value = '';
  if (!form.name.trim()) {
    validationError.value = 'Manager name is required';
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
</script>

<template>
  <form class="mcf" @submit.prevent="handleSubmit">
    <div v-if="validationError" class="alert alert-error">{{ validationError }}</div>

    <!-- Name -->
    <div class="mcf__name-row">
      <input
        v-model="form.name"
        class="mcf__name-input"
        placeholder="Manager name…"
        maxlength="50"
        required
        @input="syncName = false"
      />
      <label class="mcf__sync-check">
        <input v-model="syncName" type="checkbox" />
        <span>auto-name</span>
      </label>
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

    <!-- Persona MD accordion -->
    <div class="mcf__accordion">
      <button type="button" class="mcf__accordion-btn" @click="personaMdOpen = !personaMdOpen">
        <span class="mcf__acc-left">
          Persona MD
          <span v-if="isPersonaCustomized" class="mcf__custom-badge">Custom</span>
        </span>
        <span class="mcf__acc-right">
          <span class="mcf__hint-chip">injected into system prompt</span>
          <span class="mcf__chevron" :class="{ open: personaMdOpen }">›</span>
        </span>
      </button>
      <div class="mcf__accordion-body" :class="{ open: personaMdOpen }">
        <div class="mcf__persona-wrap">
          <PersonaEditor v-model="personaMd" :show-actions="false" @edited="onPersonaEdited" />
          <div v-if="isPersonaCustomized" class="mcf__restore-row">
            <button type="button" class="btn btn-ghost btn-sm" @click="restorePersona">
              ↺ Restore auto-persona
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Manager Config accordion -->
    <div class="mcf__accordion">
      <button type="button" class="mcf__accordion-btn" @click="configOpen = !configOpen">
        <span>Manager Config</span>
        <span class="mcf__chevron" :class="{ open: configOpen }">›</span>
      </button>
      <div class="mcf__accordion-body" :class="{ open: configOpen }">
        <div class="mcf__config">
          <div class="grid-2">
            <div class="form-group">
              <label class="form-label">LLM Model</label>
              <select v-model="form.llmModel" class="form-select">
                <optgroup label="Free models">
                  <option value="nvidia/nemotron-3-nano-30b-a3b:free">Nemotron-30B (free)</option>
                  <option value="stepfun/step-3.5-flash:free">Step-3.5 Flash (free)</option>
                  <option value="nvidia/nemotron-nano-9b-v2:free">Nemotron-9B (free)</option>
                  <option value="arcee-ai/trinity-large-preview:free">Trinity-Large (free)</option>
                </optgroup>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Decision Interval</label>
              <select v-model="form.decisionInterval" class="form-select">
                <option value="1h">Every 1 hour</option>
                <option value="4h">Every 4 hours</option>
                <option value="1d">Every 24 hours</option>
              </select>
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

    <!-- Footer -->
    <div class="mcf__footer">
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
</style>
