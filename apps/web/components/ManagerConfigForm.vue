<template>
  <form @submit.prevent="handleSubmit">
    <div v-if="validationError" class="alert alert-error">{{ validationError }}</div>

    <div class="form-group agent-name-row">
      <div class="agent-name-label-row">
        <label class="form-label">Manager Name</label>
        <label class="sync-name-checkbox">
          <input v-model="syncName" type="checkbox" />
          <span>Sync with setup</span>
        </label>
      </div>
      <input
        v-model="form.name"
        class="form-input"
        type="text"
        maxlength="50"
        placeholder="Alpha Manager"
        required
        @input="syncName = false"
      />
    </div>

    <div class="grid-2">
      <div class="form-group">
        <label class="form-label">LLM Model</label>
        <select v-model="form.llmModel" class="form-select">
          <optgroup label="Fast · lightweight">
            <option value="nvidia/nemotron-3-nano-30b-a3b:free">Nemotron-30B (free)</option>
            <option value="stepfun/step-3.5-flash:free">Step-3.5 Flash (free)</option>
            <option value="nvidia/nemotron-nano-9b-v2:free">Nemotron-9B (free)</option>
            <option value="arcee-ai/trinity-large-preview:free">Trinity-Large (free)</option>
          </optgroup>
          <optgroup label="Reasoning · orchestration">
            <option value="meta-llama/llama-3.3-70b-instruct:free">Llama-3.3 70B (free)</option>
            <option value="nousresearch/hermes-3-llama-3.1-405b:free">Hermes-3 405B (free)</option>
            <option value="qwen/qwen3-235b-a22b-thinking-2507:free">Qwen3-235B Thinking (free)</option>
            <option value="deepseek/deepseek-r1-0528:free">DeepSeek R1 (free)</option>
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

    <fieldset style="border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 16px;">
      <legend style="font-size: 12px; font-weight: 600; color: var(--text-muted); padding: 0 6px; text-transform: uppercase; letter-spacing: 0.05em;">Risk Parameters</legend>
      <div class="grid-3">
        <div class="form-group" style="margin-bottom: 0;">
          <label class="form-label">
            Max Drawdown
            <span style="color: var(--text-muted); font-weight: 400;">{{ (form.riskParams.maxTotalDrawdown * 100).toFixed(0) }}%</span>
          </label>
          <input
            v-model.number="form.riskParams.maxTotalDrawdown"
            class="form-range"
            type="range" min="0.01" max="1" step="0.01"
          />
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <label class="form-label">
            Max Agents
            <span style="color: var(--text-muted); font-weight: 400;">{{ form.riskParams.maxAgents }}</span>
          </label>
          <input
            v-model.number="form.riskParams.maxAgents"
            class="form-range"
            type="range" min="1" max="20" step="1"
          />
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <label class="form-label">
            Max Correlated
            <span style="color: var(--text-muted); font-weight: 400;">{{ form.riskParams.maxCorrelatedPositions }}</span>
          </label>
          <input
            v-model.number="form.riskParams.maxCorrelatedPositions"
            class="form-range"
            type="range" min="1" max="10" step="1"
          />
        </div>
      </div>
    </fieldset>

    <div class="modal-footer" style="padding: 0; margin-top: 8px;">
      <button v-if="onCancel" type="button" class="btn btn-ghost" @click="onCancel">Cancel</button>
      <button type="submit" class="btn btn-primary" :disabled="submitting">
        {{ submitting ? 'Saving…' : (isEdit ? 'Save Changes' : 'Create Manager') }}
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted } from 'vue';

const props = defineProps<{
  initial?: {
    name?: string;
    llmModel?: string;
    temperature?: number;
    decisionInterval?: string;
    riskParams?: { maxTotalDrawdown: number; maxAgents: number; maxCorrelatedPositions: number };
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
  }): void;
}>();

const MODEL_SHORT_NAMES: Record<string, string> = {
  'nvidia/nemotron-3-nano-30b-a3b:free': 'Nemotron-30B',
  'stepfun/step-3.5-flash:free': 'Step-3.5',
  'nvidia/nemotron-nano-9b-v2:free': 'Nemotron-9B',
  'arcee-ai/trinity-large-preview:free': 'Trinity-Large',
  'meta-llama/llama-3.3-70b-instruct:free': 'Llama-70B',
  'nousresearch/hermes-3-llama-3.1-405b:free': 'Hermes-405B',
  'qwen/qwen3-235b-a22b-thinking-2507:free': 'Qwen3-235B',
  'deepseek/deepseek-r1-0528:free': 'DeepSeek-R1',
};

function shortModelName(modelId: string): string {
  return MODEL_SHORT_NAMES[modelId] ?? modelId.split('/').pop()?.split(':')[0] ?? 'Manager';
}

function generateName(): string {
  return `${shortModelName(form.llmModel)} · ${form.decisionInterval}`;
}

const SYNC_NAME_KEY = 'manager:syncName';

function readSyncName(): boolean {
  if (props.isEdit) return false;
  try {
    const stored = localStorage.getItem(SYNC_NAME_KEY);
    if (stored !== null) return stored === 'true';
  } catch { /* localStorage unavailable (SSR / private mode) */ }
  return true; // default: on
}

const syncName = ref(readSyncName());

watch(syncName, (val) => {
  if (props.isEdit) return;
  try { localStorage.setItem(SYNC_NAME_KEY, String(val)); } catch { /* ignore */ }
});

const submitting = ref(false);
const validationError = ref('');

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

onMounted(() => {
  if (!props.isEdit) {
    form.name = generateName();
  }
});

watch([() => form.llmModel, () => form.decisionInterval], () => {
  if (syncName.value) {
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
    emit('submit', { ...form, riskParams: { ...form.riskParams } });
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.form-range {
  width: 100%;
  accent-color: var(--accent);
  cursor: pointer;
  margin-top: 4px;
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
